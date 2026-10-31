import { config } from "./config";
import { getMeta, lastFetch, prune, resetVerdicts, setMeta, upsertPosts } from "./db";
import { classifyPending } from "./filter";
import { fetchHome, pausedUntil } from "./reddit";
import { retries } from "./retries";

export const status = {
  phase: "idle" as "idle" | "fetching" | "filtering",
  user: "",
  lastRunAt: 0,
  nextRunAt: 0,
  error: "",
  progress: { done: 0, total: 0, pass: 1 },
  llm: { calls: 0, cost: 0 },
  retries,
  inbox: { total: 0, messages: 0, notifications: 0 },
  version: 0, // bumped whenever the feed changes, so the UI knows to reload
};

let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
const refreshMs = () => config.feed.refreshMinutes * 60_000;

export const isRunning = () => running;
export const stopCycle = () => controller?.abort();
// Earliest time the next fetch may start: Reddit shows no quota, so manual refreshes get a floor too.
export const refreshAt = () => Math.max(pausedUntil(), status.lastRunAt + config.feed.minRefreshSeconds * 1000);

// One job at a time: fetch the home feed (optional), then filter whatever is unjudged.
export async function runCycle({ fetch = true, reset = false } = {}) {
  if (running) return;
  running = true;
  controller = new AbortController();
  const { signal } = controller;
  status.error = "";
  Object.assign(retries, { count: 0, note: "", until: 0 });
  try {
    if (reset) {
      resetVerdicts();
      status.version++;
    }
    if (fetch) {
      status.phase = "fetching";
      status.lastRunAt = Date.now(); // before the fetch, so a failed or stopped one doesn't hammer Reddit
      try {
        const { user, posts, inbox } = await fetchHome(config.feed.pages, config.feed.sort, status.inbox, signal);
        status.user = user;
        status.inbox = inbox;
        setMeta("user", user);
        upsertPosts(posts, Date.now());
        prune(config.feed.keepDays);
      } catch (e) {
        if (signal.aborted) return;
        status.error = (e as Error).message;
        console.error("fetch:", status.error);
      }
      if (signal.aborted) return;
      status.version++;
    }
    if (signal.aborted) return;
    status.phase = "filtering";
    await classifyPending(status, signal);
  } catch (e) {
    if (!signal.aborted) {
      status.error = (e as Error).message;
      console.error("cycle:", status.error);
    }
  } finally {
    status.phase = "idle";
    status.progress = { done: 0, total: 0, pass: 1 };
    running = false;
    controller = undefined;
    if (signal.aborted) rescheduleAfterStop();
    else schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  if (!config.feed.autoRefresh) {
    status.nextRunAt = 0;
    return;
  }
  status.nextRunAt = Math.max(status.lastRunAt + refreshMs(), Date.now());
  timer = setTimeout(() => runCycle(), status.nextRunAt - Date.now());
}

// A stopped run must not immediately run again just because its last fetch is old.
function rescheduleAfterStop() {
  clearTimeout(timer);
  if (!config.feed.autoRefresh) {
    status.nextRunAt = 0;
    return;
  }
  status.nextRunAt = Date.now() + refreshMs();
  timer = setTimeout(() => runCycle(), refreshMs());
}

// On start, reuse a recent fetch instead of hitting Reddit on every restart.
export function boot() {
  status.lastRunAt = lastFetch();
  status.user = getMeta("user");
  if (config.feed.autoRefresh) runCycle({ fetch: Date.now() - status.lastRunAt >= refreshMs() });
}

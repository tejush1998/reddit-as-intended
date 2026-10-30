import { config } from "./config";
import { getMeta, lastFetch, prune, resetVerdicts, setMeta, upsertPosts } from "./db";
import { classifyPending } from "./filter";
import { fetchHome } from "./reddit";

export const status = {
  phase: "idle" as "idle" | "fetching" | "filtering",
  user: "",
  lastRunAt: 0,
  nextRunAt: 0,
  error: "",
  progress: { done: 0, total: 0 },
  llm: { calls: 0, cost: 0 },
  version: 0, // bumped whenever the feed changes, so the UI knows to reload
};

let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const refreshMs = () => config.feed.refreshMinutes * 60_000;

export const isRunning = () => running;

// One job at a time: fetch the home feed (optional), then filter whatever is unjudged.
export async function runCycle({ fetch = true, reset = false } = {}) {
  if (running) return;
  running = true;
  status.error = "";
  try {
    if (reset) {
      resetVerdicts();
      status.version++;
    }
    if (fetch) {
      status.phase = "fetching";
      try {
        const { user, posts } = await fetchHome(config.feed.pages, config.feed.sort);
        status.user = user;
        setMeta("user", user);
        upsertPosts(posts, Date.now());
        prune(config.feed.keepDays);
      } catch (e) {
        status.error = (e as Error).message;
        console.error("fetch:", status.error);
      }
      status.lastRunAt = Date.now(); // also after a failure, so a broken login doesn't hammer Reddit
      status.version++;
    }
    status.phase = "filtering";
    await classifyPending(status);
  } catch (e) {
    status.error = (e as Error).message;
    console.error("cycle:", status.error);
  } finally {
    status.phase = "idle";
    status.progress = { done: 0, total: 0 };
    running = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  status.nextRunAt = Math.max(status.lastRunAt + refreshMs(), Date.now());
  timer = setTimeout(() => runCycle(), status.nextRunAt - Date.now());
}

// On start, reuse a recent fetch instead of hitting Reddit on every restart.
export function boot() {
  status.lastRunAt = lastFetch();
  status.user = getMeta("user");
  runCycle({ fetch: Date.now() - status.lastRunAt >= refreshMs() });
}

import { join } from "node:path";
import { boot, isRunning, markNotificationsSeen, refreshAt, refreshInbox, runCycle, status, stopCycle } from "./agent";
import { HOST, PORT, ROOT, config } from "./config";
import { counts, feed, hiddenByCategory } from "./db";
import { llmSettings } from "./llm";
import { redditConfigured } from "./reddit";

const startedAt = Date.now();
const file = (name: string) => () => new Response(Bun.file(join(ROOT, "public", name)));

// POSTs must carry this header: a plain cross-site form can't set it, so other pages can't trigger runs.
function start(req: Request, opts: { fetch: boolean; reset: boolean }) {
  if (req.headers.get("x-as-intended") !== "1") return new Response("missing x-as-intended header", { status: 403 });
  if (isRunning()) return Response.json({ error: "a run is already in progress" }, { status: 409 });
  if (opts.fetch && Date.now() < refreshAt()) return Response.json({ error: "too soon to refresh" }, { status: 429 });
  runCycle(opts);
  return Response.json({ started: true }, { status: 202 });
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  routes: {
    "/": file("index.html"),
    "/app.js": file("app.js"),
    "/style.css": file("style.css"),
    "/api/status": () => {
      const { baseURL, model } = llmSettings();
      return Response.json({
        ...status,
        version: `${startedAt}-${status.version}`,
        configured: redditConfigured(),
        counts: counts(config.filter.maxAttempts),
        hiddenByCategory: hiddenByCategory(),
        model: `${new URL(baseURL).host} · ${model}`,
        refreshMinutes: config.feed.refreshMinutes,
        refreshAt: refreshAt(),
      });
    },
    "/api/feed": (req) => {
      const view = new URL(req.url).searchParams.get("view") === "hidden" ? "hidden" : "clean";
      return Response.json({ view, posts: feed(view === "clean") });
    },
    "/api/refresh": { POST: (req) => start(req, { fetch: true, reset: false }) },
    "/api/reclassify": { POST: (req) => start(req, { fetch: false, reset: true }) },
    "/api/inbox": {
      POST: async (req) => {
        if (req.headers.get("x-as-intended") !== "1") return new Response("missing x-as-intended header", { status: 403 });
        await refreshInbox();
        return Response.json({ ok: true });
      },
    },
    "/api/inbox/seen": {
      POST: (req) => {
        if (req.headers.get("x-as-intended") !== "1") return new Response("missing x-as-intended header", { status: 403 });
        markNotificationsSeen();
        return Response.json({ ok: true });
      },
    },
    "/api/stop": {
      POST: (req) => {
        if (req.headers.get("x-as-intended") !== "1") return new Response("missing x-as-intended header", { status: 403 });
        if (!isRunning()) return Response.json({ error: "no run in progress" }, { status: 409 });
        stopCycle();
        return Response.json({ stopping: true }, { status: 202 });
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

console.log(`reddit-as-intended on http://${HOST}:${PORT}`);
boot();

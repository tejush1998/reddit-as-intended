import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, config } from "./config";
import { failAttempt, pending, saveVerdict } from "./db";
import { chat, llmSettings } from "./llm";
import type { Post } from "./reddit";
import { noteRetry } from "./retries";

const CATEGORIES = new Set(["violence", "tragedy", "distress", "self_harm", "abuse", "outrage", "disturbing"]);

export type Progress = {
  progress: { done: number; total: number; pass: number };
  llm: { calls: number; cost: number };
  error: string;
  version: number;
};

// Sends unjudged posts to the model in chunks until every post has a verdict
// or has used up its attempts. Posts without a verdict stay out of the feed.
export async function classifyPending(s: Progress, signal?: AbortSignal) {
  const { chunkSize, concurrency, maxAttempts, promptFile } = config.filter;
  const prompt = readFileSync(join(ROOT, promptFile), "utf8"); // re-read so prompt edits apply on the next run
  for (let todo = pending(maxAttempts), pass = 1; todo.length && !signal?.aborted; todo = pending(maxAttempts), pass++) {
    if (pass > 1) {
      noteRetry(`Retrying ${todo.length} posts`);
      if (s.error.startsWith("Filter model")) s.error = ""; // comes back if this pass fails too
    }
    s.progress = { done: 0, total: todo.length, pass };
    const chunks: Post[][] = [];
    for (let i = 0; i < todo.length; i += chunkSize) chunks.push(todo.slice(i, i + chunkSize));
    let next = 0;
    const worker = async () => {
      while (next < chunks.length && !signal?.aborted) {
        const chunk = chunks[next++];
        await classifyChunk(chunk, prompt, s, signal);
        s.progress.done += chunk.length;
        s.version++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  }
}

async function classifyChunk(posts: Post[], prompt: string, s: Progress, signal?: AbortSignal) {
  // Short ids keep the model from mangling Reddit fullnames.
  const input = posts.map((p, i) => ({
    id: `p${i + 1}`,
    subreddit: p.sub,
    type: p.kind,
    title: p.title,
    flair: p.flair?.text || undefined,
    text: p.text.slice(0, 1500) || undefined,
    link: p.kind === "link" ? p.domain : undefined,
    nsfw: p.nsfw || undefined,
  }));
  let decisions: Map<string, any>;
  try {
    const { content, cost } = await chat([
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(input) },
    ], signal);
    s.llm.calls++;
    s.llm.cost += cost;
    decisions = parseDecisions(content);
  } catch (e) {
    if (signal?.aborted) throw e;
    const message = `Filter model: ${(e as Error).message}`;
    s.error ||= message; // a fetch error from earlier in the run matters more
    console.error(message);
    posts.forEach((p) => failAttempt(p.id));
    return;
  }
  const { model } = llmSettings();
  posts.forEach((p, i) => {
    const d = decisions.get(`p${i + 1}`);
    const keep = d?.keep === true || d?.keep === "true" ? true : d?.keep === false || d?.keep === "false" ? false : null;
    if (keep === null) return failAttempt(p.id);
    const category = keep ? "ok" : CATEGORIES.has(d.category) ? d.category : "other";
    saveVerdict(p.id, keep, category, String(d.reason ?? "").slice(0, 120), model);
  });
}

function parseDecisions(text: string): Map<string, any> {
  const body = text.replace(/^\s*```(?:json)?|```\s*$/g, "").trim();
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("reply had no JSON");
    json = JSON.parse(body.slice(start, end + 1));
  }
  const list = Array.isArray(json) ? json : json.decisions;
  if (!Array.isArray(list)) throw new Error("reply JSON had no decisions array");
  return new Map(list.map((d: any) => [String(d.id), d]));
}

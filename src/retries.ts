// What the current run has retried, for the page and the logs. A module of its own
// because reddit.ts and llm.ts can't import agent.ts, which imports them.
export const retries = { count: 0, note: "", until: 0 };

export function noteRetry(note: string, waitMs = 0) {
  retries.count++;
  retries.note = note;
  retries.until = Date.now() + waitMs;
  console.error(`retry: ${note}${waitMs ? `, waiting ${Math.round(waitMs / 1000)}s` : ""}`);
}

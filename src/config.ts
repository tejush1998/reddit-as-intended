import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
export const HOST = process.env.HOST ?? "127.0.0.1";
export const PORT = Number(process.env.PORT ?? 8787);

export type Config = {
  llm: { provider: string; baseURL: string; model: string; authFile: string };
  feed: { sort: string; pages: number; refreshMinutes: number; keepDays: number };
  filter: { chunkSize: number; concurrency: number; maxAttempts: number; promptFile: string };
};

export const config: Config = JSON.parse(readFileSync(process.env.CONFIG_FILE ?? join(ROOT, "config.json"), "utf8"));

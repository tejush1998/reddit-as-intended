import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

type Message = { role: "system" | "user"; content: string };

export function llmSettings() {
  return {
    provider: process.env.LLM_PROVIDER ?? config.llm.provider,
    baseURL: (process.env.LLM_BASE_URL ?? config.llm.baseURL).replace(/\/+$/, ""),
    model: process.env.LLM_MODEL ?? config.llm.model,
  };
}

// LLM_API_KEY wins; otherwise the key is read from an opencode auth.json
// ({ "<provider>": { "type": "api", "key": "..." } }) when one is mounted.
function apiKey(provider: string) {
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  const paths = [process.env.OPENCODE_AUTH, config.llm.authFile, join(homedir(), ".local/share/opencode/auth.json")];
  const path = paths.find((p) => p && existsSync(p));
  if (!path) throw new Error("no LLM key: set LLM_API_KEY in .env");
  const key = JSON.parse(readFileSync(path, "utf8"))[provider]?.key;
  if (!key) throw new Error(`no "${provider}" key in ${path}`);
  return key;
}

export async function chat(messages: Message[]): Promise<{ content: string; cost: number }> {
  const { provider, baseURL, model } = llmSettings();
  const key = apiKey(provider);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      // Cloudflare in front of some gateways (astorias) rejects default runtime user agents with error 1010.
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "reddit-as-intended/0.1" },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 4000 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const j: any = await res.json();
      const content = j.choices?.[0]?.message?.content;
      if (!content) throw new Error(`empty reply (finish_reason: ${j.choices?.[0]?.finish_reason})`);
      return { content, cost: Number(j.usage?.cost) || 0 };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await Bun.sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

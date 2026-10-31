import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { getMeta, setMeta } from "./db";
import { noteRetry } from "./retries";

export type Post = {
  id: string; // fullname, t3_xxx
  sub: string;
  subIcon: string | null;
  subColor: string | null;
  author: string;
  title: string;
  text: string;
  flair: { text: string; bg: string | null; light: boolean } | null;
  created: number; // unix seconds
  score: number;
  comments: number;
  permalink: string;
  url: string;
  domain: string;
  nsfw: boolean;
  spoiler: boolean;
  kind: "text" | "image" | "gallery" | "video" | "link";
  media: { src: string; w: number; h: number } | null;
  galleryCount: number;
  videoSeconds: number;
};

// Reddit asks clients for a descriptive UA that names the app and its owner; it is sent in every mode.
const UA = () => `script:reddit-as-intended:0.1 (by /u/${process.env.REDDIT_USERNAME || getMeta("user") || "unknown"})`;

// json: the www host serves listings at "<path>.json"; oauth.reddit.com takes the bare path.
type Session = { base: string; json: boolean; headers: Record<string, string> };
type Me = { name: string; inbox_count?: number };

export type Inbox = { total: number; messages: number; notifications: number };

export const redditConfigured = () =>
  Boolean(process.env.REDDIT_FIXTURE || process.env.REDDIT_COOKIE || process.env.REDDIT_CLIENT_ID);

// A cookie session gets no x-ratelimit headers, so a 429 is the first warning, and requests sent
// during a block can extend it. Stop at the first one and stay stopped, across restarts too.
const PAUSE_MS = 5 * 60_000;
const MAX_PAUSE_MS = 60 * 60_000;

export const pausedUntil = () => Number(getMeta("pausedUntil"));

const pausedError = () =>
  new Error(`Reddit is rate limiting this login, so refreshing is paused for ${Math.ceil((pausedUntil() - Date.now()) / 60_000)} min`);

function pause(why: string, retryAfterMs: number) {
  const strikes = Number(getMeta("strikes"));
  const until = Date.now() + Math.max(retryAfterMs, Math.min(PAUSE_MS * 2 ** strikes, MAX_PAUSE_MS));
  setMeta("strikes", String(strikes + 1));
  setMeta("pausedUntil", String(until));
  console.error(`reddit: ${why}, pausing until ${new Date(until).toISOString()}`);
  return pausedError();
}

export async function fetchHome(pages: number, sort: string, known: Inbox, signal?: AbortSignal): Promise<{ user: string; posts: Post[]; inbox: Inbox }> {
  const env = process.env;
  if (env.REDDIT_FIXTURE) {
    const listing = JSON.parse(readFileSync(env.REDDIT_FIXTURE, "utf8"));
    return { user: "fixture", posts: listing.data.children.map((c: any) => normalize(c.data)), inbox: known };
  }

  const { s, me } = await openSession(signal);

  const seen = new Set<string>();
  const posts: Post[] = [];
  let after = "";
  for (let page = 0; page < pages; page++) {
    const q = new URLSearchParams({ limit: "100", sr_detail: "1", raw_json: "1" });
    if (after) q.set("after", after);
    const listing = await getJSON(s, `/${sort}${s.json ? ".json" : ""}?${q}`, signal);
    for (const c of listing.data?.children ?? []) {
      if (c.kind !== "t3" || seen.has(c.data.name)) continue;
      seen.add(c.data.name);
      posts.push(normalize(c.data));
    }
    after = listing.data?.after;
    if (!after) break;
    await sleep(1500, undefined, { signal });
  }
  // The UI shows only the latest run, so an empty answer must not replace the feed.
  if (!posts.length) throw new Error("Reddit returned an empty feed");
  setMeta("strikes", "0");
  return { user: me.name, posts, inbox: await readInbox(s, me.inbox_count ?? 0, known, signal) };
}

// /api/me already carries the unread total, so the split costs a request only when the total changes.
// Best-effort: a failure leaves the badges as they were. Chat is not exposed through the session cookie.
async function readInbox(s: Session, total: number, known: Inbox, signal?: AbortSignal): Promise<Inbox> {
  if (total === known.total) return known;
  if (!total) return { total: 0, messages: 0, notifications: 0 };
  const list = await getJSON(s, `/message/unread${s.json ? ".json" : ""}?limit=100&mark=false&raw_json=1`, signal).catch(() => null);
  if (!list) return known;
  const messages = (list.data?.children ?? []).filter((c: any) => c.kind === "t4").length;
  return { total, messages, notifications: total - messages };
}

async function openSession(signal?: AbortSignal): Promise<{ s: Session; me: Me }> {
  const env = process.env;
  let s: Session;
  let me: Me;
  if (env.REDDIT_CLIENT_ID) {
    s = await oauthSession(signal);
    me = await whoami(s, signal);
  } else if (env.REDDIT_COOKIE) {
    const raw = env.REDDIT_COOKIE.trim();
    const cookie = raw.includes("=") ? raw : `reddit_session=${raw}`;
    s = { base: "https://www.reddit.com", json: true, headers: { Cookie: cookie, "User-Agent": UA(), Accept: "application/json" } };
    const viaCookie = await whoami(s, signal).catch((e: Error) => e);
    if (!(viaCookie instanceof Error) && viaCookie.name) {
      me = viaCookie;
    } else {
      // token_v2 is the bearer token the web app itself uses against the OAuth host.
      const token = cookie.match(/(?:^|;\s*)token_v2=([^;]+)/)?.[1];
      if (!token) throw viaCookie instanceof Error ? viaCookie : loggedOut();
      s = { base: "https://oauth.reddit.com", json: false, headers: { Authorization: `Bearer ${token}`, "User-Agent": UA() } };
      me = await whoami(s, signal);
    }
  } else {
    throw new Error("No Reddit login configured: set REDDIT_COOKIE (or the REDDIT_CLIENT_* script-app variables) in .env");
  }
  if (!me.name) throw loggedOut();
  return { s, me };
}

const loggedOut = () => new Error("Reddit says this session is logged out: copy a fresh reddit_session cookie into .env");

async function whoami(s: Session, signal?: AbortSignal): Promise<Me> {
  const me = await getJSON(s, s.json ? "/api/me.json" : "/api/v1/me", signal);
  return me.data ?? me;
}

let oauth: { token: string; until: number } | undefined;

async function oauthSession(signal?: AbortSignal): Promise<Session> {
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret = "", REDDIT_USERNAME: username = "", REDDIT_PASSWORD: password = "" } = process.env;
  if (!oauth || oauth.until < Date.now() + 60_000) {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "User-Agent": UA() },
      body: new URLSearchParams({ grant_type: "password", username, password }),
      signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j.access_token) throw new Error(`Reddit OAuth login failed (${res.status}): ${j.error ?? j.message ?? "no token"}`);
    oauth = { token: j.access_token, until: Date.now() + j.expires_in * 1000 };
  }
  return { base: "https://oauth.reddit.com", json: false, headers: { Authorization: `bearer ${oauth.token}`, "User-Agent": UA() } };
}

async function getJSON(s: Session, path: string, signal?: AbortSignal): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    if (Date.now() < pausedUntil()) throw pausedError();
    const res = await fetch(s.base + path, { headers: s.headers, signal });
    const where = `${new URL(s.base).host}${path.split("?")[0]}`;
    const type = res.headers.get("content-type") ?? "";
    const retryAfter = (Number(res.headers.get("retry-after")) || 0) * 1000;
    if (res.status === 429 || (res.status === 403 && !type.includes("json"))) throw pause(`${res.status} on ${where}`, retryAfter);
    if (res.status >= 500 && attempt < 3) {
      const wait = retryAfter || 5000 * 2 ** attempt;
      noteRetry(`Reddit ${res.status} (try ${attempt + 2} of 4)`, wait);
      await sleep(wait, undefined, { signal });
      continue;
    }
    if (!type.includes("json")) {
      throw new Error(`Reddit answered ${res.status} with ${type.split(";")[0] || "no content type"} instead of JSON on ${where} (blocked, or the login expired)`);
    }
    if (!res.ok) throw new Error(`Reddit ${res.status} on ${where}`);
    // OAuth sessions report their quota: when it is nearly spent, wait out the window instead of getting 429s.
    if (Number(res.headers.get("x-ratelimit-remaining") ?? 100) < 5) {
      const wait = Number(res.headers.get("x-ratelimit-reset") ?? 60) * 1000;
      noteRetry("Reddit quota low, resuming", wait);
      await sleep(wait, undefined, { signal });
    }
    return res.json();
  }
}

function normalize(d: any): Post {
  const sr = d.sr_detail ?? {};
  let kind: Post["kind"] = d.is_self ? "text" : "link";
  let media = d.is_self ? null : preview(d);
  let galleryCount = 0;
  if (d.is_gallery && d.gallery_data?.items?.length) {
    kind = "gallery";
    galleryCount = d.gallery_data.items.length;
    media = galleryImage(d.media_metadata?.[d.gallery_data.items[0].media_id]);
  } else if (d.is_video || String(d.post_hint).endsWith(":video")) {
    kind = "video";
  } else if (d.post_hint === "image") {
    kind = "image";
  }
  return {
    id: d.name,
    sub: d.subreddit,
    subIcon: https(sr.community_icon) ?? https(sr.icon_img),
    subColor: sr.primary_color || sr.key_color || null,
    author: d.author,
    title: d.title,
    text: plain(d.selftext ?? ""),
    flair: d.link_flair_text
      ? { text: d.link_flair_text, bg: d.link_flair_background_color || null, light: d.link_flair_text_color === "light" }
      : null,
    created: d.created_utc,
    score: d.score,
    comments: d.num_comments,
    permalink: String(d.permalink).startsWith("/") ? d.permalink : `/comments/${d.id}/`,
    url: /^https?:\/\//.test(d.url_overridden_by_dest ?? d.url ?? "") ? (d.url_overridden_by_dest ?? d.url) : "",
    domain: d.domain ?? "",
    nsfw: Boolean(d.over_18),
    spoiler: Boolean(d.spoiler),
    kind,
    media,
    galleryCount,
    videoSeconds: d.media?.reddit_video?.duration ?? 0,
  };
}

const https = (u: unknown) => (typeof u === "string" && u.startsWith("https://") ? u : null);

function preview(d: any) {
  const img = d.preview?.images?.[0];
  const pick = img?.resolutions?.find((r: any) => r.width >= 640) ?? img?.source;
  const src = https(pick?.url);
  return src ? { src, w: pick.width, h: pick.height } : null;
}

function galleryImage(m: any) {
  const pick = m?.p?.find((r: any) => r.x >= 640) ?? m?.s;
  const src = https(pick?.u);
  return src ? { src, w: pick.x, h: pick.y } : null;
}

// Selftext is markdown; the feed shows a short plain-text preview.
function plain(md: string) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/>!.*?!</g, "[spoiler]")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|~~|`|&#x200B;/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3000);
}

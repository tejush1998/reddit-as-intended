import { readFileSync } from "node:fs";

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
const UA = `script:reddit-as-intended:0.1 (by /u/${process.env.REDDIT_USERNAME || "unknown"})`;

// json: the www host serves listings at "<path>.json"; oauth.reddit.com takes the bare path.
type Session = { base: string; json: boolean; headers: Record<string, string> };

export const redditConfigured = () =>
  Boolean(process.env.REDDIT_FIXTURE || process.env.REDDIT_COOKIE || process.env.REDDIT_CLIENT_ID);

export async function fetchHome(pages: number, sort: string): Promise<{ user: string; posts: Post[] }> {
  const env = process.env;
  if (env.REDDIT_FIXTURE) {
    const listing = JSON.parse(readFileSync(env.REDDIT_FIXTURE, "utf8"));
    return { user: "fixture", posts: listing.data.children.map((c: any) => normalize(c.data)) };
  }

  let s: Session;
  let user: string;
  if (env.REDDIT_CLIENT_ID) {
    s = await oauthSession();
    user = await whoami(s);
  } else if (env.REDDIT_COOKIE) {
    const raw = env.REDDIT_COOKIE.trim();
    const cookie = raw.includes("=") ? raw : `reddit_session=${raw}`;
    s = { base: "https://www.reddit.com", json: true, headers: { Cookie: cookie, "User-Agent": UA, Accept: "application/json" } };
    const viaCookie = await whoami(s).catch((e: Error) => e);
    if (typeof viaCookie === "string" && viaCookie) {
      user = viaCookie;
    } else {
      // token_v2 is the bearer token the web app itself uses against the OAuth host.
      const token = cookie.match(/(?:^|;\s*)token_v2=([^;]+)/)?.[1];
      if (!token) throw viaCookie instanceof Error ? viaCookie : loggedOut();
      s = { base: "https://oauth.reddit.com", json: false, headers: { Authorization: `Bearer ${token}`, "User-Agent": UA } };
      user = await whoami(s);
    }
  } else {
    throw new Error("No Reddit login configured: set REDDIT_COOKIE (or the REDDIT_CLIENT_* script-app variables) in .env");
  }
  if (!user) throw loggedOut();

  const seen = new Set<string>();
  const posts: Post[] = [];
  let after = "";
  for (let page = 0; page < pages; page++) {
    const q = new URLSearchParams({ limit: "100", sr_detail: "1", raw_json: "1" });
    if (after) q.set("after", after);
    const listing = await getJSON(s, `/${sort}${s.json ? ".json" : ""}?${q}`);
    for (const c of listing.data?.children ?? []) {
      if (c.kind !== "t3" || seen.has(c.data.name)) continue;
      seen.add(c.data.name);
      posts.push(normalize(c.data));
    }
    after = listing.data?.after;
    if (!after) break;
    await Bun.sleep(1500);
  }
  return { user, posts };
}

const loggedOut = () => new Error("Reddit says this session is logged out: copy a fresh reddit_session cookie into .env");

async function whoami(s: Session): Promise<string> {
  const me = await getJSON(s, s.json ? "/api/me.json" : "/api/v1/me");
  return me.data?.name ?? me.name ?? "";
}

let oauth: { token: string; until: number } | undefined;

async function oauthSession(): Promise<Session> {
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret = "", REDDIT_USERNAME: username = "", REDDIT_PASSWORD: password = "" } = process.env;
  if (!oauth || oauth.until < Date.now() + 60_000) {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "User-Agent": UA },
      body: new URLSearchParams({ grant_type: "password", username, password }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j.access_token) throw new Error(`Reddit OAuth login failed (${res.status}): ${j.error ?? j.message ?? "no token"}`);
    oauth = { token: j.access_token, until: Date.now() + j.expires_in * 1000 };
  }
  return { base: "https://oauth.reddit.com", json: false, headers: { Authorization: `bearer ${oauth.token}`, "User-Agent": UA } };
}

async function getJSON(s: Session, path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(s.base + path, { headers: s.headers });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await Bun.sleep((Number(res.headers.get("retry-after")) || 5 * 2 ** attempt) * 1000);
      continue;
    }
    const where = `${new URL(s.base).host}${path.split("?")[0]}`;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      throw new Error(`Reddit answered ${res.status} with ${type.split(";")[0] || "no content type"} instead of JSON on ${where} (blocked, or the login expired)`);
    }
    if (!res.ok) throw new Error(`Reddit ${res.status} on ${where}`);
    // When the quota is nearly spent, wait out the window instead of getting 429s.
    if (Number(res.headers.get("x-ratelimit-remaining") ?? 100) < 5) {
      await Bun.sleep(Number(res.headers.get("x-ratelimit-reset") ?? 60) * 1000);
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

const $ = (sel) => document.querySelector(sel);

const state = {
  view: location.hash === "#hidden" ? "hidden" : "clean",
  sort: load("sort") ?? "feed",
  q: "",
  posts: [],
  status: null,
  version: "",
};

// Post content is untrusted: every string goes in through text nodes or attributes, never innerHTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== "") el.append(kid);
  return el;
}

const ICONS = {
  up: '<path d="M12 4.5 5 12h4.5v7.5h5V12H19z"/>',
  down: '<path d="M12 19.5 19 12h-4.5V4.5h-5V12H5z"/>',
  comment: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  hidden: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.5-2.7 3.9M6.5 6.6C4.4 8 2.9 10.1 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.6 4.8-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};

function icon(name, size = 20) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
  s.innerHTML = ICONS[name]; // static markup from the table above
  return s;
}

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const LABELS = {
  violence: "Violence", tragedy: "Tragedy", distress: "Venting / distress", self_harm: "Self-harm",
  abuse: "Abuse", outrage: "Outrage", disturbing: "Disturbing", other: "Other",
};

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${+(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${+(n / 1e6).toFixed(1)}M`;
}

function ago(sec) {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min. ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr. ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)} day${s < 172800 ? "" : "s"} ago`;
  if (s < 31536000) return `${Math.floor(s / 2592000)} mo. ago`;
  return `${Math.floor(s / 31536000)} yr. ago`;
}

function until(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  return m <= 0 ? "now" : `in ${m} min`;
}

function duration(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

const isColor = (c) => typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c);
const SUB_COLORS = ["#0079d3", "#46a508", "#ff585b", "#7193ff", "#ffb000", "#0dd3bb", "#ea0027", "#94e044", "#ff66ac", "#cc5289"];
function subColor(p) {
  if (isColor(p.subColor)) return p.subColor;
  let hash = 0;
  for (const ch of p.sub) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return SUB_COLORS[Math.abs(hash) % SUB_COLORS.length];
}

function subIcon(p) {
  if (p.subIcon) return h("img", { class: "sub-icon", src: p.subIcon, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  const el = h("span", { class: "sub-icon" }, "r/");
  el.style.background = subColor(p);
  return el;
}

function flair(f) {
  const el = h("span", { class: "flair" }, f.text);
  if (isColor(f.bg)) {
    el.style.background = f.bg;
    el.style.color = f.light ? "#fff" : "#000";
  }
  return el;
}

function media(p) {
  const m = p.media;
  const veiled = p.nsfw || p.spoiler;
  return h("div", { class: `media${veiled ? " veiled" : ""}` },
    h("img", { class: "bg", src: m.src, alt: "", loading: "lazy", referrerpolicy: "no-referrer", "aria-hidden": "true" }),
    h("img", { class: "fg", src: m.src, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", width: m.w, height: m.h }),
    p.kind === "video" && h("span", { class: "play" }, icon("play", 28)),
    p.kind === "video" && p.videoSeconds > 0 && h("span", { class: "chip br" }, duration(p.videoSeconds)),
    p.kind === "gallery" && p.galleryCount > 1 && h("span", { class: "chip tr" }, `1 / ${p.galleryCount}`),
    veiled && h("span", { class: "veil" }, p.nsfw ? "NSFW" : "Spoiler"),
  );
}

function postCard(p) {
  const href = `https://www.reddit.com${p.permalink}`;
  const hidden = state.view === "hidden";
  const title = h("h2", { class: "post-title" }, h("a", { href, target: "_blank", rel: "noopener" }, p.title));
  const domain = p.kind === "link" && p.domain &&
    h("a", { class: "domain", href: p.url || href, target: "_blank", rel: "noopener" }, p.domain, icon("external", 12));
  const thumb = p.kind === "link" && p.media && !hidden &&
    h("img", { class: "thumb", src: p.media.src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  const created = new Date(p.created * 1000);

  return h("article", { class: "post" },
    h("div", { class: "post-meta" },
      h("a", { class: "sub", href: `https://www.reddit.com/r/${encodeURIComponent(p.sub)}/`, target: "_blank", rel: "noopener" }, subIcon(p), `r/${p.sub}`),
      h("span", { class: "sep", "aria-hidden": "true" }),
      h("time", { datetime: created.toISOString(), title: created.toLocaleString(), "data-t": p.created }, ago(p.created)),
      p.nsfw && h("span", { class: "badge nsfw" }, "NSFW"),
      p.spoiler && h("span", { class: "badge" }, "SPOILER"),
    ),
    // The filtered-out view shows why a post was hidden, but not its text or media.
    hidden && h("div", { class: "reason" }, icon("hidden", 14), `${LABELS[p.category] ?? p.category}${p.reason ? ` · ${p.reason}` : ""}`),
    thumb ? h("div", { class: "link-row" }, h("div", {}, title, domain), thumb) : [title, domain],
    p.flair && flair(p.flair),
    !hidden && p.text && h("p", { class: "post-text" }, p.text),
    !hidden && p.media && p.kind !== "link" && media(p),
    h("div", { class: "actions" },
      h("span", { class: "pill vote", title: `${p.score} points` }, icon("up", 16), compact(p.score), icon("down", 16)),
      h("span", { class: "pill", title: `${p.comments} comments` }, icon("comment", 16), compact(p.comments)),
    ),
  );
}

// Cards are cached so polling re-renders don't reload images; scores in the key pick up refreshed counts.
const cards = new Map();
function card(p) {
  const key = `${state.view}:${p.id}:${p.score}:${p.comments}`;
  if (!cards.has(key)) cards.set(key, postCard(p));
  return cards.get(key);
}

function visiblePosts() {
  const q = state.q.trim().toLowerCase();
  let posts = q
    ? state.posts.filter((p) => `${p.title} ${p.sub} ${p.text} ${p.flair?.text ?? ""}`.toLowerCase().includes(q))
    : state.posts;
  if (state.sort === "new") posts = [...posts].sort((a, b) => b.created - a.created);
  return posts;
}

function tabs() {
  const tab = (view, label) =>
    h("a", { class: "tab", href: `#${view}`, "aria-current": String(state.view === view) }, label);
  const n = state.status?.counts ?? {};
  return h("div", { class: "tabs" },
    tab("clean", `Home${n.kept ? ` · ${n.kept}` : ""}`),
    tab("hidden", `Filtered out${n.hidden ? ` · ${n.hidden}` : ""}`),
  );
}

function setupCard() {
  return h("section", { class: "setup" },
    h("h2", {}, "Connect your Reddit account"),
    h("p", {}, "The filter is ready; it just needs your Reddit login to read your home feed."),
    h("ol", {},
      h("li", {}, "Open reddit.com in your browser while logged in."),
      h("li", {}, "DevTools → Application (Storage in Firefox) → Cookies → https://www.reddit.com"),
      h("li", {}, "Copy the value of ", h("code", {}, "reddit_session"), " into ", h("code", {}, ".env"), " as ", h("code", {}, "REDDIT_COOKIE=…")),
      h("li", {}, "Restart: ", h("code", {}, "docker compose up -d --force-recreate")),
    ),
  );
}

function emptyState() {
  const s = state.status;
  const busy = s && (s.phase !== "idle" || s.counts.pending > 0);
  if (state.q) return h("div", { class: "empty" }, h("strong", {}, `Nothing matches “${state.q}”`), "Try a different search.");
  if (state.view === "hidden") return h("div", { class: "empty" }, h("strong", {}, "Nothing filtered out"), "Posts the model hides will be listed here with the reason.");
  if (busy) {
    return [
      h("div", { class: "empty" }, h("strong", {}, s.phase === "fetching" ? "Fetching your home feed…" : "Filtering your feed…"), "Clean posts appear here as each batch is judged."),
      h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }),
    ];
  }
  return h("div", { class: "empty" }, h("strong", {}, "No posts yet"), "Hit Refresh to pull your home feed.");
}

function render() {
  for (const el of document.querySelectorAll("[data-view]")) el.setAttribute("aria-current", String(el.dataset.view === state.view));
  for (const el of document.querySelectorAll("[data-sort]")) el.setAttribute("aria-current", String(el.dataset.sort === state.sort));

  const s = state.status;
  const nodes = [tabs()];
  if (s?.error && s.configured) nodes.push(h("div", { class: "banner", role: "status" }, s.error));
  if (s && !s.configured) nodes.push(setupCard());
  else {
    const posts = visiblePosts();
    if (!posts.length) nodes.push(emptyState());
    posts.forEach((p, i) => {
      if (i) nodes.push(h("hr"));
      nodes.push(card(p));
    });
  }
  $("#feed").replaceChildren(...nodes.flat());
}

function renderStatus(s) {
  const busy = s.phase !== "idle";
  $("#n-clean").textContent = s.counts.kept || "";
  $("#n-hidden").textContent = s.counts.hidden || "";

  const activity = $("#activity");
  activity.hidden = !busy;
  activity.textContent = s.phase === "fetching" ? "Fetching feed…" : `Filtering ${s.progress.done}/${s.progress.total}`;
  const bar = $("#progress");
  bar.style.width = s.phase === "filtering" && s.progress.total ? `${(100 * s.progress.done) / s.progress.total}%` : s.phase === "fetching" ? "12%" : "0";
  bar.style.opacity = busy ? "1" : "0";

  const refresh = $("#refresh");
  refresh.disabled = busy;
  refresh.classList.toggle("spinning", busy);
  $("#reclassify").disabled = busy;

  $("#me").replaceChildren(
    h("span", { class: "avatar" }, icon("user", 18)),
    h("span", {}, s.user ? `u/${s.user}` : s.configured ? "connecting…" : "not connected"),
    s.user && h("span", { class: "dot-online", title: "Logged in" }),
  );

  $("#model").textContent = s.model;
  const row = (label, value) => [h("dt", {}, label), h("dd", {}, value)];
  $("#stats").replaceChildren(...[
    row("Shown", s.counts.kept),
    row("Filtered out", s.counts.hidden),
    s.counts.pending > 0 && row("Waiting for filter", s.counts.pending),
    s.counts.failed > 0 && row("Couldn't classify (hidden)", s.counts.failed),
    row("Last refresh", s.lastRunAt ? ago(s.lastRunAt / 1000) : "never"),
    row("Next refresh", busy ? "running" : until(s.nextRunAt)),
    s.llm.calls > 0 && row("Model spend since start", `$${s.llm.cost.toFixed(4)}`),
  ].filter(Boolean).flat());

  $("#cats").replaceChildren(...(s.hiddenByCategory.length
    ? [h("div", { class: "cats" },
        h("div", { class: "cats-title" }, "Filtered out by reason"),
        s.hiddenByCategory.map((c) => h("div", { class: "cat" }, h("span", {}, LABELS[c.category] ?? c.category), h("span", {}, c.n))))]
    : []));
}

async function loadFeed() {
  const res = await fetch(`/api/feed?view=${state.view}`);
  state.posts = (await res.json()).posts;
  if (cards.size > 2000) cards.clear();
  render();
}

let timer;
async function tick() {
  clearTimeout(timer);
  try {
    const s = await (await fetch("/api/status")).json();
    const first = !state.status;
    state.status = s;
    renderStatus(s);
    if (s.version !== state.version) {
      state.version = s.version;
      await loadFeed();
    } else if (first) {
      render();
    }
    for (const t of document.querySelectorAll("time[data-t]")) t.textContent = ago(Number(t.dataset.t));
  } catch {
    const activity = $("#activity");
    activity.hidden = false;
    activity.textContent = "Server unreachable";
  }
  timer = setTimeout(tick, state.status?.phase === "idle" ? 15000 : 2000);
}

async function trigger(path) {
  await fetch(path, { method: "POST", headers: { "x-as-intended": "1" } });
  tick();
}

$("#refresh").addEventListener("click", () => trigger("/api/refresh"));
$("#reclassify").addEventListener("click", () => trigger("/api/reclassify"));
$("#q").addEventListener("input", (e) => {
  state.q = e.target.value;
  render();
});
for (const el of document.querySelectorAll("[data-sort]")) {
  el.addEventListener("click", () => {
    state.sort = el.dataset.sort;
    save("sort", state.sort);
    render();
    scrollTo({ top: 0 });
  });
}
addEventListener("hashchange", () => {
  state.view = location.hash === "#hidden" ? "hidden" : "clean";
  scrollTo({ top: 0 });
  loadFeed();
});

tick();

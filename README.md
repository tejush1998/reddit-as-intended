# reddit-clean-feed

Reddit home feed without the doomscroll. It reads your home timeline, has an LLM check every post, and shows only the calm ones on a local page styled like Reddit's dark theme. Click any post to open it on reddit.com.

![Clean feed screenshot](docs/screenshot.png)

**Hidden:** violence, tragedy and death, people venting or in a tough spot, self-harm, abuse, rage-bait, disturbing content.
**Kept:** everything else, including upbeat milestones ("1 year sober today") and practical questions.
Every hidden post is listed under **Filtered out** with the reason.

## You need

- [Docker](https://docs.docker.com/get-docker/) (or [OrbStack](https://orbstack.dev) on a Mac)
- A Reddit account
- An API key for an LLM. The default is [OpenRouter](https://openrouter.ai/keys) with `z-ai/glm-5.3-flash`. Filtering 200 posts costs about half a cent.

## Set up

1. **Download it**

   ```sh
   git clone https://github.com/tejush1998/reddit-clean-feed.git
   cd reddit-clean-feed
   cp .env.example .env
   ```

2. **Copy your Reddit cookie.** Log in at reddit.com, open DevTools (F12) → **Application** (**Storage** in Firefox) → **Cookies** → `https://www.reddit.com`, and copy the value of `reddit_session`. (Stays valid for 6 months)

3. **Fill in `.env`**

   ```sh
   REDDIT_COOKIE=paste-the-reddit_session-value
   LLM_API_KEY=paste-your-openrouter-key
   ```

4. **Start it**

   ```sh
   docker compose up -d --build
   ```

5. Open **http://localhost:8787**. The first run takes about a minute, and posts appear as each batch is checked. After that the feed refreshes every 15 minutes.

To stop it: `docker compose down`. After editing `.env`: `docker compose up -d --force-recreate`.

## Customise

- **What gets hidden:** edit [`prompts/filter.md`](prompts/filter.md), then click **Re-run filter** on the page.
- **Another model:** set `LLM_BASE_URL` and `LLM_MODEL` in `.env`. Any OpenAI-compatible `/chat/completions` API works (OpenAI, OpenRouter, Groq, …).
- **Refresh interval, posts per refresh, batch size:** [`config.json`](config.json), then `docker compose restart`.

## Troubleshooting

- **Red banner saying "logged out" or "instead of JSON":** the cookie expired or was revoked (logging out of Reddit revokes it). Copy a fresh `reddit_session` into `.env` and restart.
- **Red banner starting with "Filter model":** check `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL`.
- **Logs:** `docker compose logs -f`

## Good to know

- The page is only reachable from your own computer (`127.0.0.1`). Your cookie is only sent to reddit.com.
- Post titles and text are sent to the LLM provider you configure.
- A post only appears after the model approves it. If the model fails, the post stays hidden.
- This uses your own login to read your own feed, a few requests every 15 minutes. It isn't affiliated with Reddit. If Reddit has approved an API app for you, you can use that instead: see the `REDDIT_CLIENT_*` lines in `.env.example`.

## Development

Needs [Bun](https://bun.sh) 1.3+. No dependencies.

```sh
# 24 labelled sample posts instead of your real feed
REDDIT_FIXTURE=test/fixture-listing.json LLM_API_KEY=... bun src/main.ts
```

`src/reddit.ts` reads the feed, `src/filter.ts` sends posts to the LLM in batches, `src/agent.ts` runs the refresh loop, `src/db.ts` is the SQLite store, `src/main.ts` serves the page and API, and `public/` is the UI.

## License

MIT

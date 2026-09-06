# Learn Languages

A tiny quiz app for the vocabulary lists you build up after each class.

## Run it

```
npm install
npm start
```

then open http://localhost:8080

This runs a small Node server (`server.js`) that both serves the app and handles saving new characters — opening `index.html` directly from disk won't work.

## Where to put secrets (API key, login)

The server reads three optional environment variables — never put any of these in code or in a file you commit:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the **✨ Generate** sentence button |
| `APP_USERNAME` / `APP_PASSWORD` | Login for the deployed app (see below) — leave both unset for local-only use |

**Locally:** copy `env.example` to `.env` and fill in your values:

```
cp env.example .env
```

`.env` is already in `.gitignore`, is loaded automatically on `npm start` (via the `dotenv` package), and never leaves your machine.

**When deployed:** set the same variables in your host's dashboard as environment variables/secrets (see the Render steps below) — not in a file at all. The server only ever reads them from `process.env`; they're never sent to the browser.

## AI-generated example sentences (optional)

The **✨ Generate** button next to the sentence field on the "Add new characters" screen asks Claude to write a short example sentence for the character/pinyin you just typed. Set `ANTHROPIC_API_KEY` (see above) to enable it.

Without the key set, everything else still works — you'll just see an error if you click Generate, and can type sentences by hand instead. Each generated sentence is a small, thinking-disabled, low-effort request to Claude Opus 5 — well under a cent per call. The key never touches the browser; it's only read server-side.

## Login (Basic Auth)

Since this app writes files and calls a paid API, it shouldn't be left open on the internet. Setting `APP_USERNAME` and `APP_PASSWORD` turns on HTTP Basic Auth for the *entire* app (every page and API route) — your browser will prompt for them once and remember them per-device.

- **Locally:** leave both unset — no login prompt, nothing to type.
- **Deployed:** always set both. Pick a real password (not something guessable) — Basic Auth is secure here specifically *because* the host (Render) serves everything over HTTPS, so credentials are encrypted in transit. Never deploy with a username/password set but without HTTPS.

## Deploy it (free — Render.com)

Render's free web service tier works well for this: it's a normal always-on Node process (not serverless), needs no credit card, and gives you free HTTPS on a `*.onrender.com` URL.

1. **Push this project to a GitHub repo** (Render deploys from git):
   ```
   git init
   git add .
   git commit -m "Learn Languages app"
   ```
   Create an empty repo on GitHub, then follow GitHub's instructions to push (`git remote add origin ...`, `git push -u origin main`). `.env` is gitignored, so your key never gets pushed.
2. Go to [render.com](https://render.com), sign up (GitHub login is easiest), and click **New → Blueprint**. Point it at your repo — Render will read `render.yaml` (already in this project) and set up the service automatically.
3. When prompted for environment variables, fill in `ANTHROPIC_API_KEY`, `APP_USERNAME`, and `APP_PASSWORD` (see above). These are entered directly in Render's dashboard, encrypted at rest — never in your repo.
4. Deploy. Render gives you a URL like `https://learn-languages-xxxx.onrender.com` — that's your app, reachable from anywhere, behind your login.

**Two free-tier caveats worth knowing:**
- The free instance spins down after ~15 minutes of inactivity and takes a few seconds to wake up on the next visit — normal, not a bug.
- Render's free tier doesn't include a persistent disk *across redeploys* — words you add via the app stick around through normal restarts/sleep-wake, but a fresh deploy (e.g. after you `git push` a code change) resets `mandarin.md` to whatever's in the repo. If you've added a lot of words on the live site, periodically copy them back into your local `mandarin.md` and commit, so a future deploy doesn't lose them. (If you outgrow this, Render's paid persistent disk, or Fly.io's free volumes, remove the caveat entirely — ask if you want that set up instead.)

## Add words

Each language is a plain markdown file, one entry per line: `char pinyin`, optionally followed by `| an example sentence`:

```
你 nǐ
好 hǎo
事 shì | 这是一件小事。
```

An optional `## label` line (the app uses today's date, e.g. `## 2026-09-06`) marks the start of a new class session — this is how the app knows which words are newest.

You can edit the file directly, or use **+ Add new characters** in the app (on the mode-select screen) to type in new character/pinyin/sentence — they're appended to the file automatically through the running server, which opens a new dated session header for you if one doesn't already exist for today.

## Add a new language

1. Create `yourlanguage.md` in the same format.
2. Add it to `languages.json`:
   ```json
   { "id": "japanese", "name": "Japanese", "file": "japanese.md" }
   ```

## Quiz modes

- **Flashcards** – see the character, reveal the reading, self-rate.
- **Character → Pinyin** / **Pinyin → Character** – multiple choice.
- **Type the Pinyin** – free-typed recall (tone marks/numbers optional, e.g. `ni` or `ni3` both match `nǐ`).
- **Writing Practice** – see the pinyin only, write the character in your notebook, use **Hint** for a blurred peek at the character before **Show answer** reveals it fully, then self-rate. An optional **Show sentence hint** button gives a fill-in-the-blank sentence as an extra clue.
- **Confusables** – only for characters that share a pinyin with at least one other character in your list (e.g. 是/事/世, all `shì`). Shows the pinyin (plus sentence, if one exists) and asks you to pick the right character from among its actual look-alikes, instead of random distractors.
- **Sentence Practice** – shows one of your example sentences with the target word blanked out; you pick the character that fills the blank. Only includes words that have a sentence attached, so add some via the **+ Add new characters** screen to unlock it.

## Smart prioritization

By default, quizzes don't run through every word — each session is capped at ~20 words, weighted toward:
- words you've gotten wrong before (tracked in browser localStorage),
- words you haven't been quizzed on yet,
- words from your most recent class session(s), so newly-added characters get extra rounds.

Check **Study everything** on the mode-select screen to ignore the cap and prioritization and run through the full list instead.

# Learn Languages

A tiny quiz app for the vocabulary lists you build up after each class.

## Run it

```
npm install
npm start
```

then open http://localhost:8080

This runs a small Node server (`server.js`) that both serves the app and handles reading/saving words in a Google Sheet — opening `index.html` directly from disk won't work.

Words are stored in **Google Sheets** (one worksheet per language), not in markdown files anymore. You'll need to do the one-time [Google Sheets setup](#google-sheets-setup) below before words will load or save. Pinyin is generated automatically from the character you type (via `pinyin-pro`), so you never type it by hand.

## Where to put secrets (API key, login)

The server reads three optional environment variables — never put any of these in code or in a file you commit:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the **✨ Generate** sentence button |
| `APP_USERNAME` / `APP_PASSWORD` | Login for the deployed app (see below) — leave both unset for local-only use |
| `GOOGLE_SERVICE_ACCOUNT_JSON` *or* `GOOGLE_SERVICE_ACCOUNT_FILE` | Google service-account key used to read/write the sheet (see [Google Sheets setup](#google-sheets-setup)) |
| `GOOGLE_SHEET_ID` (or `GOOGLE_SHEET_ID_<LANGID>`) | Which spreadsheet to use — optional if you put the id in `languages.json` |

**Locally:** copy `env.example` to `.env` and fill in your values:

```
cp env.example .env
```

`.env` is already in `.gitignore`, is loaded automatically on `npm start` (via the `dotenv` package), and never leaves your machine.

**When deployed:** set the same variables in your host's dashboard as environment variables/secrets (see the Render steps below) — not in a file at all. The server only ever reads them from `process.env`; they're never sent to the browser.

## Google Sheets setup

Words live in a Google Sheet, and the server talks to it through a **service account** (a robot Google identity — no interactive login, works great on a server). One-time setup:

1. **Create the spreadsheet.** In Google Sheets, make a new blank sheet. Rename the first tab to match your language id — `mandarin` for the default. The app writes a header row (`char`, `pinyin`, `sentence`, `session`) automatically on first use, so you can leave it empty. Grab the **spreadsheet ID** from the URL — it's the long string between `/d/` and `/edit`:
   ```
   https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit
   ```
2. **Create a Google Cloud project + service account.**
   - Go to the [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project.
   - Enable the **Google Sheets API** for it (APIs & Services → Library → search "Google Sheets API" → Enable).
   - APIs & Services → Credentials → **Create credentials → Service account**. Give it any name; no roles are needed.
   - Open the new service account → **Keys** tab → **Add key → Create new key → JSON**. A `.json` key file downloads. Keep it safe — it's a credential.
3. **Share the sheet with the service account.** Open the key file and copy the `client_email` value (looks like `something@your-project.iam.gserviceaccount.com`). In your Google Sheet, click **Share** and give that email **Editor** access. This is what lets the robot read and write your sheet.
4. **Point the app at the sheet.** Either:
   - put the ID in `languages.json` (`"sheetId": "THE_ID"`), **or**
   - set `GOOGLE_SHEET_ID=THE_ID` in your `.env` / host env (this overrides `languages.json`).
5. **Give the app the credentials.** Either:
   - **locally:** save the key file in the project as `service-account.json` (it's gitignored) and set `GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json`, **or**
   - **anywhere:** set `GOOGLE_SERVICE_ACCOUNT_JSON` to the entire contents of the key file (one line). This is the best option for hosts like Render where you can't upload a file.
6. **Migrate your existing words (optional, one-time).** If you already have words in `mandarin.md`, push them into the sheet:
   ```
   npm run migrate
   ```
   It parses the old markdown (keeping example sentences and session dates) and appends every word as a row. It refuses to run if the tab already has data, so you won't double up — pass `npm run migrate -- --force` only if you really mean to. After migrating you can delete `mandarin.md` (keep the `legacyFile` line in `languages.json` if you might want to re-run migration).

That's it — start the server and your words load from the sheet. Adding a word from the app writes a new row; today's date goes in the `session` column so the app still knows which words are newest.

## AI-generated example sentences (optional)

The **✨ Generate** button next to the sentence field on the "Add new characters" screen asks Claude to write a short example sentence for the character/pinyin you just typed. Set `ANTHROPIC_API_KEY` (see above) to enable it.

The **Review Story** mode uses the same key to write a short story that reuses many of your words at once (see Quiz modes below).

Without the key set, everything else still works — you'll just see an error if you click Generate, and can type sentences by hand instead. Both features are low-effort Claude Opus 5 requests (a single sentence is thinking-disabled and tiny; a review story leaves thinking on since it has to juggle ~15-20 words at once, but still stays at low effort) — each call costs a small fraction of a cent. The key never touches the browser; it's only read server-side.

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

Set `GOOGLE_SERVICE_ACCOUNT_JSON` (the full key file contents, one line) and `GOOGLE_SHEET_ID` in Render's dashboard alongside the other variables. Because words now live in Google Sheets, there's no local-file persistence to worry about — the old "redeploys reset your words" caveat is gone. Adding words on the live site writes straight to your sheet.

**One free-tier caveat worth knowing:**
- The free instance spins down after ~15 minutes of inactivity and takes a few seconds to wake up on the next visit — normal, not a bug.

## Add words

Each language is a worksheet (tab) in your Google Sheet, one word per row across four columns:

| char | pinyin | sentence | session |
|---|---|---|---|
| 你 | nǐ | | 2026-09-06 |
| 事 | shì | 这是一件小事。 | 2026-09-06 |

The `session` column holds a date (`YYYY-MM-DD`) — all rows sharing a date are one class session, which is how the app knows which words are newest.

You can add words two ways:
- **In the app:** use **+ Add new characters** on the mode-select screen. Type the character; the **pinyin fills in automatically** and you can optionally add an example sentence. On save it's written as a new row with today's date in `session`.
- **Directly in the sheet:** add rows by hand. You can leave `pinyin` blank and fill it later, but the app expects both `char` and `pinyin` to show a word, so it's easiest to add words through the app and let it generate the pinyin.

## Add a new language

1. Add a new tab to your spreadsheet named after the language id (e.g. `japanese`).
2. Add it to `languages.json`:
   ```json
   { "id": "japanese", "name": "Japanese", "sheetId": "SPREADSHEET_ID", "tab": "japanese" }
   ```
   (`sheetId` is optional if you set a `GOOGLE_SHEET_ID` env var; multiple languages can share one spreadsheet using different `tab` names.)

## Quiz modes

- **Flashcards** – see the character, reveal the reading, self-rate.
- **Character → Pinyin** / **Pinyin → Character** – multiple choice.
- **Type the Pinyin** – free-typed recall (tone marks/numbers optional, e.g. `ni` or `ni3` both match `nǐ`).
- **Writing Practice** – see the pinyin only, write the character in your notebook, use **Hint** for a blurred peek at the character before **Show answer** reveals it fully, then self-rate. An optional **Show sentence hint** button gives a fill-in-the-blank sentence as an extra clue.
- **Confusables** – only for characters that share a pinyin with at least one other character in your list (e.g. 是/事/世, all `shì`). Shows the pinyin (plus sentence, if one exists) and asks you to pick the right character from among its actual look-alikes, instead of random distractors.
- **Sentence Practice** – shows one of your example sentences with the target word blanked out; you pick the character that fills the blank. Only includes words that have a sentence attached, so add some via the **+ Add new characters** screen to unlock it.
- **Review Story** – asks Claude to write a short story (a few sentences) that naturally weaves in as many of your words as it can, using the same smart-prioritized word set as the quizzes (respects the **Study everything** toggle too — check it to try to use every word instead of the capped set). Shows which words made it in and which didn't, with **🔄 Regenerate** for a fresh attempt. Requires `ANTHROPIC_API_KEY` (see above).

## Smart prioritization

By default, quizzes don't run through every word — each session is capped at ~20 words, weighted toward:
- words you've gotten wrong before (tracked in browser localStorage),
- words you haven't been quizzed on yet,
- words from your most recent class session(s), so newly-added characters get extra rounds.

Check **Study everything** on the mode-select screen to ignore the cap and prioritization and run through the full list instead.

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

## Where to put secrets (login, Google key)

The server reads these environment variables — never put any of them in code or in a file you commit. There's no Anthropic API key: AI runs on your own machine (see [AI features](#ai-features-local-bridge)).

| Variable | Purpose |
|---|---|
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

## AI features (local bridge)

Every Claude feature runs through `local-bridge.js`, a small helper you start on the machine you're studying on. It uses the [Claude Code](https://code.claude.com) CLI (`claude -p`) with your own Claude login, so the deployed server needs no Anthropic API key. The browser calls the bridge directly at `http://localhost:8421`; results that should be kept (Hán Việt, chiết tự, grammar) are then saved to your sheet through the server.

Features that use it: **✨ Generate** sentence, the Hán Việt / chiết tự / grammar annotation when you add a word (and the **Regenerate** button and the lazy fill-in on flashcards), **Scan old words for grammar**, **Confusables** context sentences, **Sentence Builder**, **Review Story**, and **Write in Chinese** / **Grammar Practice** (tasks and grading).

**Run it** (needs Node 18+ and Claude Code installed and logged in — check with `claude -p "hi"`):

```powershell
# PowerShell
$env:BRIDGE_ALLOWED_ORIGINS="https://your-app.onrender.com"; npm run bridge
```
```bash
# macOS / Linux
BRIDGE_ALLOWED_ORIGINS=https://your-app.onrender.com npm run bridge
```

`BRIDGE_ALLOWED_ORIGINS` is the exact address of your deployed app (scheme + host, no trailing slash); add `,http://localhost:8080` to also use it with a local `npm start`. The bridge has no npm dependencies, so on another machine you can copy just `local-bridge.js` and run `node local-bridge.js`.

The first time the deployed site calls it, Chrome/Edge ask to let the site **access other apps and services on this device** — click **Allow**. Safari blocks these calls, so use Chrome, Edge or Firefox.

Optional settings: `BRIDGE_MODEL_FAST` (default `haiku`: sentences, tasks, grading), `BRIDGE_MODEL_STORY` (default `sonnet`), `BRIDGE_MODEL_WORDINFO` (default `opus`: Hán Việt, chiết tự, grammar), `BRIDGE_CONCURRENCY` (default 3), `BRIDGE_PORT` (default 8421), `CLAUDE_BIN` (full path to `claude`/`claude.exe` if it isn't on your PATH).

The bridge only listens on `127.0.0.1`, only answers requests from the origins you list, and runs Claude with all tools disabled, so a web page can't use it to read files or run commands. If it isn't running, the rest of the app still works; AI buttons show "can't reach the local bridge", and new words are saved without their annotation (filled in later).

## Login (Basic Auth)

Since this app writes to your sheet, it shouldn't be left open on the internet. Setting `APP_USERNAME` and `APP_PASSWORD` turns on HTTP Basic Auth for the *entire* app (every page and API route) — your browser will prompt for them once and remember them per-device.

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
3. When prompted for environment variables, fill in `APP_USERNAME` and `APP_PASSWORD` (see above). These are entered directly in Render's dashboard, encrypted at rest — never in your repo.
4. Deploy. Render gives you a URL like `https://learn-languages-xxxx.onrender.com` — that's your app, reachable from anywhere, behind your login.

Set `GOOGLE_SERVICE_ACCOUNT_JSON` (the full key file contents, one line) and `GOOGLE_SHEET_ID` in Render's dashboard alongside the other variables. Because words now live in Google Sheets, there's no local-file persistence to worry about — the old "redeploys reset your words" caveat is gone. Adding words on the live site writes straight to your sheet.

**One free-tier caveat worth knowing:**
- The free instance spins down after ~15 minutes of inactivity and takes a few seconds to wake up on the next visit — normal, not a bug.

## Add words

Each language is a worksheet (tab) in your Google Sheet, one word per row. Words added in the app start at **column D** (columns A–C stay empty):

| D: char | E: pinyin | F: sentence | G: session | H: chiết tự | I: Hán Việt | J: grammar |
|---|---|---|---|---|---|---|
| 你 | nǐ | | 2026-09-06 | | | |
| 事 | shì | 这是一件小事。 | 2026-09-06 | | | |

Older rows that start at column A (char=A, pinyin=B, sentence=C, session=D) are still read, so you don't need to move them. `npm run migrate` also still writes that older A–D layout.

The `session` column holds a date (`YYYY-MM-DD`) — all rows sharing a date are one class session, which is how the app knows which words are newest.

You can add words two ways:
- **In the app:** use **+ Add new characters** on the mode-select screen. Type the character; the **pinyin fills in automatically** and you can optionally add an example sentence. On save it's written as a new row with today's date in `session`.
- **Directly in the sheet:** add rows by hand. You can leave `pinyin` blank and fill it later, but the app expects both `char` and `pinyin` to show a word, so it's easiest to add words through the app and let it generate the pinyin.

**Multi-character words** (音乐, 银行, 长大…) can be added as one entry, alongside single characters. The pinyin is read in context (音乐 → yīn yuè, not yīn lè). Multiple-choice options always match the answer's length, so a two-character word only competes with other two-character options and doesn't stand out. When a word contains a character with several readings, one of the wrong options uses the other reading (e.g. `yīn lè` for 音乐), which tests exactly that trap. In **Type the Pinyin**, spaces between syllables are optional (`yin1yue4` works).

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
- **Type the Pinyin** – free-typed recall, graded with tones (`ni3` or `nǐ` match `nǐ`; spaces between syllables optional).
- **Listening** – the browser speaks the word (🔊 play again, 🐢 slower, or 📖 hear it in your example sentence) and you pick the character. Wrong options never sound identical to the answer (是 and 事 are both `shì`, so they're never paired), and words with the same syllables but a different tone (十 `shí`, 使 `shǐ`) are picked first, so it doubles as a tone test. Uses the browser's built-in speech; Chrome and Edge include Chinese voices.
- **Stroke Order** – see the pinyin plus context: your example sentence with the word blanked out (or, for words without one, a sentence generated by the [local bridge](#ai-features-local-bridge)), and the Hán Việt reading if that toggle is on. Then write the character on screen with mouse, finger or pen. Each stroke is checked using [Hanzi Writer](https://hanziwriter.org/), and after 3 misses on a stroke it highlights where the stroke goes. **💡 Show outline** shows a faint outline and **▶ Show me** plays the stroke order; either one counts the word as a miss. A word counts as known with up to 2 wrong strokes per character. Multi-character words are written one character at a time. Needs internet: the library and stroke data load from cdn.jsdelivr.net. If a character has no stroke data, you write it on paper and rate yourself instead.
- **Writing Practice** – see the pinyin only, write the character in your notebook, use **Hint** for a blurred peek at the character before **Show answer** reveals it fully, then self-rate. An optional **Show sentence hint** button gives a fill-in-the-blank sentence as an extra clue.
- **Confusables** – only for characters that share a pinyin with at least one other character in your list (e.g. 是/事/世, all `shì`). Shows the pinyin (plus sentence, if one exists) and asks you to pick the right character from among its actual look-alikes, instead of random distractors.
- **Sentence Practice** – shows one of your example sentences with the target word blanked out; you pick the character that fills the blank. Only includes words that have a sentence attached, so add some via the **+ Add new characters** screen to unlock it.
- **Sentence Builder** – drag shuffled chunks of a generated sentence back into order. Each sentence is built around one of your newest words (cycled so each gets a turn), sometimes plus another word from your list, with a random topic and grammar pattern for its HSK level. Recent sentences are remembered so they aren't repeated.
- **Review Story** – asks Claude to write a short story or conversation from a fresh random mix of your words: up to 5 of your newest words (which it must use) plus a random handful of others, weighted toward the weak ones. The scenario (setting, character, what happens, tone) is drawn at random for every story, so premises don't repeat. Afterwards it shows how many picked words made it in and any new words it skipped. Check **Study everything** to send your whole list instead. Requires the [local bridge](#ai-features-local-bridge).
- **Write in Chinese** – typed writing practice for grammar. Choose **Translate** (Claude writes 2–4 sentences in English or Vietnamese for you to write in Chinese) or **Free writing** (a random topic to write 3–5 sentences about). Every task gives you 2–3 of your words (mostly new ones) and one grammar pattern for the chosen HSK level. After you type your answer, Claude returns your text with corrections highlighted, each mistake with a short explanation of the rule (in English or Vietnamese), whether you used each target word and the pattern correctly, and a more natural native-speaker version. Words you misuse count as misses in your word stats. Grammar patterns you get wrong or leave out are tracked in browser localStorage and picked more often until you get them right. You can edit your text and check again; only the first check of a task counts toward your stats. Requires the [local bridge](#ai-features-local-bridge).

## Daily goal and streak

Every answered question counts as one review, in any mode. The mode screen shows today's progress toward your daily goal (default 20, change it in the **Daily goal** box). The header shows `🔥 streak · reviews/goal`. Reaching the goal keeps your streak going, and you get a 🎉 message when you hit it. Your streak only breaks when a whole day ends without reaching the goal. Like word stats, this is stored in this browser's localStorage, so each device keeps its own count.

## Smart prioritization

By default, quizzes don't run through every word. Each session is capped at 20 words, split into:
- **~40% new words** – from your two most recent class sessions,
- **~40% weak words** – ones you've flagged 🚩, missed recently, or have a low remembering score,
- **the rest** – older words you know, least-recently-seen first, so they don't fade.

If one group is short, the spare slots go to new words first, then weak ones. "Missed recently" uses a running error rate that favors your latest answers, so a word you used to miss stops dominating once you've gotten it right a few times in a row (stats live in browser localStorage).

In **Flashcards**, a card you mark as not known comes back once more about 4 cards later in the same run.

Check **Study everything** on the mode-select screen to ignore the cap and prioritization and run through the full list instead.

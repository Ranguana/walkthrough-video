---
name: walkthrough-video
description: Record a narrated product walkthrough video of a website, web app, or Electron desktop app — scripted Playwright recording, per-beat voice-over, burned-in captions, thumbnail, and a QA pass. Use for a demo video, product walkthrough, screencast, or narrated recording of an app.
license: MIT
metadata:
  version: "0.1.0"
  requires: "Node 22+, ffmpeg/ffprobe, Playwright Chromium; ElevenLabs API key optional"
---

# Walkthrough video

Produces a 1080p narrated product walkthrough from any website, web app, or Electron desktop app, end to end, without a
screen-recording app: Playwright drives the target beat by beat and records it, a text-to-speech voice reads a per-beat
script, ffmpeg lines the narration up with the picture, burns captions, makes a thumbnail, and a QA script proves the
timing. Everything is driven by two files in the project: `walkthrough.config.json` and `beats.json`. The scripts in this
skill folder are generic; nothing about the target is hard-coded.

Skill folder: `~/.claude/skills/walkthrough-video/` (referred to below as `$SKILL`). Scripts: `$SKILL/scripts/{record,tts,assemble,qa,stills}.mjs`.

## Prerequisites (check once per machine)

```bash
node --version                      # 22+
ffmpeg -version && ffprobe -version # any recent build; libass is NOT required (captions are burned as PNG overlays)
cd "$SKILL" && npm install && npx playwright install chromium
```

### Narration engine

Two engines, picked automatically:

| Engine | When it is used | Cost |
|---|---|---|
| `elevenlabs` | `ELEVENLABS_API_KEY` **and** `ELEVENLABS_VOICE_ID` are set | billed per character |
| `say` | no credentials found (macOS only) | free, offline |

Force one with `--engine say` / `--engine elevenlabs`, or `"voice": { "engine": "say" }` in the config. `say` is the right
default for drafts, internal builds and CI; ElevenLabs is worth it for anything published. On Linux/Windows with no key,
render `vo/<id>.wav` with any other tool and set `dur` per beat — `assemble.mjs` needs nothing else.

Credentials are looked up in this order, first hit per variable wins:

1. the process environment
2. the project's env file — `envFile` in the config, default `.env.local` next to it
3. `~/.config/walkthrough-video/.env` — a shared per-user file (`chmod 600`), the place to put the key once for every project

**Never print, echo, `cat` or `grep` the values of an env file, and never copy them into a config, a beats file or a
deliverable.** To confirm a variable exists without revealing it: `grep -c '^ELEVENLABS_API_KEY=' <file>`.

## Choose the target

`walkthrough.config.json` says what is being recorded:

```json
{ "target": { "type": "web", "baseUrl": "https://example.com" } }
```
```json
{ "target": { "type": "electron", "appPath": "dist/mac-arm64/My App.app", "args": [], "cwd": "." } }
```

A **web** target runs in headless Chromium and is recorded with Playwright's video recorder. An **electron** target is
launched with Playwright's Electron support and driven with exactly the same actions — but Electron windows cannot use
`recordVideo`, so the take is captured as a timestamped PNG sequence instead (see "Electron apps" below). A bare
top-level `"baseUrl"` is still accepted as shorthand for a web target.

## Procedure

Work in a folder inside the project (for example `docs/walkthrough/` or `video/`), so the config, beats, takes and
deliverables sit together and can be re-rendered later. Keep `takes/` and `build/` out of git.

### (a) Discover the app

Before writing a single beat, learn the site the way a first-time viewer would:

1. **Routes.** List the pages (`app/**/page.tsx`, `pages/**`, the router file, or the nav links on the live site). Decide
   which 4-8 screens tell the story: landing → the core workflow, step by step → the result → close.
2. **Public vs signed-in.** Which of those screens need a session? Prefer a public demo/sandbox path (`/demo`,
   `/try`, `/sandbox`, a "Use sample data" button) — it needs no account, nothing is saved, and the data is already fictional.
   If the story needs the signed-in app, read "Signed-in apps" below first.
3. **Fictional data source.** Find where the demo data comes from (`src/lib/demo/*`, seed scripts, fixtures). Names,
   addresses and numbers on screen must be obviously fictional. If no sample data exists, create it before recording.
4. **Selectors.** Open the pages with Playwright (headed if useful) and note stable targets for everything the cursor will
   touch: headings (`h1:has-text("Review")`), roles (`{ "role": "button", "name": "Continue" }`), ids, `data-testid`s.
   Avoid nth-of-type guesses on generic inputs unless the layout is fixed.
5. **Traps.** Note native `<select>` elements (their popups are invisible in recordings), `window.confirm()` dialogs
   (they block the page), file uploads (need a fixture file), buttons with real side effects (emails, payments, records
   created — hover them, do not click), and anything that reveals real user data.

Write down the beat list (screen, what the cursor does, one sentence of narration each) and get the length right: about
100-150 spoken words per minute; a 90-second walkthrough is 5-7 beats and 180-220 words.

### (b) Write beats.json

Copy `$SKILL/templates/beats.example.json` and edit. Each beat:

```json
{ "id": "02-upload", "screen": "Demo — upload step",
  "text": "This is the public demo… a fictional sample matter. Nothing is saved.",
  "pad": 0.8,
  "actions": [ { "goto": "/demo" }, { "hover": { "role": "button", "name": "Use sample" }, "for": 1.2 }, { "holdNarration": 0.8 }, { "click": "text=Use sample" }, { "waitFor": "h1:has-text(\"Review\")" } ] }
```

- `id` (stable, ordered like `01-hook`), `screen` (for the README), `text` (caption/written form — see
  `templates/narration-style.md`), optional `spoken` override, optional `pad` (silence after the narration before the
  next beat starts, default `pad` from the config), optional `hold` (minimum beat length even with no narration).
- `actions` run in order; all times in **seconds**. The full action list is documented at the top of `scripts/record.mjs`:
  `goto`, `waitFor`, `waitUrl`, `wait`, `mouse`, `hover`, `click`, `type` (with `env` for secrets), `press`, `select`
  (with `menu: true`), `upload`, `scroll`, `scrollIntoView`, `scrollEl`, `zoom`, `highlight`/`unhighlight`, `card`,
  `dialog`, `eval`, `screenshot`, `holdNarration`.
- Every beat is held at the end until it has lasted `voLead + dur + pad` (`autoHold`). Put `holdNarration` before the
  click that leaves the screen when the narration should finish on the current screen.
- `dur` is filled in by `tts.mjs`; leave it out.
- A beat with `"kind": "stills"` and no `actions` is a still-frame beat built by `stills.mjs` (see below).
- The last beat is the close: a `card` action with the disclaimer line, the URL, and "no signup / fictional data".

Also copy `$SKILL/templates/walkthrough.config.example.json` to `walkthrough.config.json` and set `name`, `target`
(web `baseUrl` or electron `appPath`), `outDir`, `spokenMap` (number and name readings), `card.brand`, `thumbnail`.
`baseUrl` has no default — the config will not load until you set a target.

### (c) Narrate (before recording)

The narration comes first because the recording paces itself to the clip lengths.

```bash
node $SKILL/scripts/tts.mjs --config walkthrough.config.json --dry-run   # spoken text + character count, no API call
node $SKILL/scripts/tts.mjs --config walkthrough.config.json             # renders vo/<id>.wav, writes "dur"/"spoken" into beats.json
node $SKILL/scripts/tts.mjs --config walkthrough.config.json --engine say # free local voice, even when a key is present
```

- Per-beat cache: `vo/src/<id>.{mp3,aiff}` + a `.json` sidecar keyed on spoken text, engine and voice settings. Re-running
  only re-renders beats whose text changed. `--only 03-review,08-close` limits a run; `--force` re-renders everything.
  Switching engines invalidates the cache, as it should.
- Character budget (ElevenLabs only): the script refuses to send more than `voice.maxChars` (default 6000) in one run and
  checks the account's remaining quota first. Preview with `--dry-run` and tighten the script before rendering; do not burn
  quota on drafts — draft with `--engine say`, then re-render the final pass with ElevenLabs.
- Humanization: `…` becomes a pause, URLs are read as "example dot com slash demo", `spokenMap` handles form numbers,
  dollar amounts and contractions. Read `templates/narration-style.md` before writing the text. Listen to the first
  render of every beat (`afplay vo/01-hook.wav` on macOS) and fix any misread before recording.
- Clips are 48 kHz stereo WAV with leading silence trimmed to under 60 ms, so speech onset lands exactly on `voLead`.

### (d) Record with Playwright

```bash
node $SKILL/scripts/record.mjs --config walkthrough.config.json            # -> takes/takeN/raw.webm + timings.json + notes.json
node $SKILL/scripts/record.mjs --config walkthrough.config.json --headed   # watch it while debugging selectors
node $SKILL/scripts/record.mjs --config walkthrough.config.json --only 03-review
```

What the recorder does for you: 1920×1080 viewport at device scale 1, a cursor halo that follows the mouse and pulses on
click (headless recordings have no visible cursor), eased smooth scrolling (`scroll`, `scrollIntoView`, `scrollEl`),
animated zoom for the proof-point beat, text highlighting with `highlight`, first-frame timing of every beat, and the hold
logic that keeps each beat on screen for its narration. Action errors are logged to `notes.json` and the take continues
(exit code 1) so you can see the whole run before fixing one selector.

Workarounds you will need:

- **Native `<select>`**: headless Chromium never paints the popup. Use `{ "select": "#deed-type", "value": "x",
  "menu": true, "hoverValues": ["a", "b"] }` — the recorder draws the select's own options as an on-screen list, moves
  the cursor over them, then calls `selectOption` for real.
- **`confirm()` / `alert()`**: the page blocks until the dialog is answered, and the dialog itself is never in the video.
  The recorder auto-answers with `config.dialogs` (`accept` default) or a `{ "dialog": "dismiss" }` action. If the viewer
  should *see* a confirmation, show a `card` or hover the button without clicking.
- **Downloads** (docx/pdf generation): they stream to the browser and are not visible; narrate "one click generates…" while
  hovering, or click and let the app's own "generated" state show. Check nothing was written server-side you need to clean up.
- **Real side effects** (invites, emails, payments): hover, never click. Say so in the deliverables README.
- **Animations / lazy content**: add `wait` after navigation; use `waitUntil: "networkidle"` for landing pages.

Do 2-3 takes if needed; `assemble.mjs` uses the latest by default (`--take N` to choose).

### (e) Assemble with ffmpeg

```bash
node $SKILL/scripts/assemble.mjs --config walkthrough.config.json [--take N] [--no-captions]
```

1. `raw.webm` → 30 fps H.264 master (`build/master-raw.mp4`).
2. Splices `stills/stills-silent.mp4` before the first recorded beat that follows the stills beats (or `--before id`).
3. **Extends holds instead of speeding audio**: any beat whose video is shorter than `voLead + dur + tail` gets its last
   frame frozen for the difference. This is what makes re-narrating without re-recording safe.
4. Places each beat's clip **0.5 s after its first frame** (`voLead`), mixes, muxes → `deliverables/<name>.mp4`.
5. Captions: `<name>.srt` timed per sentence/clause from the clip lengths, and `<name>-captioned.mp4` with burned-in
   captions (PNG overlays rendered with Playwright — no libass needed).
6. `thumbnail.png` (frame from `thumbnail.beat` + optional title band), `narration-script.txt`, and a `README.md` with
   the beat table, re-render commands and compliance notes.

The summary prints per-beat slack; "TIGHT" means the tail is under `tail` seconds — usually fine, but re-record if motion
was cut off.

### (f) QA

```bash
node $SKILL/scripts/qa.mjs --config walkthrough.config.json
```

Checks: audio and video track lengths match; timings `end` matches the file; **speech onset** (ffmpeg `silencedetect`)
lands `voLead` after each beat's first frame within 0.25 s; every narration ends before the next beat; a frame is
extracted from every beat into `qa/frames/`. Then **look at every frame** (Read the PNGs): wrong screen, un-dismissed
menu, cursor halo stuck at a corner, a real name on screen, caption overlapping the closing card. Watch the captioned cut
once end to end. Fix, re-run the stage that changed, re-assemble, re-QA.

### (g) Deliverables and re-rendering

```
<outDir>/
  takes/takeN/raw.webm | frames/, timings.json, notes.json     the recording (keep the chosen take; ignore the rest)
  vo/<id>.wav, vo/src/<id>.{mp3,aiff} + .json, narration-spoken.txt   narration + cache
  stills/                                             still-frame beat (when used)
  build/                                              intermediates, timings-final.json
  deliverables/<name>.mp4, <name>-captioned.mp4, <name>.srt, thumbnail.png, narration-script.txt, README.md
  qa/frames/<id>.png, report.json
```

Upload `<name>.mp4` and attach `<name>.srt` as the caption track (never rely on auto-captions for product or legal
terms); use the captioned file where a player cannot load an SRT. Re-render commands are in the generated README:

- Change a line → edit `text`, `tts.mjs`, `assemble.mjs` (holds stretch automatically), `qa.mjs`.
- Change what happens on screen → edit `actions`, `record.mjs`, `assemble.mjs`, `qa.mjs`.
- Human voice instead of synthetic → drop `vo/<id>.wav` files in, set `dur` per beat, `assemble.mjs` only.
- Alternate cut (a 60-90 s landing version) → a second `beats-landing.json` and config with a different `name` and
  `beats`, reusing the same `vo/` folder (`outDir` shared, `name` different).

Tell the user where the deliverables are, the runtime, the character count billed, and anything that was approximated
(hovered instead of clicked, a bug masked, a beat built from stills).

## Signed-in apps

When the story needs the real app behind a login:

1. **Throwaway account, never a real one.** Write a `setup` script that uses the app's admin API or service-role
   database key (from `envFile`) to create a fresh tenant/org + owner user with a random password (`crypto.randomBytes`),
   obviously fictional names (`Example Co`, `video-demo+<timestamp>@example.com` — `example.com` is reserved for exactly
   this), any flags the story needs (plan, feature toggles), and writes `state.json` (git-ignored) with the ids. A matching
   `cleanup` script deletes everything it created plus everything the recording produced (documents, usage rows,
   connections, memberships, auth users) and then **verifies zero rows remain** by counting. A `reset` script between
   takes deletes what the previous take created and re-opens any first-run state. Keep all three next to the config so the
   run is reproducible.
2. **Sign in inside the take** with `type` actions that read from the environment, never from `beats.json`:
   `{ "type": "#email", "env": "DEMO_LOGIN_EMAIL" }`, `{ "type": "#password", "env": "DEMO_LOGIN_PASSWORD" }`. Export
   those from `state.json` before recording. **Never type a real user's password**, and never put credentials in a file
   that ships with the deliverables.
   - *Password sign-in*: the flow above; the typing itself is on screen and reads well ("sign in as the firm").
   - *Magic-link sign-in*: Playwright cannot read the inbox. Either create the auth user confirmed via the admin API and
     generate a session (Supabase: `auth.admin.generateLink({ type: 'magiclink' })` then open the returned action link
     in the take), or sign in once by hand, save `context.storageState()` to a git-ignored file and set `storageState` in
     the config so the take starts signed in. Cut the sign-in beat and narrate "signed in to the firm's account".
3. **Fictional data on every screen.** Seed the throwaway tenant with the demo matter; hover, do not click, anything that
   sends email or touches a real third party; mask bugs in post only when the README says so.
4. Run `setup` → `tts` → `record` → `assemble` → `qa` → `cleanup`, and put "throwaway account created and deleted,
   verified zero rows" in the README.

### Capturing a beat in the user's own Chrome (Claude-in-Chrome extension)

Some beats cannot run in a throwaway account: a live third-party integration (a real Clio/QuickBooks connection), an
OAuth grant, a profile-bound session. Capture those in the user's own browser with the Claude-in-Chrome tools and build
the beat from stills:

- **Profile pitfall.** The extension must be connected from the **same Chrome profile that holds the login**. If
  `tabs_context` shows a signed-out page, the wrong profile is connected — ask the user to open the extension from the
  profile they use for that app, then reconnect (`list_connected_browsers` / `select_browser`).
- **`confirm()` freezes the tab.** A native confirm/alert opened in the user's Chrome blocks the extension's tools until
  a human clicks it. Warn the user before an action that will raise one, or avoid that click and narrate over a still.
- **The GIF recorder caps at 50 frames** (`gif_creator`), which is a few seconds at most and low resolution. Do not use it
  for anything longer than a click-and-response. Instead take **high-resolution screenshots** of each state (resize the
  window to the target aspect first with `resize_window`; the extension's `computer` screenshot returns the tab at its
  real pixel size), save them under `stills/`, and list them in `shots.json` with holds and click points
  (`templates/shots.example.json`). `stills.mjs` composes each shot on the 1920×1080 canvas (scaled card with a drop
  shadow, or `fit: "full"` for a full-bleed capture), adds the same cursor halo at the click point, crossfades 0.3 s
  between shots, and writes `stills/stills-silent.mp4` + `stills-timings.json`; `assemble.mjs` splices it in and
  narrates it like any other beat.
- Put the still beats in `beats.json` with `"kind": "stills"` (text, no actions), in the position they should appear.
  Keep the total short (30-60 s): stills with crossfades read fine for that long and start to feel like a slideshow after.
- Mask anything that must not ship (a bug's error text, a real name) by editing the PNG before composing, and say so in
  the README.
- Screenshots taken with the extension contain whatever is on the user's screen: check every still for real data,
  notifications, bookmarks and other tabs before it goes into a video.

## Electron apps

An Electron target is driven by the same action DSL — `click`, `type`, `hover`, `scroll`, `waitFor`, `highlight`, `card`,
`screenshot` all work on a Playwright `Page`, whatever is behind it. What differs:

- **No `goto`.** The window is already loaded by the app's main process. Navigate with the app's own UI instead. A `goto`
  with a relative path throws a clear error; an absolute `https://` URL still works if the window will follow it.
- **No `recordVideo`.** Playwright cannot record an Electron window, so an Electron take is always captured as a
  timestamped PNG sequence: `takes/takeN/frames/f00000.png…` plus `index.json`. Each frame's real offset is recorded and
  `assemble.mjs` rebuilds an exact wall-clock timeline from it with ffmpeg's concat demuxer, so beat timings still line up
  with the narration. Screenshots cost 50-150 ms each, so the capture rate is `framesFps` (default 8), not 30 — set it
  lower for a long take, higher (10-12) for one with fast motion. `--frames` forces the same mode for a web target.
- **Window size.** The recording is only as sharp as the window. `record.mjs` asks the main process to
  `setContentSize(1920, 1080)` and warns if the window ends up a different size (frames are then letterboxed to the
  canvas at assembly). The reliable fix is the app's own `BrowserWindow` options — `width: 1920, height: 1080` — in a
  dev/demo build.
- **It must be launchable headfully and already built.** Point `appPath` at the packaged app (`dist/mac-arm64/My App.app`)
  or at the local Electron binary with `args: ["."]` and `cwd` set to the project. A renderer that loads no data without
  its main-process bridge is exactly the case this mode exists for: launch the real app, do not try to open its HTML in a
  browser.
- **The app's real state is on screen.** It is the user's own app data unless you point it at a demo profile — use a
  throwaway profile directory (`args: ["--user-data-dir=..."]` if the app honours it) or seed fictional data first, and
  check every QA frame for real content.

See `examples/electron-beats.example.json` for a two-beat Electron beats file.

## Checklist before publishing

- Fictional data only. No real names, addresses, account ids, emails, or customer records.
- The closing beat carries the limitation your product needs, **spoken** as well as on the card: "This is a product
  demonstration, not <advice>." See `templates/narration-style.md` for regulated-industry notes (the legal example there
  is a worked case, not a requirement).
- `qa.mjs` passes; every QA frame was looked at; the captioned cut was watched once end to end.
- Throwaway accounts cleaned up (verified), `state.json` and env files not in the deliverables.
- Deliverables README lists every approximation (hovered not clicked, masked text, still-frame beats).
- No API key, voice id or other credential appears in the config, the beats file, the narration or any deliverable.

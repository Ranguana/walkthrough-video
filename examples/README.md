# Examples

No media is committed here — the whole point of the skill is that you can regenerate it in about a minute, and a repo
full of mp4s is a repo nobody wants to clone.

## `beats.minimal.json` — the 2-beat smoke test

Two public pages, the free macOS `say` voice, no API key. This is the fastest way to prove the whole pipeline works on a
new machine.

```bash
S=~/.claude/skills/walkthrough-video
mkdir -p /tmp/wtv-demo && cd /tmp/wtv-demo
cp $S/templates/walkthrough.config.example.json walkthrough.config.json
cp $S/examples/beats.minimal.json beats.json

node $S/scripts/tts.mjs      --config walkthrough.config.json --engine say
node $S/scripts/record.mjs   --config walkthrough.config.json
node $S/scripts/assemble.mjs --config walkthrough.config.json
node $S/scripts/qa.mjs       --config walkthrough.config.json
```

### Expected output

```
walkthrough-out/
  vo/01-landing.wav          ~5.1 s     "This is example dot com... the domain the standards bodies reserve..."
  vo/02-close.wav            ~3.8 s     "The registry explains why it exists. That is the whole walkthrough."
  vo/src/*.aiff + *.json                the per-beat cache (aiff because the engine is `say`)
  vo/narration-spoken.txt               exactly what the voice read, with the engine and voice recorded
  takes/take1/raw.webm       ~11 s      the silent recording
  takes/take1/timings.json              01-landing@0.0  02-close@6.4  end@11.2
  deliverables/example-demo.mp4           11.5 s, 1920x1080, H.264 30 fps, AAC — ~540 KB
  deliverables/example-demo-captioned.mp4 same cut with burned-in captions — ~565 KB
  deliverables/example-demo.srt           4 caption cues (the ellipsis splits beat 1 into two)
  deliverables/thumbnail.png              a frame with a title band
  deliverables/narration-script.txt, README.md
  qa/frames/01-landing.png, 02-close.png
  qa/report.json
```

`qa.mjs` should print **8/8 checks passed**: audio and video the same length, `timings.end` matching the file, each
beat's speech starting 0.5 s (`voLead`) after its first frame within 0.25 s, each narration ending before the next beat,
and a frame extracted per beat. Beat 2 gets extended by ~0.3 s (its last frame frozen) because the narration outlasts the
recorded action — that is the hold-stretching working as designed.

Two harmless notes on running it with the stock template config: its `thumbnail.beat` is `03-result`, which this 2-beat
file does not have, so the thumbnail falls back to the middle beat; and its `spokenMap` entries simply never match.

Timings drift by a few tenths of a second between runs (network, `say` prosody); the QA tolerances allow for it.

Add `--frames` to `record.mjs` to capture the same take as a timestamped PNG sequence instead of a video — the path
Electron targets use. The assembled result is the same length.

## `electron-beats.example.json` — an Electron target

A shape reference, not a runnable demo: it needs your own built Electron app. Point the config at it:

```json
{
  "name": "example-app-tour",
  "target": { "type": "electron", "appPath": "dist/mac-arm64/Example App.app", "args": [], "cwd": "." },
  "outDir": "walkthrough-out"
}
```

or, for an unpackaged project, the local Electron binary:

```json
{ "target": { "type": "electron", "appPath": "node_modules/.bin/electron", "args": ["."], "cwd": "." } }
```

Then run the same four commands. Notice the beats have **no `goto`** — an Electron window is already loaded by the main
process, so you navigate with the app's own UI. The take lands in `takes/take1/frames/` instead of `raw.webm`; everything
downstream is identical.

Size the window to 1920x1080 in the app's own `BrowserWindow` options for a sharp recording. `record.mjs` asks the main
process to resize and warns if the window ended up a different size, in which case frames are letterboxed onto the canvas
at assembly.

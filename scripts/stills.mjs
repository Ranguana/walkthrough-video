// Still-frame beat assembly: turns screenshots (from the Claude-in-Chrome extension, the user's own browser, or record.mjs
// "screenshot" actions) into a silent clip that assemble.mjs splices into the take. Use it for the beats that must be captured
// in a real signed-in session where Playwright cannot go (a live third-party integration, a real user's browser profile).
//
// Usage:  node stills.mjs --config walkthrough.config.json [--shots shots.json]
//   shots.json (see templates/shots.example.json):  [{ "beat": "C1-connect", "shots": [{ "src": "stills/a.png", "halo": [x, y], "hold": 4.0, "fit": "card" | "full", "note": "..." }] }]
//   - src is relative to shots.json; halo is a click point in source-image pixels (draws the same cursor halo as record.mjs)
//   - hold is the seconds the shot is the current picture; shots crossfade over 0.3 s so each beat starts exactly at its cumulative hold
//   - fit "card" (default) scales the image to cfg.stillsFrameWidth (default viewport width - 160) on a neutral ground with a drop shadow; "full" fills the canvas
//   Every "beat" named here must exist in beats.json with "kind": "stills" so tts.mjs narrates it and assemble.mjs times it.
//
// Outputs: <outDir>/stills/frames/sNN.png, stills-silent.mp4, stills-timings.json, and stills-preview.mp4 (narrated, for QA) when vo clips exist.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { args, loadConfig, readBeats, readJson, writeJson, sh, q, probeDur } from './lib.mjs';

const cfg = loadConfig(args.config);
const shotsFile = args.shots && args.shots !== true ? path.resolve(args.shots) : cfg.stills;
if (!shotsFile || !fs.existsSync(shotsFile)) throw new Error('no shots.json: pass --shots or set "stills" in the config');
const plan = readJson(shotsFile); const shotsDir = path.dirname(shotsFile);
const beats = readBeats(cfg); const B = Object.fromEntries(beats.map(b => [b.id, b]));
for (const g of plan) if (!B[g.beat]) throw new Error(`shots.json beat ${g.beat} is not in beats.json (add it with "kind": "stills")`);
const out = cfg.dirs.stills, framesDir = path.join(out, 'frames'); fs.mkdirSync(framesDir, { recursive: true });
const { width: CW, height: CH } = cfg.viewport;
const FRAME_W = cfg.stillsFrameWidth || CW - 160;
const XF = 0.3, FPS = cfg.fps;

// ---- compose ----
const br = await chromium.launch(); const p = await br.newPage({ viewport: cfg.viewport, deviceScaleFactor: 1 });
const list = []; let n = 0;
for (const g of plan) for (const s of g.shots) {
  const file = path.resolve(shotsDir, s.src); const ext = path.extname(file).slice(1).toLowerCase();
  const data = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(file).toString('base64')}`;
  const nat = await p.evaluate((src) => new Promise(r => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight }); i.src = src; }), data);
  const full = s.fit === 'full';
  const W = full ? CW : FRAME_W, S = W / nat.w, H = full ? CH : Math.round(nat.h * S), X = full ? 0 : Math.round((CW - W) / 2), Y = full ? 0 : Math.round((CH - H) / 2);
  const halo = s.halo ? `<div style="position:absolute;left:${X + s.halo[0] * S}px;top:${Y + s.halo[1] * S}px;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgba(${cfg.halo.color},0.28);border:2px solid rgba(${cfg.halo.color},0.85);box-sizing:border-box"><div style="position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:#1a1a1a"></div></div>` : '';
  await p.setContent(`<style>html,body{margin:0;width:${CW}px;height:${CH}px;background:${cfg.stillsGround || '#e9e4dc'};overflow:hidden}
    .card{position:absolute;left:${X}px;top:${Y}px;width:${W}px;height:${H}px;${full ? '' : 'border-radius:12px;box-shadow:0 30px 70px rgba(28,22,16,0.30),0 4px 12px rgba(0,0,0,0.10);'}overflow:hidden;background:#fff}
    .card img{display:block;width:${W}px;height:${H}px}</style><div class="card"><img src="${data}"></div>${halo}`);
  const frame = path.join(framesDir, `s${String(n).padStart(2, '0')}.png`);
  await p.screenshot({ path: frame }); list.push({ ...s, beat: g.beat, frame }); n++;
}
await br.close();
writeJson(path.join(framesDir, 'list.json'), list);

// ---- build: holds + crossfades ----
const len = list.map((s, i) => s.hold + (i > 0 ? XF / 2 : 0) + (i < n - 1 ? XF / 2 : 0));
const inputs = list.map((s, i) => `-loop 1 -framerate ${FPS} -t ${len[i].toFixed(3)} -i ${q(s.frame)}`).join(' ');
let f = list.map((_, i) => `[${i}:v]format=yuv420p,settb=AVTB,fps=${FPS}[v${i}]`).join(';');
let prev = '[v0]', acc = 0;
if (n === 1) f += ';[v0]copy[vout]';
for (let i = 1; i < n; i++) { acc += len[i - 1]; const off = acc - XF * i; const lab = i === n - 1 ? '[vout]' : `[x${i}]`; f += `;${prev}[v${i}]xfade=transition=fade:duration=${XF}:offset=${off.toFixed(3)}${lab}`; prev = lab; }
fs.writeFileSync(path.join(out, 'filter.txt'), f);
const clip = path.join(out, 'stills-silent.mp4');
sh(`ffmpeg -y -loglevel error ${inputs} -filter_complex_script ${q(path.join(out, 'filter.txt'))} -map "[vout]" -r ${FPS} -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart ${q(clip)}`);
const timings = []; let t = 0, cur = null;
for (const s of list) { if (s.beat !== cur) { timings.push({ id: s.beat, start: +t.toFixed(3) }); cur = s.beat; } t += s.hold; }
timings.push({ id: 'end', start: +t.toFixed(3) });
writeJson(path.join(out, 'stills-timings.json'), timings);
const total = probeDur(clip);
const T = Object.fromEntries(timings.map(x => [x.id, x.start]));

// ---- narrated preview + slack report ----
const clips = plan.map(g => B[g.beat]).filter(b => b.dur > 0 && fs.existsSync(path.join(cfg.dirs.vo, `${b.id}.wav`))).map(b => ({ file: path.join(cfg.dirs.vo, `${b.id}.wav`), at: T[b.id] + cfg.voLead }));
if (clips.length) {
  const delays = clips.map((c, i) => `[${i}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[a${i}]`).join(';');
  const mix = clips.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total.toFixed(3)},volume=1.4[out]`;
  sh(`ffmpeg -y -loglevel error ${clips.map(c => `-i ${q(c.file)}`).join(' ')} -filter_complex "${delays};${mix}" -map "[out]" -ar 48000 -ac 2 -c:a aac -b:a 160k ${q(path.join(out, 'stills-audio.m4a'))}`);
  sh(`ffmpeg -y -loglevel error -i ${q(clip)} -i ${q(path.join(out, 'stills-audio.m4a'))} -map 0:v -map 1:a -c:v copy -c:a copy -movflags +faststart ${q(path.join(out, 'stills-preview.mp4'))}`);
}
for (const g of plan) { const b = B[g.beat]; const next = timings[timings.findIndex(x => x.id === b.id) + 1].start; const slack = next - T[b.id] - cfg.voLead - (b.dur || 0);
  console.log(`${b.id}: video ${(next - T[b.id]).toFixed(1)} s, narration ${(b.dur || 0).toFixed(1)} s, slack ${slack.toFixed(1)} s${slack < cfg.tail ? '  <-- TOO TIGHT: raise a hold' : ''}`); }
console.log(`composed ${n} frames -> ${clip} (${total.toFixed(1)} s). assemble.mjs will splice it in automatically.`);

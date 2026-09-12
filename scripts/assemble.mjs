// Assembles a take into the deliverables with ffmpeg:
//   1. raw.webm (or a timestamped frames/ sequence from an Electron/--frames take) -> 30 fps H.264 master
//   2. (optional) splice a still-frame clip (stills.mjs) before a beat, re-timing everything after it
//   3. extend any beat whose video is shorter than voLead + narration + tail by freezing its last frame (never speed audio up)
//   4. place each beat's narration voLead seconds after the beat's first frame, mix, mux
//   5. captions: SRT (timed per sentence/clause from the clip lengths) + a burned-in variant (PNG overlays, works without libass)
//   6. thumbnail (frame + optional title overlay) and a deliverables README.md
//
// Usage:  node assemble.mjs --config walkthrough.config.json [--take N|path] [--insert clip.mp4 --insert-timings t.json --before beatId] [--no-captions]
//   --take          which take (default: the latest under <outDir>/takes/)
//   --insert        a silent clip to splice in (default: <outDir>/stills/stills-silent.mp4 when it exists and beats.json has "kind": "stills" beats)
//   --before        beat id the clip goes in front of (default: the first recorded beat after the stills beats in beats.json order)
//
// Outputs: <outDir>/build/* (intermediates, timings-final.json) and <outDir>/deliverables/<name>.mp4, <name>-captioned.mp4,
//          <name>.srt, thumbnail.png, narration-script.txt, README.md
import fs from 'fs';
import path from 'path';
import { args, loadConfig, readBeats, resolveTake, readJson, writeJson, sh, q, probeDur, fmtClock, escHtml } from './lib.mjs';

const cfg = loadConfig(args.config);
const beats = readBeats(cfg);
const B = Object.fromEntries(beats.map(b => [b.id, b]));
const take = resolveTake(cfg, args.take);
const { build, deliverables, vo } = cfg.dirs;
fs.mkdirSync(build, { recursive: true }); fs.mkdirSync(deliverables, { recursive: true });
const name = cfg.name || 'walkthrough';
const VO_LEAD = cfg.voLead, TAIL = cfg.tail, FPS = cfg.fps;
const enc = `-r ${FPS} -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart`;
const ff = (c) => sh(`ffmpeg -y -loglevel error ${c}`, { echo: true });

let timings = readJson(path.join(take, 'timings.json'));
const order = () => { timings.sort((a, b) => a.start - b.start); return Object.fromEntries(timings.map(t => [t.id, t.start])); };
let T = order();
const known = (id) => id === 'end' || !!B[id];
for (const t of timings) if (!known(t.id)) console.warn(`timings has beat ${t.id} which is not in beats.json`);

// ---------- 1. Master ----------
// A take is either a video file (raw.webm, web recordVideo) or a timestamped PNG sequence
// (frames/ + index.json, from --frames or an Electron target). Frames are turned into a video with the
// concat demuxer, giving each frame its real measured duration so the timeline stays wall-clock exact.
const rawMaster = path.join(build, 'master-raw.mp4');
const rawWebm = path.join(take, 'raw.webm');
const framesIdx = path.join(take, 'frames', 'index.json');
if (fs.existsSync(rawWebm)) {
  ff(`-i ${q(rawWebm)} ${enc} ${q(rawMaster)}`);
} else if (fs.existsSync(framesIdx)) {
  const idx = readJson(framesIdx);
  const fr = idx.frames || [];
  if (!fr.length) throw new Error(`no frames listed in ${framesIdx}`);
  // The concat demuxer quotes with single quotes only (a literal ' is written '\''); double quotes are not special.
  const cq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < fr.length; i++) {
    const dur = (i + 1 < fr.length ? fr[i + 1].t - fr[i].t : Math.max(1 / (idx.fps || 8), (idx.end ?? fr[i].t) - fr[i].t));
    lines.push(`file ${cq(path.join(take, 'frames', fr[i].file))}`, `duration ${Math.max(0.001, dur).toFixed(4)}`);
  }
  lines.push(`file ${cq(path.join(take, 'frames', fr.at(-1).file))}`);   // concat demuxer needs the last file repeated
  const listFile = path.join(build, 'frames.ffconcat');
  fs.writeFileSync(listFile, lines.join('\n') + '\n');
  console.log(`building the master from ${fr.length} frames (${(fr.length / Math.max(idx.end || 1, 0.001)).toFixed(1)} fps effective) -> ${FPS} fps`);
  ff(`-f concat -safe 0 -i ${q(listFile)} -vf "scale=${cfg.viewport.width}:${cfg.viewport.height}:force_original_aspect_ratio=decrease,pad=${cfg.viewport.width}:${cfg.viewport.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}" ${enc} ${q(rawMaster)}`);
} else {
  throw new Error(`take has neither raw.webm nor frames/index.json: ${take}`);
}
let master = rawMaster;

// ---------- 2. Optional still-frame splice ----------
const stillBeats = beats.filter(b => b.kind === 'stills');
let insert = args.insert && args.insert !== true ? path.resolve(args.insert) : path.join(cfg.dirs.stills, 'stills-silent.mp4');
let insertT = args['insert-timings'] && args['insert-timings'] !== true ? path.resolve(args['insert-timings']) : path.join(cfg.dirs.stills, 'stills-timings.json');
if ((stillBeats.length || args.insert) && fs.existsSync(insert) && fs.existsSync(insertT)) {
  let before = args.before;
  if (!before) { const lastStill = beats.lastIndexOf(stillBeats.at(-1)); before = beats.slice(lastStill + 1).find(b => b.kind === 'record' && T[b.id] !== undefined)?.id || 'end'; }
  const cut = T[before]; if (cut === undefined) throw new Error(`--before ${before}: no such beat in the take`);
  const clipDur = probeDur(insert);
  const spliced = path.join(build, 'master-spliced.mp4');
  ff(`-i ${q(master)} -i ${q(insert)} -filter_complex "[0:v]trim=0:${cut.toFixed(3)},setpts=PTS-STARTPTS,fps=${FPS},scale=${cfg.viewport.width}:${cfg.viewport.height},setsar=1[a];[1:v]fps=${FPS},scale=${cfg.viewport.width}:${cfg.viewport.height},setsar=1[b];[0:v]trim=start=${cut.toFixed(3)},setpts=PTS-STARTPTS,fps=${FPS},scale=${cfg.viewport.width}:${cfg.viewport.height},setsar=1[c];[a][b][c]concat=n=3:v=1:a=0[v]" -map "[v]" ${enc} ${q(spliced)}`);
  for (const t of timings) if (t.start >= cut) t.start = +(t.start + clipDur).toFixed(3);
  for (const c of readJson(insertT)) if (c.id !== 'end') timings.push({ id: c.id, start: +(cut + c.start).toFixed(3) });
  T = order(); master = spliced;
  console.log(`spliced ${path.basename(insert)} (${clipDur.toFixed(1)} s) before ${before} at ${cut.toFixed(1)} s`);
} else if (stillBeats.length) {
  console.warn(`beats.json has ${stillBeats.length} "stills" beat(s) but no clip at ${insert}; run stills.mjs first. Continuing without them.`);
}

// ---------- 3. Extend holds where narration outgrew the video ----------
const seq = timings.filter(t => t.id !== 'end');
const endT = T.end ?? probeDur(master);
const extras = seq.map((t, i) => {
  const b = B[t.id]; const next = seq[i + 1]?.start ?? endT; const seg = next - t.start;
  const need = b && b.dur > 0 ? VO_LEAD + b.dur + TAIL : 0;
  return { id: t.id, from: t.start, to: next, extra: Math.max(0, +(need - seg).toFixed(3)) };
});
if (extras.some(e => e.extra > 0.01)) {
  const parts = extras.map((e, i) => `[0:v]trim=start=${e.from.toFixed(3)}:end=${e.to.toFixed(3)},setpts=PTS-STARTPTS${e.extra > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${e.extra.toFixed(3)}` : ''}[v${i}]`);
  const filter = parts.join(';') + ';' + extras.map((_, i) => `[v${i}]`).join('') + `concat=n=${extras.length}:v=1:a=0[v]`;
  fs.writeFileSync(path.join(build, 'extend-filter.txt'), filter);
  const extended = path.join(build, 'master-extended.mp4');
  ff(`-i ${q(master)} -filter_complex_script ${q(path.join(build, 'extend-filter.txt'))} -map "[v]" ${enc} ${q(extended)}`);
  let shift = 0; const shifted = [];
  for (const e of extras) { shifted.push({ id: e.id, start: +(e.from + shift).toFixed(3) }); if (e.extra > 0.01) console.log(`extended ${e.id} by ${e.extra.toFixed(2)} s (frozen last frame)`); shift += e.extra; }
  shifted.push({ id: 'end', start: +(endT + shift).toFixed(3) });
  timings = shifted; T = order(); master = extended;
  seq.length = 0; seq.push(...timings.filter(t => t.id !== 'end'));
}
const silent = path.join(build, 'master-silent.mp4');
if (master !== silent) fs.copyFileSync(master, silent);
const total = probeDur(silent);
writeJson(path.join(build, 'timings-final.json'), timings);

// ---------- 4. Audio ----------
const clips = seq.map(t => B[t.id]).filter(b => b && b.dur > 0).map(b => ({ id: b.id, file: path.join(vo, `${b.id}.wav`), at: T[b.id] + VO_LEAD }));
for (const c of clips) if (!fs.existsSync(c.file)) throw new Error(`missing narration clip ${c.file} — run tts.mjs`);
const final = path.join(deliverables, `${name}.mp4`);
if (clips.length) {
  const inputs = clips.map(c => `-i ${q(c.file)}`).join(' ');
  const delays = clips.map((c, i) => `[${i}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[a${i}]`).join(';');
  const mix = clips.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total.toFixed(3)},volume=1.4[out]`;
  ff(`${inputs} -filter_complex "${delays};${mix}" -map "[out]" -ar 48000 -ac 2 -c:a aac -b:a 160k ${q(path.join(build, 'audio.m4a'))}`);
  ff(`-i ${q(silent)} -i ${q(path.join(build, 'audio.m4a'))} -map 0:v -map 1:a -c:v copy -c:a copy -movflags +faststart ${q(final)}`);
} else {
  ff(`-i ${q(silent)} -f lavfi -i anullsrc=r=48000:cl=stereo -shortest -map 0:v -map 1:a -c:v copy -c:a aac -b:a 96k ${q(final)}`);
}

// ---------- 5. Captions ----------
const MAX = cfg.captions.maxChars;
const wordSplit = (text, max) => { const out = []; let cur = ''; for (const w of text.split(' ')) { if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; } if (cur) out.push(cur); return out; };
const chunk = (text) => {
  const sentences = text.split(/(?<=[.!?…])\s+(?=[A-Z"“])/).map(x => x.trim()).filter(Boolean); const out = [];
  for (const s of sentences) { if (s.length <= MAX) { out.push(s); continue; } let cur = '';
    for (const c of s.split(/(?<=[,;:…])\s+/)) { if (cur && (cur + ' ' + c).length > MAX) { out.push(cur); cur = c; } else cur = cur ? cur + ' ' + c : c; } if (cur) out.push(cur); }
  return out.flatMap(p => p.length <= MAX + 14 ? [p] : wordSplit(p, MAX));
};
const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`; };
let cues = [];
for (const c of clips) { const b = B[c.id]; const parts = chunk(b.text || b.spoken); const chars = parts.reduce((a, p) => a + p.length, 0); let t = c.at;
  for (const p of parts) { const d = b.dur * (p.length / chars); cues.push({ start: t, end: t + d - 0.05, text: p }); t += d; } }
fs.writeFileSync(path.join(deliverables, `${name}.srt`), cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n'));

if (cfg.captions.burnIn && !args['no-captions'] && cues.length) {
  const dir = path.join(build, 'caps'); fs.mkdirSync(dir, { recursive: true });
  const { chromium } = await import('playwright');
  const br = await chromium.launch(); const p = await br.newPage({ viewport: cfg.viewport, deviceScaleFactor: 1 });
  for (let i = 0; i < cues.length; i++) {
    await p.setContent(`<style>html,body{margin:0;background:transparent}.cap{position:fixed;left:50%;bottom:46px;transform:translateX(-50%);max-width:${Math.round(cfg.viewport.width * 0.78)}px;background:rgba(12,10,9,0.78);color:#fff;font:500 ${cfg.captions.fontSize}px/1.35 "Helvetica Neue",Helvetica,Arial,sans-serif;padding:12px 26px;border-radius:9px;text-align:center;text-shadow:0 1px 2px rgba(0,0,0,.6)}</style><div class="cap">${escHtml(cues[i].text)}</div>`);
    await p.screenshot({ path: path.join(dir, `c${i}.png`), omitBackground: true });
  }
  await br.close();
  const inputs = cues.map((_, i) => `-i ${q(path.join(dir, `c${i}.png`))}`).join(' ');
  let chain = '', prev = '[0:v]';
  cues.forEach((c, i) => { const lab = i === cues.length - 1 ? '[vout]' : `[t${i}]`; chain += `${prev}[${i + 1}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'${lab};\n`; prev = lab; });
  fs.writeFileSync(path.join(dir, 'filter.txt'), chain.replace(/;\n$/, ''));
  ff(`-i ${q(final)} ${inputs} -filter_complex_script ${q(path.join(dir, 'filter.txt'))} -map "[vout]" -map 0:a ${enc} -c:a copy ${q(path.join(deliverables, `${name}-captioned.mp4`))}`);
}

// ---------- 6. Thumbnail ----------
const th = cfg.thumbnail || {};
const thumbBeat = th.beat && T[th.beat] !== undefined ? th.beat : seq[Math.floor(seq.length / 2)]?.id;
const thumbAt = Math.min(total - 0.1, (T[thumbBeat] ?? 0) + (th.offset ?? 2.0));
const thumbSrc = path.join(build, 'thumb-source.png');
ff(`-ss ${thumbAt.toFixed(2)} -i ${q(silent)} -frames:v 1 ${q(thumbSrc)}`);
const thumbOut = path.join(deliverables, 'thumbnail.png');
if (th.title) {
  const { chromium } = await import('playwright');
  const br = await chromium.launch(); const p = await br.newPage({ viewport: cfg.viewport, deviceScaleFactor: 1 });
  const b64 = fs.readFileSync(thumbSrc).toString('base64');
  await p.setContent(`<style>html,body{margin:0;width:${cfg.viewport.width}px;height:${cfg.viewport.height}px;overflow:hidden;background:#f6f3ee}
    .bg{position:absolute;inset:0;background:url(data:image/png;base64,${b64}) center/cover no-repeat}
    .band{position:absolute;left:0;right:0;bottom:0;height:400px;background:linear-gradient(180deg,rgba(20,18,16,0) 0%,rgba(20,18,16,.88) 38%,rgba(20,18,16,.96) 100%)}
    .t{position:absolute;left:110px;right:110px;bottom:78px;color:#f6f1ea;font-family:Georgia,"Times New Roman",serif}
    .brand{font-size:44px;margin-bottom:14px;display:flex;align-items:center;gap:16px}
    .brand span{font:600 15px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;color:${cfg.card.accent};text-transform:uppercase;padding:7px 12px;border:1.5px solid ${cfg.card.accent};border-radius:6px}
    .h{font-size:74px;line-height:1.12;letter-spacing:-0.012em;max-width:1560px}</style>
    <div class="bg"></div><div class="band"></div><div class="t">${th.brand ? `<div class="brand">${escHtml(th.brand)}${th.badge ? `<span>${escHtml(th.badge)}</span>` : ''}</div>` : ''}<div class="h">${escHtml(th.title)}</div></div>`);
  await p.screenshot({ path: thumbOut }); await br.close();
} else fs.copyFileSync(thumbSrc, thumbOut);

// ---------- 7. Script + README ----------
const scriptLines = [`${name.toUpperCase()} — NARRATION SCRIPT (written form, first-frame timestamps in ${name}.mp4; narration starts ${VO_LEAD} s later)`, ''];
for (const t of seq) { const b = B[t.id]; if (!b) continue; scriptLines.push(`[${fmtClock(t.start)}  ${b.id}${b.screen ? ' — ' + b.screen : ''}]`, b.text || '(no narration)', ''); }
fs.writeFileSync(path.join(deliverables, 'narration-script.txt'), scriptLines.join('\n'));
const cfgRel = path.relative(deliverables, cfg.configFile);
const readme = `# ${name} — deliverables

Produced ${new Date().toISOString().slice(0, 10)} from ${cfg.baseUrl || `the Electron app at ${cfg.target.appPath}`} with the walkthrough-video skill. ${cfg.viewport.width}x${cfg.viewport.height}, H.264 ${FPS} fps, AAC 48 kHz stereo. Runs ${fmtClock(total)}.

| File | What it is |
|---|---|
| \`${name}.mp4\` | The walkthrough with narration, no burned-in captions. Upload this one and attach the SRT as the caption track. |
${cfg.captions.burnIn && !args['no-captions'] && cues.length ? `| \`${name}-captioned.mp4\` | Same cut with burned-in captions, for players that cannot load an SRT. |\n` : ''}| \`${name}.srt\` | Captions timed to the narration (written form). Do not rely on auto-captions for product/legal terms. |
| \`thumbnail.png\` | ${cfg.viewport.width}x${cfg.viewport.height} thumbnail from beat ${thumbBeat}. |
| \`narration-script.txt\` | The narration beat by beat with first-frame timestamps. |

## Beats

| Time | Beat | Screen | Narration |
|---|---|---|---|
${seq.map(t => { const b = B[t.id]; return b ? `| ${fmtClock(t.start)} | ${b.id} | ${b.screen || ''} | ${(b.text || '').replace(/\|/g, '\\|')} |` : ''; }).filter(Boolean).join('\n')}

## Re-render

From the folder containing \`${path.basename(cfg.configFile)}\` (config: \`${cfgRel}\`):

    node <skill>/scripts/tts.mjs --config ${path.basename(cfg.configFile)}          # narration -> vo/*.wav, durations into beats.json (cached per beat; unchanged beats are free)
    node <skill>/scripts/record.mjs --config ${path.basename(cfg.configFile)}       # new take -> takes/takeN/{raw.webm|frames/} + timings.json
    node <skill>/scripts/assemble.mjs --config ${path.basename(cfg.configFile)}     # this folder
    node <skill>/scripts/qa.mjs --config ${path.basename(cfg.configFile)}           # frames, onset check, duration match

To change a line: edit "text" in beats.json, run tts.mjs, then assemble.mjs. If the new clip is longer than its beat, assemble.mjs freezes the beat's last frame to fit (audio is never sped up); re-record for natural motion.
To replace the synthetic voice with a human read: record each beat as vo/<id>.wav (48 kHz stereo, leading silence < 0.1 s), set each beat's "dur" to the clip length, then run assemble.mjs (do not run tts.mjs again).

## Compliance

- Show fictional data only; say so in the narration.
- Keep your product's limitation ("this is a product demonstration with sample data", "not legal/tax/medical advice") spoken in the closing beat and shown on the closing card.
- If your product serves a regulated profession, check whether the video counts as professional advertising where you practise — labelling and retention may apply (see templates/narration-style.md in the skill).
- No API key, voice id or other credential should appear in the config, the beats file, the narration or these deliverables.
`;
fs.writeFileSync(path.join(deliverables, 'README.md'), readme);

// ---------- summary ----------
console.log(`\n${name}.mp4: ${fmtClock(total)} (${total.toFixed(1)} s), ${cues.length} caption cues`);
for (let i = 0; i < seq.length; i++) { const b = B[seq[i].id]; if (!b) continue; const next = seq[i + 1]?.start ?? T.end; const slack = next - seq[i].start - VO_LEAD - (b.dur || 0);
  console.log(`  ${fmtClock(seq[i].start).padStart(5)}  ${b.id.padEnd(18)} video ${(next - seq[i].start).toFixed(1).padStart(5)} s  narration ${(b.dur || 0).toFixed(1).padStart(5)} s  slack ${slack.toFixed(1).padStart(5)} s${slack < TAIL - 0.05 ? '  <-- TIGHT' : ''}`); }
console.log(`deliverables: ${deliverables}`);

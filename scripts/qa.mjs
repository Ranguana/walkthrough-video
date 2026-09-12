// QA for an assembled walkthrough: pulls a frame from every beat, checks that speech starts voLead after each beat's first
// frame (ffmpeg silencedetect), that every narration ends before the next beat, and that the audio and video tracks are the
// same length. Writes <outDir>/qa/frames/<beat>.png and <outDir>/qa/report.json; exits 1 on any failure.
//
// Usage:  node qa.mjs --config walkthrough.config.json [--video path.mp4] [--timings build/timings-final.json] [--tolerance 0.25]
import fs from 'fs';
import path from 'path';
import { args, loadConfig, readBeats, readJson, writeJson, sh, q, probeDur, fmtClock } from './lib.mjs';

const cfg = loadConfig(args.config);
const beats = readBeats(cfg); const B = Object.fromEntries(beats.map(b => [b.id, b]));
const name = cfg.name || 'walkthrough';
const video = args.video && args.video !== true ? path.resolve(args.video) : path.join(cfg.dirs.deliverables, `${name}.mp4`);
const timingsFile = args.timings && args.timings !== true ? path.resolve(args.timings) : path.join(cfg.dirs.build, 'timings-final.json');
const TOL = +(args.tolerance || 0.25);
if (!fs.existsSync(video)) throw new Error(`video not found: ${video}`);
if (!fs.existsSync(timingsFile)) throw new Error(`timings not found: ${timingsFile} (assemble.mjs writes it)`);
const timings = readJson(timingsFile).sort((a, b) => a.start - b.start);
const T = Object.fromEntries(timings.map(t => [t.id, t.start]));
const seq = timings.filter(t => t.id !== 'end');
const framesDir = path.join(cfg.dirs.qa, 'frames'); fs.mkdirSync(framesDir, { recursive: true });
const checks = [];
const check = (ok, what, detail) => { checks.push({ ok, what, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`); };

// 1. Track lengths
const vDur = probeDur(video, 'v'), aDur = probeDur(video, 'a');
check(Math.abs(vDur - aDur) <= 0.15, 'audio and video tracks are the same length', `video ${vDur.toFixed(2)} s, audio ${aDur.toFixed(2)} s`);
const endT = T.end ?? vDur;
check(Math.abs(endT - vDur) <= 0.5, 'timings "end" matches the video length', `timings ${endT.toFixed(2)} s, video ${vDur.toFixed(2)} s`);

// 2. Speech onsets (silence_end lines from silencedetect)
const log = sh(`ffmpeg -hide_banner -nostats -i ${q(video)} -af silencedetect=n=-38dB:d=0.35 -f null - 2>&1`, { quiet: true });
const onsets = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => +m[1]);
const silenceStarts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => +m[1]);
if (!silenceStarts.length || silenceStarts[0] > 0.05) onsets.unshift(0);   // audio does not begin with silence
const narrated = seq.filter(t => B[t.id] && B[t.id].dur > 0);
for (const t of narrated) {
  const b = B[t.id]; const expected = t.start + cfg.voLead;
  const nearest = onsets.reduce((best, o) => (Math.abs(o - expected) < Math.abs(best - expected) ? o : best), Infinity);
  check(Math.abs(nearest - expected) <= TOL, `${b.id}: narration starts ${cfg.voLead} s after the first frame`, `expected ${expected.toFixed(2)} s, nearest onset ${isFinite(nearest) ? nearest.toFixed(2) + ' s' : 'none'}`);
}

// 3. Narration fits inside its beat
for (let i = 0; i < seq.length; i++) {
  const b = B[seq[i].id]; if (!b || !(b.dur > 0)) continue;
  const next = seq[i + 1]?.start ?? endT; const ends = seq[i].start + cfg.voLead + b.dur;
  check(ends <= next - 0.1, `${b.id}: narration ends before the next beat`, `ends ${ends.toFixed(2)} s, next beat ${next.toFixed(2)} s, slack ${(next - ends).toFixed(2)} s`);
}

// 4. A frame from each beat (1 s in, or mid-beat for short beats)
for (let i = 0; i < seq.length; i++) {
  const next = seq[i + 1]?.start ?? endT; const at = Math.min(seq[i].start + 1.0, (seq[i].start + next) / 2);
  const out = path.join(framesDir, `${seq[i].id}.png`);
  try { sh(`ffmpeg -y -loglevel error -ss ${at.toFixed(2)} -i ${q(video)} -frames:v 1 ${q(out)}`, { quiet: true }); check(fs.existsSync(out) && fs.statSync(out).size > 1000, `${seq[i].id}: frame extracted at ${fmtClock(at)}`, path.relative(cfg.outDir, out)); }
  catch (e) { check(false, `${seq[i].id}: frame extraction`, String(e.message).split('\n')[0]); }
}

const failed = checks.filter(c => !c.ok).length;
writeJson(path.join(cfg.dirs.qa, 'report.json'), { video, checkedAt: new Date().toISOString(), videoDuration: vDur, audioDuration: aDur, onsets, checks });
console.log(`\n${checks.length - failed}/${checks.length} checks passed. Frames in ${framesDir} — open them and look at every beat before publishing.`);
process.exit(failed ? 1 : 0);

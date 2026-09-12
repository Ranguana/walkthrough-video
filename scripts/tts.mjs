// Renders the narration one clip per beat: <outDir>/vo/<id>.wav (48 kHz stereo PCM, leading silence trimmed so speech
// starts on the voLead) plus a cached source clip under <outDir>/vo/src/<id>.{mp3,aiff} and a .json sidecar — a beat whose
// spoken text and voice settings have not changed is never re-synthesized (and never re-billed). Writes each clip's length
// into beats.json ("dur") and the spoken form into "spoken"; assemble.mjs and record.mjs read those.
//
// Two engines:
//   elevenlabs  (default when credentials are present) — hosted neural voice, billed per character
//   say         (macOS built-in `say`, free, no network) — used automatically when no ElevenLabs credentials are set
// Force one with --engine say | --engine elevenlabs, or "voice": { "engine": "say" } in the config.
//
// Usage:  node tts.mjs --config walkthrough.config.json [--dry-run] [--force] [--only 01-hook,02-demo] [--engine say]
//   --dry-run   print the spoken text and character counts; call nothing
//   --force     re-synthesize even when cached, and ignore the character budget
//   --only      comma-separated beat ids
//   --engine    "say" or "elevenlabs"; default: elevenlabs when credentials exist, else say
//
// Credentials (ElevenLabs engine only): ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID, looked up in this order —
//   1. the process environment   2. cfg.envFile (default ./.env.local)   3. ~/.config/walkthrough-video/.env (shared, chmod 600)
// They are never printed. The `say` engine needs no credentials and no network.
//
// Text handling: beats.json "text" is the written/caption form. The spoken form is derived by:
//   1. cfg.spokenMap  — [["SKU-4120", "S K U four one two zero"], ...] (regex source, replacement; applied in order)
//   2. built-ins       — "…" -> "..." (ElevenLabs pauses on three dots), URLs "example.com/demo" -> "example dot com slash demo"
// A beat may instead carry its own "spoken" override (kept verbatim, apart from the "…" rule). Beats with a "spokenDerived": true
// flag are re-derived from "text" on every run, so editing "text" is enough.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { args, loadConfig, loadEnv, readBeats, writeBeats, sh, q, fileDur, SHARED_ENV } from './lib.mjs';

const cfg = loadConfig(args.config);
loadEnv(cfg);
const DRY = !!args['dry-run'], FORCE = !!args.force;
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const API_KEY = process.env.ELEVENLABS_API_KEY, VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const V = cfg.voice;
// Engine: explicit flag > config > ElevenLabs if credentials exist > macOS `say`.
const HAVE_11 = !!(API_KEY && VOICE_ID);
const ENGINE = (args.engine && String(args.engine)) || V.engine || (HAVE_11 ? 'elevenlabs' : 'say');
if (!['elevenlabs', 'say'].includes(ENGINE)) { console.error(`unknown --engine ${ENGINE} (expected "elevenlabs" or "say")`); process.exit(1); }
if (ENGINE === 'elevenlabs' && !HAVE_11) {
  console.error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set. Looked in, in order:');
  console.error(`  1. the process environment\n  2. ${cfg.envFile}\n  3. ${SHARED_ENV}`);
  console.error('Set them in one of those, or use the free local voice with --engine say (macOS).');
  process.exit(1);
}
if (ENGINE === 'say' && !DRY) {
  if (process.platform !== 'darwin') {
    console.error('The "say" engine needs macOS. On Linux/Windows either set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID,');
    console.error('or render vo/<id>.wav yourself (any TTS or a human voice) and set "dur" per beat in beats.json.');
    process.exit(1);
  }
  if (!HAVE_11) console.log('No ElevenLabs credentials found — narrating with the macOS `say` voice (free, offline).');
}
const spokenMap = (cfg.spokenMap || []).map(([re, rep]) => [new RegExp(re, 'g'), rep]);
const humanizeUrl = (t) => !V.humanizeUrls ? t : t
  .replace(/\b([a-z0-9-]+)\.(com|org|net|io|law|co|app|dev)(\/[a-z0-9-]+)?\b/gi, (m, host, tld, p) => `${host} dot ${tld}${p ? ' slash ' + p.slice(1) : ''}`);
const derive = (text) => humanizeUrl(spokenMap.reduce((t, [re, rep]) => t.replace(re, rep), text)).replace(/…/g, '...').replace(/\s+/g, ' ').trim();
const spokenFor = (b) => {
  if (b.spoken && !b.spokenDerived) return b.spoken.replace(/…/g, '...').trim();
  return derive(b.text || '');
};

const beats = readBeats(cfg);
const voDir = cfg.dirs.vo, srcDir = path.join(voDir, 'src');
fs.mkdirSync(srcDir, { recursive: true });
const SRC_EXT = ENGINE === 'say' ? 'aiff' : 'mp3';
const settingsHash = crypto.createHash('sha1')
  .update(JSON.stringify(ENGINE === 'say'
    ? { ENGINE, voice: V.sayVoice, rate: V.sayRate }
    : { ENGINE, model: V.modelId, fmt: V.outputFormat, s: V.settings, VOICE_ID }))
  .digest('hex').slice(0, 10);

const subscription = async () => {
  if (ENGINE !== 'elevenlabs') return null;
  try { const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': API_KEY } }); if (!r.ok) return null;
    const j = await r.json(); return { used: j.character_count, limit: j.character_limit, tier: j.tier, resets: j.next_character_count_reset_unix }; } catch { return null; }
};
const synthesize = async (text, prev, next) => {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${V.outputFormat}`;
  const body = { text, model_id: V.modelId, voice_settings: V.settings };
  if (prev) body.previous_text = prev; if (next) body.next_text = next;   // prosody continuity across beats
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    if (r.ok) return { bytes: Buffer.from(await r.arrayBuffer()), charCost: r.headers.get('x-character-count') || r.headers.get('character-cost') };
    const msg = (await r.text()).slice(0, 300);
    if (r.status === 429 || r.status >= 500) { console.warn(`  attempt ${attempt}: HTTP ${r.status} — retrying`); await new Promise(s => setTimeout(s, 2000 * attempt)); continue; }
    throw new Error(`ElevenLabs HTTP ${r.status}: ${msg}`);
  }
  throw new Error('ElevenLabs: gave up after 3 attempts');
};
// macOS `say`: text goes in via a temp file so nothing has to be shell-escaped. Writes AIFF.
const saySynthesize = (text, outFile) => {
  const tmp = path.join(srcDir, `.say-${process.pid}.txt`);
  fs.writeFileSync(tmp, text);
  try {
    const voice = V.sayVoice ? ` -v ${q(V.sayVoice)}` : '';
    const rate = V.sayRate ? ` -r ${Number(V.sayRate)}` : '';
    sh(`say${voice}${rate} -f ${q(tmp)} -o ${q(outFile)}`, { quiet: true });
  } finally { fs.rmSync(tmp, { force: true }); }
};
// source clip (mp3 or aiff) -> 48 kHz stereo WAV; leading silence trimmed to <= 60 ms (so onset lands on voLead), trailing to ~250 ms (so "dur" is the spoken length).
const toWav = (mp3, wav) => sh(`ffmpeg -y -loglevel error -i ${q(mp3)} -af "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.25,areverse" -ar 48000 -ac 2 -c:a pcm_s16le ${q(wav)}`);

// ---- plan ----
const plan = beats.map(b => {
  const spoken = spokenFor(b); const key = crypto.createHash('sha1').update(spoken + '|' + settingsHash).digest('hex');
  const mp3 = path.join(srcDir, `${b.id}.${SRC_EXT}`), side = path.join(srcDir, `${b.id}.json`), wav = path.join(voDir, `${b.id}.wav`);
  const cached = fs.existsSync(mp3) && fs.existsSync(side) && (() => { try { return JSON.parse(fs.readFileSync(side, 'utf8')).key === key; } catch { return false; } })();
  const wanted = !ONLY || ONLY.has(b.id);
  return { b, spoken, key, mp3, side, wav, cached, needs: wanted && spoken.length > 0 && (FORCE || !cached) };
});
const totalChars = plan.reduce((a, p) => a + p.spoken.length, 0);
const toSend = plan.filter(p => p.needs).reduce((a, p) => a + p.spoken.length, 0);

if (DRY) {
  for (const p of plan) console.log(`[${p.b.id}] ${p.spoken.length} chars${p.cached ? ' (cached)' : ''}\n  ${p.spoken || '(no narration)'}`);
  console.log(`\nEngine: ${ENGINE}${ENGINE === 'say' ? ' (free, local)' : ''}`);
  console.log(`Total spoken characters: ${totalChars}; would render now: ${toSend}${ENGINE === 'elevenlabs' ? `; budget (voice.maxChars): ${V.maxChars}` : ''}`);
  process.exit(0);
}
// The character budget only guards a billed engine; `say` is free.
if (ENGINE === 'elevenlabs' && toSend > V.maxChars && !FORCE) { console.error(`Refusing to send ${toSend} characters (> voice.maxChars ${V.maxChars}). Shorten the script, raise the budget, or pass --force.`); process.exit(1); }
const before = await subscription();
if (before) {
  console.log(`ElevenLabs ${before.tier}: ${before.used.toLocaleString()} / ${before.limit.toLocaleString()} characters used before this run; sending ${toSend}`);
  if (before.limit - before.used < toSend && !FORCE) { console.error('Not enough characters left in the ElevenLabs quota for this run.'); process.exit(1); }
}

// ---- render ----
let sent = 0;
for (let i = 0; i < plan.length; i++) {
  const p = plan[i], b = p.b;
  if (!p.spoken) { b.dur = 0; b.spoken = ''; console.log(`[${b.id}] no narration`); continue; }
  if (p.needs) {
    process.stdout.write(`[${b.id}] synthesizing ${p.spoken.length} chars (${ENGINE})… `);
    let charCost = null, meta;
    if (ENGINE === 'say') {
      saySynthesize(p.spoken, p.mp3);
      meta = { engine: 'say', sayVoice: V.sayVoice || '(system default)', sayRate: V.sayRate || null };
    } else {
      const prev = plan[i - 1]?.spoken || undefined, next = plan[i + 1]?.spoken || undefined;
      const res = await synthesize(p.spoken, prev, next);
      fs.writeFileSync(p.mp3, res.bytes); charCost = res.charCost;
      meta = { engine: 'elevenlabs', model_id: V.modelId, voice_settings: V.settings, output_format: V.outputFormat, charCost };
    }
    fs.writeFileSync(p.side, JSON.stringify({ key: p.key, spoken: p.spoken, ...meta, at: new Date().toISOString() }, null, 1));
    sent += p.spoken.length; toWav(p.mp3, p.wav);
    console.log(`${fileDur(p.wav).toFixed(2)} s${charCost ? ` (billed ${charCost})` : ''}`);
  } else if (fs.existsSync(p.mp3) && (!fs.existsSync(p.wav) || FORCE)) {
    toWav(p.mp3, p.wav); console.log(`[${b.id}] cached clip -> wav ${fileDur(p.wav).toFixed(2)} s`);
  } else if (fs.existsSync(p.wav)) {
    console.log(`[${b.id}] unchanged (${fileDur(p.wav).toFixed(2)} s)`);
  } else { console.log(`[${b.id}] skipped (--only) and no clip yet`); continue; }
  b.dur = +fileDur(p.wav).toFixed(3);
  if (!b.spoken || b.spokenDerived) { b.spoken = p.spoken; b.spokenDerived = true; }
}
writeBeats(cfg, beats);

// Spoken-form script for the record (what the voice actually read).
const lines = [
  `${(cfg.name || 'walkthrough').toUpperCase()} — SPOKEN-FORM NARRATION`,
  ENGINE === 'say'
    ? `Rendered ${new Date().toISOString().slice(0, 10)} with the macOS "say" voice (${V.sayVoice || 'system default'}${V.sayRate ? `, ${V.sayRate} wpm` : ''}).`
    : `Rendered ${new Date().toISOString().slice(0, 10)} with ElevenLabs voice "${V.label}" (model ${V.modelId}, stability ${V.settings.stability}, similarity ${V.settings.similarity_boost}, style ${V.settings.style}, speaker boost ${V.settings.use_speaker_boost ? 'on' : 'off'}).`,
  `Each beat is the exact text sent to the voice ("..." marks a breath). Captions use the written form in ${path.basename(cfg.beatsFile)} -> "text".`,
  `Narration starts ${cfg.voLead} s after each beat's first frame.`, '',
  ...beats.filter(b => b.spoken).flatMap(b => [`[${b.id}${b.screen ? ' — ' + b.screen : ''}]  (${(b.dur || 0).toFixed(2)} s)`, b.spoken, '']),
  `Characters (all beats): ${totalChars}.`,
];
fs.writeFileSync(path.join(voDir, 'narration-spoken.txt'), lines.join('\n'));

const after = await subscription();
console.log(`\nEngine: ${ENGINE}. Characters in script: ${totalChars}; rendered this run: ${sent}${ENGINE === 'say' ? ' (free, nothing billed)' : ''}.`);
if (before && after) console.log(`ElevenLabs quota: ${after.used.toLocaleString()} / ${after.limit.toLocaleString()} used (this run: +${(after.used - before.used).toLocaleString()}); resets ${new Date(after.resets * 1000).toISOString().slice(0, 10)}.`);
console.log('Per-beat durations (s): ' + beats.map(b => `${b.id}=${(b.dur || 0).toFixed(2)}`).join('  '));
console.log(`Next: node record.mjs --config ${path.relative(process.cwd(), cfg.configFile) || cfg.configFile}   (each beat is held at least voLead + dur + pad)`);

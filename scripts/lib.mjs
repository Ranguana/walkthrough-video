// Shared helpers for the walkthrough-video scripts: CLI args, config, env, shell, ffprobe, beats/takes I/O.
// Every path in walkthrough.config.json is resolved relative to the config file, so the scripts can be run
// from anywhere:  node ~/.claude/skills/walkthrough-video/scripts/record.mjs --config path/to/walkthrough.config.json
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';

export const parseArgs = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { out[k] = nxt; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
};
export const args = parseArgs(process.argv.slice(2));

// Credentials are looked for in this order: the process environment wins, then the project's envFile
// (default ./.env.local next to the config), then this shared per-user file. Values are never logged.
export const SHARED_ENV = path.join(os.homedir(), '.config', 'walkthrough-video', '.env');

const DEFAULTS = {
  name: 'walkthrough',            // base name of the deliverables (<name>.mp4, <name>.srt, ...)
  // What is being recorded — a web page in Chromium, or an Electron desktop app:
  //   { "type": "web", "baseUrl": "https://example.com" }
  //   { "type": "electron", "appPath": "/path/to/app", "args": ["."], "cwd": "/path/to/project" }
  // A top-level "baseUrl" is shorthand for a web target and still works on its own.
  target: { type: 'web', baseUrl: null, appPath: null, args: [], cwd: null, env: {} },
  baseUrl: null,                  // shorthand for target.baseUrl: "https://example.com"
  viewport: { width: 1920, height: 1080 },
  fps: 30,
  framesFps: 8,                   // frame-capture rate for --frames / Electron takes (screenshots cannot reach 30)
  outDir: 'walkthrough-out',      // takes/, vo/, build/, deliverables/, qa/ live under here
  beats: 'beats.json',
  envFile: '.env.local',          // project env file; searched after process.env and before ~/.config/walkthrough-video/.env. Never printed
  storageState: null,             // optional Playwright storageState JSON for an already signed-in session
  voLead: 0.5,                    // narration starts this many seconds after a beat's first frame
  tail: 0.8,                      // minimum silence after a beat's narration before the next beat starts
  pad: 0.8,                       // default per-beat pad used by record.mjs when holding a beat
  dialogs: 'accept',              // what to do with window.confirm()/alert() in headless Chromium: accept | dismiss
  halo: { color: '214, 93, 30', size: 34 },   // cursor halo (video-only overlay)
  voice: {
    label: 'Narrator',
    engine: null,                 // "elevenlabs" | "say" | null (auto: ElevenLabs when credentials exist, else macOS `say`)
    sayVoice: null,               // `say` engine: a voice name from `say -v ?` (e.g. "Samantha"); null = system default
    sayRate: null,                // `say` engine: words per minute (e.g. 170); null = the voice's default
    modelId: 'eleven_multilingual_v2',
    outputFormat: 'mp3_44100_128',
    settings: { stability: 0.45, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
    maxChars: 6000,               // refuse to synthesize more than this in one run unless --force
    humanizeUrls: true,           // "example.com/demo" -> "example dot com slash demo" in the spoken form
  },
  spokenMap: [],                  // [["SKU-4120", "S K U four one two zero"], ...] written form -> spoken form (regex source, replacement)
  captions: { burnIn: true, maxChars: 70, fontSize: 27 },
  card: { brand: null, accent: '#f0b48a', background: 'rgba(20,18,16,0.94)' },  // defaults for the "card" action
  thumbnail: null,                // { beat, offset, title, brand, badge } or null
  stills: null,                   // path to a shots.json for still-frame beats (see stills.mjs) or null
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = isObj(a?.[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : b[k]; return o; };
// DEFAULTS is deep-cloned before every merge: a shallow spread would hand out the same nested objects
// (target, voice, halo…) to every config loaded in the process, and later edits would leak between them.
const withDefaults = (obj) => deepMerge(structuredClone(DEFAULTS), obj);

export function loadConfig(flag) {
  const file = path.resolve(flag || process.env.WALKTHROUGH_CONFIG || 'walkthrough.config.json');
  if (!fs.existsSync(file)) throw new Error(`config not found: ${file}  (copy templates/walkthrough.config.example.json and edit it)`);
  const cfg = withDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
  cfg.configFile = file; cfg.configDir = path.dirname(file);
  const rel = (p) => (p ? path.resolve(cfg.configDir, p) : p);

  // Target: a top-level baseUrl is shorthand for a web target; validate whichever type is in play.
  const t = cfg.target;
  if (cfg.baseUrl && !t.baseUrl) t.baseUrl = cfg.baseUrl;
  if (!['web', 'electron'].includes(t.type)) throw new Error(`target.type must be "web" or "electron" (got ${JSON.stringify(t.type)})`);
  if (t.type === 'web') {
    if (!t.baseUrl) throw new Error('a web target needs "baseUrl" (top level or target.baseUrl), e.g. "https://example.com"');
    cfg.baseUrl = t.baseUrl;
  } else {
    if (!t.appPath) throw new Error('an electron target needs target.appPath (the app bundle/binary, or the local electron binary with args ["."])');
    t.appPath = rel(t.appPath); t.cwd = rel(t.cwd) || cfg.configDir;
    if (!fs.existsSync(t.appPath)) throw new Error(`target.appPath does not exist: ${t.appPath}`);
    if (!Array.isArray(t.args)) throw new Error('target.args must be an array of strings');
    cfg.baseUrl = null;             // an Electron window has no base URL; "goto" actions are not available
  }

  cfg.outDir = rel(cfg.outDir); cfg.beatsFile = rel(cfg.beats); cfg.envFile = rel(cfg.envFile);
  cfg.storageState = rel(cfg.storageState); cfg.stills = rel(cfg.stills);
  cfg.dirs = {
    takes: path.join(cfg.outDir, 'takes'), vo: path.join(cfg.outDir, 'vo'), build: path.join(cfg.outDir, 'build'),
    deliverables: path.join(cfg.outDir, 'deliverables'), qa: path.join(cfg.outDir, 'qa'), stills: path.join(cfg.outDir, 'stills'),
  };
  return cfg;
}

// Reads one env file into process.env without overriding anything already set. Values are never logged.
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return false;
  try {
    const require = createRequire(import.meta.url);
    require('dotenv').config({ path: file, override: false, quiet: true });
  } catch {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!m) continue;
      let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
  return true;
}

// Credential lookup order, first hit wins per variable:
//   1. the process environment (already set — never overridden)
//   2. cfg.envFile, the project's own file (default ./.env.local next to the config)
//   3. ~/.config/walkthrough-video/.env, the shared per-user file (chmod 600; put the key here once)
// Returns the list of files that were read, for logging the *paths* only. Values are never logged.
export function loadEnv(cfg) {
  const read = [];
  if (loadEnvFile(cfg?.envFile)) read.push(cfg.envFile);
  if (loadEnvFile(SHARED_ENV)) read.push(SHARED_ENV);
  return read;
}

export const sh = (cmd, { quiet = false, echo = false } = {}) => {
  if (echo) console.log('$', cmd.length > 240 ? cmd.slice(0, 240) + '…' : cmd);
  return execSync(cmd, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }).toString();
};
export const q = (p) => `"${String(p).replace(/(["\\$`])/g, '\\$1')}"`;
// Stream duration (v = video, a = audio) rather than container duration.
export const probeDur = (file, stream = 'v') => parseFloat(sh(`ffprobe -v error -select_streams ${stream}:0 -show_entries stream=duration -of csv=p=0 ${q(file)}`, { quiet: true }).trim()) || 0;
export const fileDur = (file) => parseFloat(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(file)}`, { quiet: true }).trim()) || 0;

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n'); };
export const readBeats = (cfg) => {
  if (!fs.existsSync(cfg.beatsFile)) throw new Error(`beats file not found: ${cfg.beatsFile} (copy templates/beats.example.json)`);
  const beats = readJson(cfg.beatsFile);
  if (!Array.isArray(beats) || !beats.length) throw new Error('beats.json must be a non-empty array');
  const seen = new Set();
  for (const b of beats) { if (!b.id) throw new Error('every beat needs an "id"'); if (seen.has(b.id)) throw new Error(`duplicate beat id ${b.id}`); seen.add(b.id); b.kind = b.kind || 'record'; }
  return beats;
};
// beats.json stays hand-editable: one action per line, scalar fields on their own lines.
const formatBeat = (b) => {
  const lines = [];
  for (const [k, v] of Object.entries(b)) {
    if (k === 'actions' && Array.isArray(v)) lines.push(`  "actions": [\n${v.map(a => '   ' + JSON.stringify(a)).join(',\n')}\n  ]`);
    else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  return ` {\n${lines.join(',\n')}\n }`;
};
export const writeBeats = (cfg, beats) => {
  const clean = beats.map(({ kind, ...b }) => (kind === 'record' ? b : { ...b, kind }));
  fs.writeFileSync(cfg.beatsFile, `[\n${clean.map(formatBeat).join(',\n')}\n]\n`);
};

export const listTakes = (cfg) => (fs.existsSync(cfg.dirs.takes) ? fs.readdirSync(cfg.dirs.takes).filter(d => /^take\d+$/.test(d)).map(d => +d.slice(4)).sort((a, b) => a - b) : []);
export const takeDir = (cfg, n) => path.join(cfg.dirs.takes, `take${n}`);
export const resolveTake = (cfg, flag) => {
  if (flag && String(flag).includes('/')) return path.resolve(flag);
  if (flag && flag !== true) return takeDir(cfg, flag);
  const takes = listTakes(cfg); if (!takes.length) throw new Error('no takes yet: run record.mjs first');
  return takeDir(cfg, takes[takes.length - 1]);
};

export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  // Typography for the thumbnail title and burned-in captions. record.mjs (or brand.mjs) discovers the app's own fonts
  // into takes/takeN/brand.json; anything set here wins over what was discovered. All optional.
  brand: {
    headingFont: null,            // CSS font-family for the thumbnail brand + title, e.g. "Bebas Neue"
    bodyFont: null,               // CSS font-family for captions, e.g. "Lato"
    headingWeight: null,          // e.g. 700; default: discovered weight
    headingTransform: null,       // "uppercase" | "none" | ...; default: discovered text-transform
    headingLetterSpacing: null,   // any CSS length, e.g. "0.02em"; default: discovered letter-spacing
    fontCss: [],                  // stylesheet URLs to load (Google Fonts css2 links); added to the discovered ones
    fontFiles: [],                // local font files: "fonts/BebasNeue-Regular.woff2" or { "family": "Bebas Neue", "weight": 400, "style": "normal", "file": "fonts/x.woff2" }
  },
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
  cfg.brand.fontFiles = (cfg.brand.fontFiles || []).map(f => (typeof f === 'string' ? { file: rel(f) } : { ...f, file: rel(f.file) }));
  cfg.brand.fontCss = cfg.brand.fontCss || [];
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

// ---------- brand fonts ----------
// The thumbnail title and the burned-in captions are rendered by Playwright from HTML, so they can be set in the same
// faces the recorded app uses. record.mjs (and brand.mjs) run BRAND_PROBE inside the app's page and write the result to
// takes/takeN/brand.json; assemble.mjs merges cfg.brand over it (config wins) and injects the fonts into its render pages.

// Runs INSIDE the page (page.evaluate) — plain DOM only, nothing from this module is in scope there.
// Returns { heading, body, stylesheets, fontFaces, fonts, errors }.
export const BRAND_PROBE = () => {
  const out = { heading: null, body: null, stylesheets: [], fontFaces: [], fonts: [], errors: [] };
  const unq = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  const abs = (u, base) => { try { return new URL(u, base || document.baseURI).href; } catch { return u; } };
  try {
    const el = document.querySelector('h1') || document.querySelector('h2') || document.body;
    const s = getComputedStyle(el);
    out.heading = { tag: el.tagName.toLowerCase(), family: s.fontFamily, weight: s.fontWeight, transform: s.textTransform, letterSpacing: s.letterSpacing, fontSize: s.fontSize };
  } catch (e) { out.errors.push('heading: ' + (e.message || e)); }
  try { out.body = { family: getComputedStyle(document.body).fontFamily }; } catch (e) { out.errors.push('body: ' + (e.message || e)); }
  try { for (const l of document.querySelectorAll('link[rel~="stylesheet"][href]')) if (/fonts\.googleapis\.com/.test(l.href)) out.stylesheets.push(l.href); } catch (e) { out.errors.push('links: ' + (e.message || e)); }
  const IMPORT = 3, FONT_FACE = 5;
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r.type === IMPORT) {
        const href = abs(r.href, base); if (/fonts\.googleapis\.com/.test(href)) out.stylesheets.push(href);
        try { if (r.styleSheet?.cssRules) walk(r.styleSheet.cssRules, r.styleSheet.href || base); } catch { /* cross-origin import */ }
      } else if (r.type === FONT_FACE) {
        const st = r.style;
        const src = (st.getPropertyValue('src') || '').replace(/url\((["']?)([^"')]+)\1\)/g, (_, qq, u) => `url("${abs(u, base)}")`);
        out.fontFaces.push({ family: unq(st.getPropertyValue('font-family')), weight: st.getPropertyValue('font-weight') || '400', style: st.getPropertyValue('font-style') || 'normal',
          unicodeRange: st.getPropertyValue('unicode-range') || '', src });
      } else if (r.cssRules) walk(r.cssRules, base);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }    // cross-origin stylesheet: not readable, skip
    try { walk(rules, sheet.href || document.baseURI); } catch (e) { out.errors.push('sheet ' + (sheet.href || 'inline') + ': ' + (e.message || e)); }
  }
  try { for (const f of document.fonts) out.fonts.push({ family: unq(f.family), weight: f.weight, style: f.style, status: f.status }); } catch (e) { out.errors.push('document.fonts: ' + (e.message || e)); }
  out.stylesheets = [...new Set(out.stylesheets)];
  return out;
};

export const EMPTY_BRAND = { heading: null, body: null, stylesheets: [], fontFaces: [], fonts: [] };

// Probes a live Playwright page and writes brand.json. Never throws: on failure the file has nulls and an "error" field.
export async function discoverBrand(page, file) {
  let brand, error = null;
  try {
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
    brand = await page.evaluate(BRAND_PROBE);
  } catch (e) { error = String(e.message || e).split('\n')[0]; brand = null; }
  let url = null; try { url = page.url(); } catch { /* closed */ }
  const out = { ...structuredClone(EMPTY_BRAND), ...(brand || {}), url, discoveredAt: new Date().toISOString(), error };
  if (file) writeJson(file, out);
  return out;
}

// "__Bebas_Neue_5f8a1c, __Bebas_Neue_Fallback_5f8a1c, \"Bebas Neue\", Impact" -> ["__Bebas_Neue_5f8a1c", ...]
export const splitFamilies = (stack) => String(stack || '').match(/"[^"]*"|'[^']*'|[^,]+/g)?.map(f => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean) || [];
// A readable name for the summary line: next/font hashes ("__Bebas_Neue_5f8a1c") become "Bebas Neue"; fallback faces are skipped.
export const prettyFamily = (stack) => {
  const fams = splitFamilies(stack); const f = fams.find(x => !/fallback/i.test(x)) || fams[0] || '';
  return f.replace(/^__/, '').replace(/_[0-9a-f]{6,}$/i, '').replace(/_/g, ' ').trim();
};

// Merges cfg.brand (wins) over takes/takeN/brand.json (discovered) into one object assemble.mjs can render from.
// source per role is "config" | "discovered" | "fallback" — the fallback faces are the pre-brand defaults (Georgia / Helvetica).
export function resolveBrand(cfg, take) {
  const file = take ? path.join(take, 'brand.json') : null;
  const disc = file && fs.existsSync(file) ? readJson(file) : null;
  const c = cfg.brand || {};
  const pick = (cfgVal, discVal) => (cfgVal ? { family: cfgVal, source: 'config' } : discVal ? { family: discVal, source: 'discovered' } : { family: null, source: 'fallback' });
  const dh = disc?.heading || {};
  const emSpacing = () => { const ls = parseFloat(dh.letterSpacing), fs_ = parseFloat(dh.fontSize); return Number.isFinite(ls) && ls !== 0 && fs_ > 0 ? `${(ls / fs_).toFixed(4)}em` : null; };
  const heading = { ...pick(c.headingFont, dh.family),
    weight: c.headingWeight ?? (dh.weight && dh.weight !== 'normal' ? dh.weight : null),
    transform: c.headingTransform ?? (dh.transform && dh.transform !== 'none' ? dh.transform : null),
    letterSpacing: c.headingLetterSpacing ?? emSpacing() };
  const body = pick(c.bodyFont, disc?.body?.family);
  heading.primary = heading.family ? prettyFamily(heading.family) : null;
  body.primary = body.family ? prettyFamily(body.family) : null;
  // Only inline the @font-face rules the thumbnail/captions can actually use (icon fonts etc. stay out of the render pages).
  const wanted = new Set([...splitFamilies(heading.family), ...splitFamilies(body.family)].map(f => f.toLowerCase()));
  const fontFaces = (disc?.fontFaces || []).filter(f => f.src && (!wanted.size || wanted.has(String(f.family).toLowerCase())));
  return { heading, body, stylesheets: [...new Set([...(c.fontCss || []), ...(disc?.stylesheets || [])])], fontFaces, fontFiles: c.fontFiles || [], discovered: !!disc,
    summary: `fonts: heading "${heading.primary || 'Georgia'}" (${heading.source}) · body "${body.primary || 'Helvetica'}" (${body.source})` };
}

const MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject' };
const FORMAT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
const ext = (u) => (String(u).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1] || 'woff2').toLowerCase();
const dataUri = (buf, e) => `data:${MIME[e] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
// Fetches a font URL once (cached under cacheDir by hash) and returns it as a data: URI; null when it cannot be read.
async function fontData(url, cacheDir) {
  try {
    if (/^file:/.test(url)) return dataUri(fs.readFileSync(new URL(url)), ext(url));
    if (!/^https?:/.test(url)) return fs.existsSync(url) ? dataUri(fs.readFileSync(url), ext(url)) : null;
    fs.mkdirSync(cacheDir, { recursive: true });
    const { createHash } = await import('crypto');
    const cached = path.join(cacheDir, `${createHash('sha1').update(url).digest('hex')}.${ext(url)}`);
    if (!fs.existsSync(cached)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
    }
    return dataUri(fs.readFileSync(cached), ext(url));
  } catch (e) { console.warn(`font not embedded (${String(e.message || e).split('\n')[0]}): ${url}`); return null; }
}
// Family name for a bare font file path: "BebasNeue-Regular.woff2" -> "Bebas Neue". Use the object form for anything unusual.
const familyFromFile = (f) => path.basename(f).replace(/\.[a-z0-9]+$/i, '').replace(/[-_](regular|bold|italic|light|medium|semibold|black|thin|\d{3})+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// HTML to put at the top of a render page: <link>s for Google Fonts stylesheets, plus @font-face rules whose files are
// inlined as data: URIs (the render page is about:blank, so relative URLs and CORS-less origins would otherwise fail).
export async function brandFontHtml(brand, cacheDir) {
  const links = brand.stylesheets.map(u => `<link rel="stylesheet" href="${escAttr(u)}">`);
  const rules = [];
  for (const f of brand.fontFaces) {
    const parts = [...f.src.matchAll(/url\("([^"]+)"\)(\s*format\(([^)]*)\))?/g)];
    let src = f.src;
    for (const m of parts) { const d = await fontData(m[1], cacheDir); if (d) src = src.replace(m[0], `url("${d}")${m[2] || ''}`); }
    rules.push(`@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:${f.style};font-display:block;${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ''}src:${src}}`);
  }
  for (const ff of brand.fontFiles) {
    const d = await fontData(ff.file, cacheDir); if (!d) continue;
    const e = ext(ff.file);
    rules.push(`@font-face{font-family:"${ff.family || familyFromFile(ff.file)}";font-weight:${ff.weight ?? 400};font-style:${ff.style || 'normal'};font-display:block;src:url("${d}")${FORMAT[e] ? ` format("${FORMAT[e]}")` : ''}}`);
  }
  return links.join('') + (rules.length ? `<style>${rules.join('\n')}</style>` : '');
}

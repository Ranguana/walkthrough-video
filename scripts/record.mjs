// Records the walkthrough with Playwright: drives the target beat by beat (from beats.json), holds each beat at least as long
// as its narration + lead + pad, overlays a cursor halo, and writes takes/take<N>/{raw.webm | frames/} + timings.json (+ notes.json).
//
// Two targets, set by "target" in walkthrough.config.json:
//   { "type": "web", "baseUrl": "https://example.com" }                          Chromium page, recorded with Playwright's recordVideo
//   { "type": "electron", "appPath": "...", "args": ["."], "cwd": "..." }        Electron app window, captured as a frame sequence
// Electron windows cannot use recordVideo, so an Electron take is always captured with --frames (below). The action DSL is
// identical for both: everything below drives a Playwright Page.
//
// Usage:  node record.mjs --config walkthrough.config.json [--take N] [--headed] [--only 01-hook,02-demo] [--frames] [--frames-fps 8]
//   --take N       take number (default: next free number under <outDir>/takes/)
//   --headed       run a visible browser (debugging selectors; the recording still works). Electron is always headful.
//   --only ids     record only these beats (for debugging a beat's actions; timings will not line up for assembly)
//   --frames       capture a timestamped PNG sequence (takes/take<N>/frames/ + index.json) instead of a video file.
//                  Forced for Electron; usable for web too. assemble.mjs accepts either as its input.
//   --frames-fps N frame capture rate, default config.framesFps (8). Screenshots cost 50-150 ms each, so 30 is not reachable;
//                  each frame's real timestamp is recorded and assemble.mjs rebuilds an exact wall-clock timeline from them.
//
// Beats: see templates/beats.example.json. Each beat = { id, screen, text, spoken?, dur (filled by tts.mjs), pad?, hold?, actions[] }.
// Actions run in order; all times are SECONDS. Targets are Playwright selector strings ("text=Sign in", "#email",
// "role=button[name=\"Continue\"]", "h1:has-text(\"Review\")") or objects { role, name, exact } | { text, exact } | { label } |
// { placeholder } | { testId }, optionally with "nth".
//
//   { "goto": "/demo", "waitUntil": "networkidle" }      navigate (path is joined to baseUrl; absolute URLs pass through) — web targets only
//   { "waitFor": target, "timeout": 30 }                   wait until the target is visible
//   { "waitUrl": "/home" }                                 wait until the URL matches (regex source)
//   { "wait": 1.5 }                                        sleep
//   { "mouse": [960, 600] }                                move the cursor to viewport coordinates
//   { "hover": target, "for": 1.5, "fx": 0.5, "fy": 0.5 } scroll into view if needed, move the cursor there, linger
//   { "click": target }                                    hover then click
//   { "type": target, "text": "hello" | "env": "DEMO_PASSWORD", "delay": 0.028 }   click, clear, type char by char (env = read from process.env, never from beats.json)
//   { "press": "Enter" }                                   keyboard key
//   { "select": target, "value": "x" | "label": "X", "menu": true, "hoverValues": ["a","b"] }   choose a native <select> option; menu:true draws the option list on screen (headless Chromium never paints native popups)
//   { "upload": target, "file": "fixtures/sample.pdf" }    setInputFiles (path relative to the config file)
//   { "scroll": 520 } | { "scroll": "top" | "bottom" }    smooth page scroll to y
//   { "scrollIntoView": target, "offset": 120 }            smooth page scroll so the target sits `offset` px from the top
//   { "scrollEl": target, "top": 140 }                     smooth scroll inside a scrollable element
//   { "zoom": 1.4 }                                        animate document zoom (1 = back to normal)
//   { "highlight": { "within": target, "needles": ["BEGlNNING"], "scroll": true } }   wrap matching text in a highlighted <mark class="__hl">; then hover "mark.__hl >> nth=0"
//   { "unhighlight": true }                                fade the marks out
//   { "card": { "brand": "Product", "line": "...", "url": "example.com/demo", "sub": "..." } }   full-screen closing card overlay
//   { "dialog": "accept" | "dismiss" }                     how to answer confirm()/alert() from here on (default from config)
//   { "eval": "document.title" }                           run JavaScript in the page
//   { "screenshot": "name" }                               save takes/take<N>/name.png (useful for stills.mjs)
//   { "holdNarration": 0.8 }                               wait until the beat has lasted voLead + dur + pad (done automatically at the end of a beat unless the beat sets "autoHold": false)
//
// Playwright pitfalls handled here: native <select> popups are invisible in recordings (use "menu": true); confirm()/alert()
// dialogs block the page until answered (a handler answers them; the dialog itself is never visible — use a "card" if the
// viewer must see one); the cursor is invisible in recordings (the halo overlay stands in for it).
import fs from 'fs';
import path from 'path';
import { chromium, _electron } from 'playwright';
import { args, loadConfig, loadEnv, readBeats, listTakes, takeDir, writeJson } from './lib.mjs';

const cfg = loadConfig(args.config);
loadEnv(cfg);
const allBeats = readBeats(cfg);
const only = args.only ? new Set(String(args.only).split(',')) : null;
const beats = allBeats.filter(b => b.kind === 'record' && (!only || only.has(b.id)));
if (!beats.length) throw new Error('no recordable beats (kind "record") selected');
const takeNo = args.take && args.take !== true ? +args.take : (listTakes(cfg).at(-1) ?? 0) + 1;
const outDir = takeDir(cfg, takeNo); fs.mkdirSync(outDir, { recursive: true });
const { width, height } = cfg.viewport;
const IS_ELECTRON = cfg.target.type === 'electron';
// Electron windows cannot be recorded with recordVideo, so they are always captured as a frame sequence.
const FRAMES = IS_ELECTRON || !!args.frames;
const FRAMES_FPS = +(args['frames-fps'] || cfg.framesFps || 8);

// Cursor halo (video-only). For web it is an init script so it survives navigations; for Electron it is injected
// into the live window and re-injected on every load.
const HALO = ({ color, size }) => {
  const install = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div'); c.id = '__cur';
    Object.assign(c.style, { position: 'fixed', left: '-100px', top: '-100px', width: size + 'px', height: size + 'px', marginLeft: -size / 2 + 'px', marginTop: -size / 2 + 'px',
      borderRadius: '50%', background: `rgba(${color}, 0.28)`, border: `2px solid rgba(${color}, 0.85)`, pointerEvents: 'none', zIndex: '2147483647', transition: 'transform 120ms ease', boxSizing: 'border-box' });
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'absolute', left: '50%', top: '50%', width: '6px', height: '6px', margin: '-3px 0 0 -3px', borderRadius: '50%', background: '#1a1a1a' });
    c.appendChild(d); document.documentElement.appendChild(c);
    window.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', () => { c.style.transform = 'scale(0.7)'; c.style.background = `rgba(${color}, 0.55)`; }, true);
    window.addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; c.style.background = `rgba(${color}, 0.28)`; }, true);
  };
  if (document.readyState !== 'loading') install(); else document.addEventListener('DOMContentLoaded', install);
};

let browser = null, ctx = null, electronApp = null, page;
if (IS_ELECTRON) {
  const t = cfg.target;
  console.log(`electron: launching ${t.appPath} ${(t.args || []).join(' ')}`);
  electronApp = await _electron.launch({
    executablePath: t.appPath, args: t.args || [], cwd: t.cwd || undefined,
    env: { ...process.env, ...(t.env || {}) },
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Size the window from the main process — an Electron page has no settable viewport.
  try {
    await electronApp.evaluate(async ({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) return; w.setResizable(true); w.setContentSize(size.width, size.height); w.center(); w.show(); w.focus();
    }, { width, height });
  } catch (e) { console.warn(`could not resize the Electron window (${String(e.message || e).split('\n')[0]}); set width/height in the app's own BrowserWindow options instead`); }
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null);
  if (size && (size.w !== width || size.h !== height)) console.warn(`window is ${size.w}x${size.h}, not ${width}x${height} — frames will be scaled at assembly; fix it in the app's BrowserWindow options for a sharp result`);
  await page.evaluate(HALO, cfg.halo).catch(() => {});
  page.on('load', () => page.evaluate(HALO, cfg.halo).catch(() => {}));
} else {
  browser = await chromium.launch({ headless: !args.headed });
  ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true,
    storageState: cfg.storageState && fs.existsSync(cfg.storageState) ? cfg.storageState : undefined,
    recordVideo: FRAMES ? undefined : { dir: outDir, size: { width, height } },
  });
  await ctx.addInitScript(HALO, cfg.halo);
  page = await ctx.newPage();
}
page.setDefaultTimeout(30000);
let dialogMode = cfg.dialogs;
page.on('dialog', async d => { console.log(`  dialog (${d.type()}): ${d.message().slice(0, 120)} -> ${dialogMode}`); await (dialogMode === 'dismiss' ? d.dismiss() : d.accept()).catch(() => {}); });

const T0 = Date.now();
const now = () => (Date.now() - T0) / 1000;
const timings = [], notes = [];
let cur = null, beatStart = 0, held = false;
const sleep = (s) => page.waitForTimeout(Math.max(0, s * 1000));

// ---- frame capture (Electron, or web with --frames) ----
// Screenshots are slower and less regular than a video encoder, so each frame's real offset is recorded and
// assemble.mjs rebuilds the wall-clock timeline from index.json. Never runs two screenshots at once.
const framesDir = path.join(outDir, 'frames');
const frames = [];
let capturing = false, captureTimer = null;
const captureFrame = async () => {
  if (capturing) return; capturing = true;
  const t = now(), file = `f${String(frames.length).padStart(5, '0')}.png`;
  try { await page.screenshot({ path: path.join(framesDir, file), animations: 'allow', caret: 'initial', timeout: 5000 }); frames.push({ file, t: +t.toFixed(4) }); }
  catch { /* a screenshot can fail mid-navigation; skip the frame */ }
  finally { capturing = false; }
};
const startCapture = () => {
  fs.mkdirSync(framesDir, { recursive: true });
  captureTimer = setInterval(() => { captureFrame(); }, Math.max(20, Math.round(1000 / FRAMES_FPS)));
};
const stopCapture = async () => {
  if (captureTimer) clearInterval(captureTimer);
  while (capturing) await new Promise(r => setTimeout(r, 20));
};

// ---- target resolution ----
const loc = (spec) => {
  if (typeof spec === 'string') return page.locator(spec).first();
  let l;
  if (spec.role) l = page.getByRole(spec.role, { name: spec.name, exact: spec.exact ?? false });
  else if (spec.text !== undefined) l = page.getByText(spec.text, { exact: spec.exact ?? false });
  else if (spec.label) l = page.getByLabel(spec.label, { exact: spec.exact ?? false });
  else if (spec.placeholder) l = page.getByPlaceholder(spec.placeholder);
  else if (spec.testId) l = page.getByTestId(spec.testId);
  else if (spec.selector) l = page.locator(spec.selector);
  else throw new Error('bad target: ' + JSON.stringify(spec));
  return l.nth(spec.nth ?? 0);
};
const describe = (spec) => (typeof spec === 'string' ? spec : JSON.stringify(spec));

// ---- motion helpers ----
const moveTo = async (l, fx = 0.5, fy = 0.5, steps = 30) => {
  const b = await l.boundingBox(); if (!b) throw new Error('target has no bounding box (hidden?)');
  await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps });
};
const smoothScrollTo = (y) => page.evaluate(async (target) => {
  const start = window.scrollY, dist = target - start, steps = Math.max(12, Math.min(70, Math.abs(dist) / 14));
  for (let i = 1; i <= steps; i++) { const t = i / steps, e = t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t; window.scrollTo(0, start + dist * e); await new Promise(r => setTimeout(r, 16)); }
}, y);
const scrollIntoView = async (l, offset = 120) => {
  const y = await l.evaluate(el => el.getBoundingClientRect().top + window.scrollY);
  await smoothScrollTo(Math.max(0, y - offset));
};
const ensureVisible = async (l, offset = 200) => {
  const b = await l.boundingBox();
  if (b && (b.y < 80 || b.y + b.height > height - 80)) { await scrollIntoView(l, offset); await sleep(0.15); }
};
const smoothScrollEl = (l, top) => l.evaluate(async (el, target) => {
  const start = el.scrollTop, dist = target - start;
  for (let i = 1; i <= 30; i++) { el.scrollTop = start + dist * (i / 30); await new Promise(r => setTimeout(r, 16)); }
}, top);
const zoomTo = async (z) => {
  const from = parseFloat(await page.evaluate(() => document.body.style.zoom || '1'));
  const n = 8; for (let i = 1; i <= n; i++) { const v = from + (z - from) * (i / n); await page.evaluate(v => { document.body.style.zoom = Math.abs(v - 1) < 0.001 ? '' : String(v); }, v); await sleep(0.045); }
};
const showSelectMenu = (l) => l.evaluate((s) => {
  const r = s.getBoundingClientRect();
  const box = document.createElement('div'); box.id = '__menu';
  Object.assign(box.style, { position: 'fixed', left: r.left + 'px', top: (r.bottom + 4) + 'px', width: Math.max(r.width, 320) + 'px', background: '#fff', border: '1px solid #c9c2b8', borderRadius: '8px',
    boxShadow: '0 12px 32px rgba(0,0,0,.18)', zIndex: '2147483600', padding: '6px', font: '15px/1.3 system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif', color: '#1a1a1a' });
  for (const o of s.options) {
    const row = document.createElement('div'); row.className = '__opt'; row.dataset.value = o.value; row.textContent = o.textContent;
    Object.assign(row.style, { padding: '9px 12px', borderRadius: '6px', background: o.selected ? '#f3ede4' : 'transparent' });
    row.addEventListener('mouseenter', () => { row.style.background = '#e9dfd0'; }); row.addEventListener('mouseleave', () => { row.style.background = o.selected ? '#f3ede4' : 'transparent'; });
    box.appendChild(row);
  }
  document.body.appendChild(box);
});
const hideSelectMenu = () => page.evaluate(() => document.getElementById('__menu')?.remove());
const holdBeat = async (pad) => {
  const b = cur; const want = Math.max(b.hold || 0, cfg.voLead + (b.dur || 0) + (pad ?? b.pad ?? cfg.pad));
  const left = want - (now() - beatStart); if (left > 0) await sleep(left); held = true;
};
const resolveFile = (p) => path.resolve(cfg.configDir, p);

// ---- actions ----
const run = async (a) => {
  if (a.goto !== undefined) {
    if (!cfg.baseUrl && !/^https?:/.test(a.goto)) throw new Error('"goto" needs a web target with a baseUrl (an Electron window is already loaded; drive it with click/type/waitFor instead)');
    const url = /^https?:/.test(a.goto) ? a.goto : cfg.baseUrl.replace(/\/$/, '') + '/' + String(a.goto).replace(/^\//, '');
    await page.goto(url, { waitUntil: a.waitUntil || 'load' }); await sleep(a.settle ?? 0.6); return;
  }
  if (a.waitFor !== undefined) { await loc(a.waitFor).waitFor({ state: 'visible', timeout: (a.timeout ?? 30) * 1000 }); return; }
  if (a.waitUrl !== undefined) { await page.waitForURL(new RegExp(a.waitUrl), { timeout: (a.timeout ?? 45) * 1000 }); return; }
  if (a.wait !== undefined) { await sleep(a.wait); return; }
  if (a.mouse !== undefined) { await page.mouse.move(a.mouse[0], a.mouse[1], { steps: a.steps ?? 25 }); return; }
  if (a.hover !== undefined) { const l = loc(a.hover); await ensureVisible(l, a.offset); await moveTo(l, a.fx, a.fy); await sleep(a.for ?? 1.2); return; }
  if (a.click !== undefined) { const l = loc(a.click); await ensureVisible(l, a.offset); await moveTo(l, a.fx, a.fy); await sleep(a.before ?? 0.45); await l.click(); await sleep(a.after ?? 0.3); return; }
  if (a.type !== undefined) {
    const l = loc(a.type); const text = a.env ? process.env[a.env] : a.text;
    if (text === undefined) throw new Error(`type: no text (env ${a.env} unset?)`);
    await ensureVisible(l); await moveTo(l); await sleep(0.4); await l.click(); if (a.clear !== false) await l.fill('');
    await page.keyboard.type(text, { delay: (a.delay ?? 0.028) * 1000 }); return;
  }
  if (a.press !== undefined) { await page.keyboard.press(a.press); await sleep(a.after ?? 0.3); return; }
  if (a.select !== undefined) {
    const l = loc(a.select); await ensureVisible(l); await moveTo(l); await sleep(0.4);
    if (a.menu) {
      await page.mouse.down(); await sleep(0.08); await page.mouse.up(); await showSelectMenu(l); await sleep(0.6);
      for (const v of a.hoverValues || []) { await moveTo(page.locator(`#__menu .__opt[data-value="${v}"]`)); await sleep(0.7); }
      const value = a.value ?? await l.evaluate((s, label) => [...s.options].find(o => o.textContent.trim() === label)?.value, a.label);
      await moveTo(page.locator(`#__menu .__opt[data-value="${value}"]`)); await sleep(0.5); await page.mouse.down(); await sleep(0.08); await page.mouse.up();
      await hideSelectMenu();
    }
    await l.selectOption(a.value !== undefined ? a.value : { label: a.label }); await sleep(0.3); return;
  }
  if (a.upload !== undefined) { await loc(a.upload).setInputFiles(resolveFile(a.file)); await sleep(a.after ?? 0.5); return; }
  if (a.scroll !== undefined) { const y = a.scroll === 'top' ? 0 : a.scroll === 'bottom' ? await page.evaluate(() => document.documentElement.scrollHeight) : a.scroll; await smoothScrollTo(y); await sleep(a.after ?? 0.3); return; }
  if (a.scrollIntoView !== undefined) { await scrollIntoView(loc(a.scrollIntoView), a.offset ?? 120); await sleep(a.after ?? 0.3); return; }
  if (a.scrollEl !== undefined) { await smoothScrollEl(loc(a.scrollEl), a.top ?? 0); await sleep(a.after ?? 0.3); return; }
  if (a.zoom !== undefined) { await zoomTo(a.zoom); return; }
  if (a.highlight !== undefined) {
    const h = a.highlight; const within = h.within ? loc(h.within) : page.locator('body');
    await within.evaluate((root, { needles, color }) => {
      const mark = (needle) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
        while ((n = walker.nextNode())) { const i = n.nodeValue.indexOf(needle); if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
          const m = document.createElement('mark'); m.className = '__hl';
          Object.assign(m.style, { background: 'rgba(255,210,60,0.85)', color: 'inherit', borderRadius: '3px', padding: '0 2px', outline: `2px solid rgba(${color},0.9)`, transition: 'all 400ms ease' });
          r.surroundContents(m); return m; }
        return null;
      };
      for (const nd of needles) { const m = mark(nd); if (!m) console.warn('highlight: not found', nd); }
    }, { needles: h.needles || [h.needle], color: cfg.halo.color });
    if (h.scroll !== false) { const first = page.locator('mark.__hl').first(); if (await first.count()) await first.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })); await sleep(0.5); }
    return;
  }
  if (a.unhighlight !== undefined) { await page.evaluate(() => { for (const m of document.querySelectorAll('mark.__hl')) { m.style.background = 'transparent'; m.style.outline = '2px solid transparent'; } }); return; }
  if (a.card !== undefined) {
    const c = { ...cfg.card, ...a.card };
    await page.evaluate((c) => {
      const mk = (tag, style, text) => { const e = document.createElement(tag); Object.assign(e.style, style); if (text) e.textContent = text; return e; };
      const o = mk('div', { position: 'fixed', inset: '0', background: 'rgba(20,18,16,0)', zIndex: '2147483646', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 900ms ease', fontFamily: 'Georgia, "Times New Roman", serif' });
      const inner = mk('div', { textAlign: 'center', color: '#f6f1ea', opacity: '0', transition: 'opacity 900ms ease 400ms', maxWidth: '1100px', padding: '0 40px' });
      if (c.brand) inner.append(mk('div', { fontSize: '64px', marginBottom: '28px' }, c.brand));
      if (c.line) inner.append(mk('div', { fontSize: '30px', lineHeight: '1.45', marginBottom: '34px' }, c.line));
      if (c.url) inner.append(mk('div', { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '34px', color: c.accent }, c.url));
      if (c.sub) inner.append(mk('div', { fontSize: '22px', color: '#c9c0b4', marginTop: '16px' }, c.sub));
      o.append(inner); document.body.appendChild(o);
      requestAnimationFrame(() => requestAnimationFrame(() => { o.style.background = c.background; inner.style.opacity = '1'; }));
    }, c);
    await page.mouse.move(-50, -50); return;
  }
  if (a.dialog !== undefined) { dialogMode = a.dialog; return; }
  if (a.eval !== undefined) { const r = await page.evaluate(a.eval); if (a.log) console.log('  eval:', JSON.stringify(r)); return; }
  if (a.screenshot !== undefined) { await page.screenshot({ path: path.join(outDir, `${a.screenshot}.png`) }); return; }
  if (a.holdNarration !== undefined) { await holdBeat(a.holdNarration === true ? undefined : a.holdNarration); return; }
  throw new Error('unknown action ' + JSON.stringify(a));
};

// ---- main loop ----
if (FRAMES) { startCapture(); console.log(`capturing frames at ~${FRAMES_FPS} fps into ${framesDir}`); }
for (const b of beats) {
  cur = b; beatStart = now(); held = false;
  timings.push({ id: b.id, start: +beatStart.toFixed(3) });
  console.log(`beat ${b.id} @ ${beatStart.toFixed(2)}s  (narration ${(b.dur || 0).toFixed(1)}s)`);
  for (const a of b.actions || []) {
    try { await run(a); }
    catch (e) {
      const msg = String(e.message || e).split('\n')[0];
      notes.push({ beat: b.id, action: a, error: msg }); console.log(`  ACTION ERROR in ${b.id}: ${msg}  action=${JSON.stringify(a).slice(0, 160)}`);
      await hideSelectMenu().catch(() => {});
      if (a.required !== false && (a.goto !== undefined || a.waitFor !== undefined || a.waitUrl !== undefined)) { console.log('  navigation/wait failed; continuing with the next beat'); break; }
    }
  }
  if (!held && b.autoHold !== false) await holdBeat();
}
timings.push({ id: 'end', start: +now().toFixed(3) });

let captured;
if (FRAMES) {
  await captureFrame();                       // one last frame so the timeline reaches "end"
  await stopCapture();
  const endT = timings.at(-1).start;
  writeJson(path.join(framesDir, 'index.json'), { fps: FRAMES_FPS, width, height, end: endT, frames });
  captured = `${framesDir} (${frames.length} frames, ${(frames.length / Math.max(endT, 0.001)).toFixed(1)} fps effective)`;
  if (!frames.length) throw new Error('no frames were captured — every screenshot failed');
  if (IS_ELECTRON) await electronApp.close(); else { await page.close(); await ctx.close(); await browser.close(); }
} else {
  await page.close();
  const video = await page.video(); const vpath = await video.path();
  await ctx.close(); await browser.close();
  fs.renameSync(vpath, path.join(outDir, 'raw.webm'));
  captured = path.join(outDir, 'raw.webm');
}
writeJson(path.join(outDir, 'timings.json'), timings);
writeJson(path.join(outDir, 'notes.json'), notes);
console.log(`done: ${captured}  ` + timings.map(t => `${t.id}@${t.start.toFixed(1)}`).join(' '));
if (notes.length) { console.log(`${notes.length} action error(s) — see ${outDir}/notes.json`); process.exit(1); }

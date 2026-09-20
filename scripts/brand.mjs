// Discovers the recorded app's typography WITHOUT recording, and writes it to takes/take<N>/brand.json — the same file
// record.mjs writes during a take. Use it for a take recorded before brand discovery existed, or to refresh the fonts
// after the app's design changed without re-recording.
//
// What it reads from the live page (see BRAND_PROBE in lib.mjs): the computed font-family / weight / text-transform /
// letter-spacing of the first h1 (fallback h2, then body), the body font-family, every fonts.googleapis.com stylesheet,
// every @font-face rule in a readable (same-origin) stylesheet with its src URLs made absolute, and document.fonts.
// assemble.mjs merges the result with "brand" in the config (config wins) and sets the thumbnail title and the burned-in
// captions in those faces.
//
// Usage:  node brand.mjs --config walkthrough.config.json [--take N] [--out path/brand.json] [--url /path] [--headed]
//   --take N   which take's folder to write into (default: the latest under <outDir>/takes/)
//   --out      write somewhere else instead (no take needed)
//   --url      page to probe (default: the first "goto" in the first recordable beat; else baseUrl). Web targets only.
//   --headed   visible browser
// An Electron target launches the app, probes its first window, and quits.
import fs from 'fs';
import path from 'path';
import { chromium, _electron } from 'playwright';
import { args, loadConfig, loadEnv, readBeats, listTakes, takeDir, discoverBrand } from './lib.mjs';

const cfg = loadConfig(args.config);
loadEnv(cfg);
const beats = readBeats(cfg).filter(b => b.kind === 'record');
const IS_ELECTRON = cfg.target.type === 'electron';

let outFile;
if (args.out && args.out !== true) outFile = path.resolve(args.out);
else {
  const n = args.take && args.take !== true ? +args.take : listTakes(cfg).at(-1);
  if (!n) throw new Error('no takes yet — record first (record.mjs writes brand.json itself), or pass --out path/brand.json');
  outFile = path.join(takeDir(cfg, n), 'brand.json');
  if (!fs.existsSync(takeDir(cfg, n))) throw new Error(`take folder does not exist: ${takeDir(cfg, n)}`);
}

let page, close;
if (IS_ELECTRON) {
  const t = cfg.target;
  console.log(`electron: launching ${t.appPath} ${(t.args || []).join(' ')}`);
  const app = await _electron.launch({ executablePath: t.appPath, args: t.args || [], cwd: t.cwd || undefined, env: { ...process.env, ...(t.env || {}) } });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);                       // let the renderer paint its first screen and its fonts land
  close = () => app.close();
} else {
  const first = beats.flatMap(b => b.actions || []).find(a => a.goto !== undefined);
  const target = args.url && args.url !== true ? args.url : (first?.goto ?? '/');
  const url = /^https?:/.test(target) ? target : cfg.baseUrl.replace(/\/$/, '') + '/' + String(target).replace(/^\//, '');
  const browser = await chromium.launch({ headless: !args.headed });
  const ctx = await browser.newContext({ viewport: cfg.viewport, deviceScaleFactor: 1, storageState: cfg.storageState && fs.existsSync(cfg.storageState) ? cfg.storageState : undefined });
  page = await ctx.newPage();
  console.log(`probing ${url}`);
  await page.goto(url, { waitUntil: first?.waitUntil || 'load', timeout: 60000 });
  await page.waitForTimeout(800);
  close = async () => { await ctx.close(); await browser.close(); };
}

const brand = await discoverBrand(page, outFile);
await close();
if (brand.error) { console.log(`discovery failed (${brand.error}); wrote nulls to ${outFile}`); process.exit(1); }
const first = (s) => (s || '').split(',')[0].trim();
console.log(`heading: ${first(brand.heading?.family) || '(none)'}  weight ${brand.heading?.weight}  transform ${brand.heading?.transform}  letter-spacing ${brand.heading?.letterSpacing} @ ${brand.heading?.fontSize} (from <${brand.heading?.tag}>)`);
console.log(`body:    ${first(brand.body?.family) || '(none)'}`);
console.log(`${brand.stylesheets.length} Google Fonts stylesheet(s), ${brand.fontFaces.length} @font-face rule(s), ${brand.fonts.filter(f => f.status === 'loaded').length}/${brand.fonts.length} document.fonts loaded`);
if (brand.errors?.length) console.log(`partial: ${brand.errors.join(' | ')}`);
console.log(`wrote ${outFile}`);

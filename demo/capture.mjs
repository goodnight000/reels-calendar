// Regenerates every README image and clip: `node demo/capture.mjs [shots] [tour] [link]` (default: all).
// Builds the synthetic fixture, runs this checkout's server on a free port against it, drives real
// Chrome with the clock frozen on the demo day, and writes docs/media/. Needs Chrome and ffmpeg.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { TODAY, build } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'demo/.data');
const OUT = path.join(ROOT, 'docs/media');
const RAW = path.join(DATA, 'raw');
const VIEW = { width: 1440, height: 900 };
const NOW = new Date(`${TODAY}T10:30:00`);
const want = process.argv.slice(2);
const run = name => !want.length || want.includes(name);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });
await build(DATA);

const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://localhost:${port}`;
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), PLANS_DIR: path.join(DATA, 'plans'), REELS_DIR: path.join(DATA, 'reels'), THUMBS_DIR: path.join(DATA, 'thumbs') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', d => String(d).includes('→') && resolve());
  server.on('exit', code => reject(Error(`server exited ${code}`)));
});

const browser = await chromium.launch({ channel: 'chrome' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A drawn cursor (recordings have none) and a stand-in for the native drag image, which screencasts miss.
function overlay() {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23 L14 21.5 L10.5 14 L17 14 Z" fill="#1c1e21" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:-2px;top:-2px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 150ms;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.25))';
    document.body.append(c);
    let ghost = null, dx = 0, dy = 0;
    const move = e => {
      c.style.opacity = 1;
      c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      if (ghost) ghost.style.transform = `translate(${e.clientX - dx}px, ${e.clientY - dy}px) rotate(-1.5deg)`;
    };
    addEventListener('mousemove', move, true);
    addEventListener('dragover', move, true);
    addEventListener('dragstart', e => {
      const src = e.target.closest?.('.entry, .plan-row');
      if (!src) return;
      const r = src.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      ghost = src.cloneNode(true);
      ghost.style.cssText = `position:fixed;left:0;top:0;margin:0;width:${r.width}px;z-index:2147483646;pointer-events:none;background:#fff;border-radius:6px;box-shadow:0 6px 18px rgba(28,30,33,.14);opacity:.95`;
      document.body.append(ghost);
      move(e);
    }, true);
    const drop = () => { ghost?.remove(); ghost = null; };
    addEventListener('drop', drop, true);
    addEventListener('dragend', drop, true);
  });
}

async function open(context, hash) {
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  page.on('pageerror', e => console.error('pageerror:', e.message));
  await page.goto(`${base}/#${hash}`);
  await page.waitForSelector('.cell .entry.video img');
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(i => i.decode().catch(() => {}))]));
  await sleep(400);
  return page;
}

// Eased, frame-paced pointer moves so recordings read as a person, not a teleport.
async function glide(page, to, ms = 700) {
  const from = page._demoMouse || { x: VIEW.width - 200, y: VIEW.height - 80 };
  const n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await sleep(16);
  }
  page._demoMouse = to;
}
const center = async (locator, dx = 0) => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 }; };
const press = async (page, key, wait = 380) => { await page.keyboard.press(key); await sleep(wait); };

// Full-resolution PNG, then a palette-reduced copy at 1.5x so each image stays a few hundred KB.
async function shot(page, name, clip) {
  const raw = path.join(RAW, `${name}.png`);
  await page.screenshot({ path: raw, clip });
  const width = Math.round((clip?.width || VIEW.width) * 1.5);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none`, path.join(OUT, `${name}.png`)]);
}

async function shots() {
  await build(DATA);
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
  const page = await open(context, TODAY);
  await page.mouse.move(VIEW.width - 120, VIEW.height - 40);
  await shot(page, 'hero');

  // The link suggestion, close up.
  await page.locator('.plan-item', { hasText: 'SSDs' }).hover();
  await sleep(200);
  await shot(page, 'link', { x: VIEW.width - 380, y: 0, width: 380, height: 420 });

  // Script editor with a written script.
  await page.keyboard.press('Escape');
  await page.mouse.move(VIEW.width - 120, VIEW.height - 40);
  await page.goto(`${base}/#2026-10-19`);
  await page.waitForSelector('.plan-row');
  await page.locator('.plan-row', { hasText: 'URL' }).click();
  await page.waitForSelector('.ProseMirror h1');
  await page.mouse.move(VIEW.width - 120, VIEW.height - 40);
  await sleep(500);
  await shot(page, 'editor');

  // A posted video playing in the rail: a taller window so the whole detail fits, cropped to the rail.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: VIEW.width, height: 1040 });
  await page.goto(`${base}/#2026-10-13`);
  await page.locator('.video-row').first().click();
  await page.waitForFunction(() => document.querySelector('.video-detail video')?.currentTime > 1.6);
  await page.evaluate(() => document.querySelector('.video-detail video').pause());
  await page.mouse.move(VIEW.width - 120, VIEW.height - 40);
  await sleep(200);
  await shot(page, 'video', { x: VIEW.width - 380, y: 0, width: 380, height: 950 });
  await page.setViewportSize(VIEW);

  await context.close();
}

// Records one clip from Playwright's screencast (JPEG frames + arrival times), starting once the page has
// settled, then encodes it with the system ffmpeg: an H.264 mp4 to link and a palette GIF to embed.
async function record(name, hash, act) {
  await build(DATA);
  const dir = path.join(RAW, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEW });
  await context.addInitScript(overlay);
  const page = await open(context, hash);
  const frames = [];
  const t0 = performance.now();
  await page.screencast.start({ size: VIEW, quality: 92, onFrame: ({ data }) => frames.push({ t: performance.now() - t0, data }) });
  await act(page);
  await sleep(1200);
  const end = performance.now() - t0;
  await page.screencast.stop();
  await context.close();
  // Screencasts only send a frame when something changes, so each one is held until the next arrives.
  const list = frames.map((f, i) => {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, f.data);
    return `file '${file}'\nduration ${(((frames[i + 1]?.t ?? end) - f.t) / 1000).toFixed(4)}`;
  });
  fs.writeFileSync(path.join(dir, 'frames.txt'), `ffconcat version 1.0\n${list.join('\n')}\nfile '${path.join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'\n`);
  const mp4 = path.join(OUT, `${name}.mp4`), gif = path.join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'), '-vf', 'fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
    'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', gif]);
}

async function tour(page) {
  await sleep(1200);
  for (let i = 0; i < 6; i++) await press(page, 'ArrowRight', i === 3 ? 900 : 420);
  await press(page, 'n', 300);
  await page.keyboard.type('Why airplane mode exists', { delay: 55 });
  await sleep(500);
  await press(page, 'Meta+Enter', 900);
  await page.keyboard.type('# Hook\nYour phone can still call for help in airplane mode.\n- planes are fine with Wi-Fi now\nthe rule was about cell towers', { delay: 32 });
  await sleep(1400);
  await press(page, 'Escape', 1000);
  const entry = page.locator('[data-date="2026-10-21"] .entry.plan');
  const from = await center(entry, -20);
  await glide(page, from, 800);
  await sleep(250);
  await page.mouse.down();
  await glide(page, { x: from.x + 20, y: from.y + 10 }, 150);
  const to = await center(page.locator('[data-date="2026-10-23"]'));
  await glide(page, to, 1100);
  await sleep(250);
  await page.mouse.up();
  await sleep(600);
  await glide(page, { x: to.x + 40, y: to.y + 120 }, 500);
}

async function link(page) {
  await sleep(1000);
  await glide(page, await center(page.locator('.plan-item', { hasText: 'SSDs' }).locator('.plan-row')), 800);
  await sleep(500);
  await glide(page, await center(page.locator('.suggest-link')), 600);
  await sleep(400);
  await page.mouse.down(); await sleep(80); await page.mouse.up();
  await sleep(1300);
  const row = page.locator('.video-row', { hasText: 'SSDs' });
  await glide(page, await center(row), 700);
  await sleep(300);
  await page.mouse.down(); await sleep(80); await page.mouse.up();
  await page.waitForSelector('.video-detail video');
  await glide(page, { x: VIEW.width - 36, y: VIEW.height - 16 }, 700);
  await sleep(3000);
}

try {
  // Warm Vite's dependency optimizer so its reload never lands in a capture.
  const warm = await browser.newContext({ viewport: VIEW });
  await open(warm, TODAY);
  await warm.close();

  if (run('shots')) await shots();
  if (run('tour')) await record('tour', TODAY, tour);
  if (run('link')) await record('link', TODAY, link);
  await build(DATA);
  for (const f of fs.readdirSync(OUT)) console.log(`${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0).padStart(6)} KB  docs/media/${f}`);
} finally {
  await browser.close();
  server.kill();
}

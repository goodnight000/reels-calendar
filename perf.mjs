// Isolated, repeatable Chrome measurements: node perf.mjs [--dev] [--checks].
// PERF_ROOT points at a frozen checkout/build; PERF_OUT saves the JSON receipt.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';

async function checks() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'reels-perf-checks-'));
  const root = process.env.PERF_ROOT || path.dirname(fileURLToPath(import.meta.url));
  const bin = path.join(fixture, 'bin');
  const reels = path.join(fixture, 'reels');
  fs.mkdirSync(bin, { recursive: true });
  const projects = Array.from({ length: 6 }, (_, i) => `2026-10-12-fixture-${i}`);
  const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  for (const project of projects) {
    fs.mkdirSync(path.join(reels, project), { recursive: true });
    fs.writeFileSync(path.join(reels, project, 'final.mp4'), data);
  }
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(fixture, 'jobs'))}, JSON.stringify(['start', process.pid]) + '\\n');
if (fs.existsSync(${JSON.stringify(path.join(fixture, 'stall'))})) setInterval(() => {}, 1000);
else setTimeout(() => {
  fs.writeFileSync(process.argv.at(-1), 'complete thumbnail');
  fs.appendFileSync(${JSON.stringify(path.join(fixture, 'jobs'))}, JSON.stringify(['end', process.pid]) + '\\n');
}, 100);
`, { mode: 0o755 });
  const port = process.env.PERF_PORT || '4398';
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server.mjs'], {
    cwd: root, env: { ...process.env, PORT: port, NODE_ENV: 'production', REELS_DIR: reels,
      PLANS_DIR: path.join(fixture, 'plans'), THUMBS_DIR: path.join(fixture, 'thumbs'), PATH: `${bin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => output += d);
  server.stderr.on('data', d => output += d);
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('→')) {
      if (server.exitCode !== null || Date.now() > deadline) throw Error(output);
      await new Promise(r => setTimeout(r, 30));
    }
    const url = `${base}/video/${projects[0]}`;
    for (const [range, status, start, end] of [
      ['bytes=0-1023', 206, 0, 1023], ['bytes=4000-', 206, 4000, 4095], ['bytes=-16', 206, 4080, 4095],
      ['bytes=-99999', 206, 0, 4095], ['bytes=0-99999', 206, 0, 4095], ['bytes=4096-', 416],
      ['bytes=30-20', 416], ['bytes=-0', 416], ['bytes=-', 416], ['bytes=99999999999999999999-', 416],
      ['bytes=0-1,3-4', 200, 0, 4095], ['bytes=bad', 200, 0, 4095],
    ]) {
      const r = await fetch(url, { headers: { range } });
      assert.equal(r.status, status, range);
      if (status === 416) assert.equal(r.headers.get('content-range'), 'bytes */4096');
      else assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(start, end + 1), range);
    }
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '4096');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const thumbs = await Promise.all(projects.map(async project => {
      const r = await fetch(`${base}/thumb/${project}`);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'complete thumbnail');
      return r;
    }));
    const etag = thumbs[0].headers.get('etag');
    assert.ok(etag);
    const unchanged = await fetch(`${base}/thumb/${projects[0]}`, { headers: { 'if-none-match': etag } });
    assert.equal(unchanged.status, 304);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    const active = new Set();
    let peak = 0;
    for (const [kind, pid] of fs.readFileSync(path.join(fixture, 'jobs'), 'utf8').trim().split('\n').map(JSON.parse)) {
      if (kind === 'start') active.add(pid); else active.delete(pid);
      peak = Math.max(peak, active.size);
    }
    assert.equal(peak, 2, 'all warming and requested thumbnails share two workers');
    assert.equal(active.size, 0);
    // A hung ffmpeg stands in for a render waiting on iCloud, without reading any private footage.
    fs.writeFileSync(path.join(fixture, 'stall'), '');
    const render = path.join(reels, projects[0], 'final.mp4');
    fs.utimesSync(render, new Date(), new Date(Date.now() + 2000));
    const started = performance.now();
    const stalled = fetch(`${base}/thumb/${projects[0]}`);
    const stateStart = performance.now();
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
    const stateMs = performance.now() - stateStart;
    assert.ok(stateMs < 1000, `state blocked for ${stateMs}ms`);
    assert.equal((await stalled).status, 500);
    const timeoutMs = performance.now() - started;
    assert.ok(timeoutMs < 12000, `ffmpeg did not time out: ${timeoutMs}`);
    assert.ok(!fs.readdirSync(path.join(fixture, 'thumbs')).some(n => n.includes('.tmp.')));
    fs.rmSync(path.join(fixture, 'stall'));
    const replaced = await fetch(`${base}/thumb/${projects[0]}`, { headers: { 'if-none-match': etag } });
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.headers.get('etag'), etag);
    assert.equal(await replaced.text(), 'complete thumbnail');
    // Encoded traversal and symlinks cannot expose files outside dist.
    for (const pathname of ['/%2e%2e%2fserver.mjs', '/assets/%2e%2e%2f%2e%2e%2fserver.mjs', '/%E0%A4%A', '/assets/missing.js']) {
      const r = await fetch(`${base}${pathname}`);
      assert.ok([400, 403, 404].includes(r.status), `${pathname}: ${r.status}`);
    }
    const asset = fs.readdirSync(path.join(root, 'dist/assets')).find(n => /^index-.*\.js$/.test(n));
    const gz = await fetch(`${base}/assets/${asset}`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.match(gz.headers.get('cache-control'), /immutable/);
    assert.equal(gz.headers.get('vary'), 'Accept-Encoding');
    assert.equal(await gz.text(), fs.readFileSync(path.join(root, 'dist/assets', asset), 'utf8'));
    const plain = await fetch(`${base}/assets/${asset}`, { headers: { 'accept-encoding': 'gzip;q=0, identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await plain.text(), fs.readFileSync(path.join(root, 'dist/assets', asset), 'utf8'));
    const saved = await fetch(`${base}/api/days/2026-10-12/scripts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fresh', title: 'Fresh plan' }) });
    assert.equal(saved.status, 200);
    const unsupportedMove = await fetch(`${base}/api/days/2026-10-12/scripts/fresh/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: '2026-10-13' }) });
    assert.equal(unsupportedMove.status, 404, 'unsupported child routes must not create a script');
    assert.equal((await (await fetch(`${base}/api/state`)).json()).days['2026-10-12'].scripts.length, 1);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).days['2026-10-12'].scripts[0].title, 'Fresh plan');
    console.log(`checks ok: ranges, HEAD, gzip, traversal, fresh plans, unsupported move cannot write, ETags, two thumbnail workers; stalled extraction ${timeoutMs.toFixed(0)}ms, concurrent state ${stateMs.toFixed(1)}ms`);
  } finally {
    server.kill();
    await new Promise(r => server.exitCode !== null || server.signalCode !== null ? r() : server.once('exit', r));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv.includes('--checks')) { await checks(); process.exit(0); }

const root = process.env.PERF_ROOT || path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reels-perf-'));
const port = process.env.PERF_PORT || '4398';
const base = `http://127.0.0.1:${port}`;
const dev = process.argv.includes('--dev');
const date = '2026-10-12';
fs.mkdirSync(path.join(temp, 'plans', date), { recursive: true });
fs.writeFileSync(path.join(temp, 'plans', date, 'fixture.md'), '---\ntitle: Performance fixture\n---\n' + 'A sentence about making a video.\n\n'.repeat(200));
let output = '';
const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server.mjs'], {
  cwd: root, env: { ...process.env, PORT: port, PLANS_DIR: path.join(temp, 'plans'), NODE_ENV: dev ? 'development' : 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => output += d);
child.stderr.on('data', d => output += d);
let browser;
let page;
const stats = a => {
  const sorted = [...a].sort((a, b) => a - b);
  return { median: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2), n: a.length };
};
const timed = async url => {
  const start = performance.now();
  const r = await fetch(url);
  const body = await r.arrayBuffer();
  assert.equal(r.status, 200);
  return { ms: performance.now() - start, bytes: body.byteLength };
};
try {
  const deadline = Date.now() + 15000;
  while (!output.includes('→')) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error(output || 'server startup timed out');
    await new Promise(r => setTimeout(r, 50));
  }
  const cold = await timed(`${base}/api/state`);
  const warm = [];
  for (let i = 0; i < 30; i++) warm.push((await timed(`${base}/api/state`)).ms);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.days[date].scripts[0].id, 'fixture');
  const media = state.videos.find(v => v.render && v.project.includes('jev')) || state.videos.find(v => v.render);
  const mediaResult = {};
  if (media) {
    mediaResult.project = media.project;
    mediaResult.thumbnail = await timed(`${base}/thumb/${media.project}`);
    const range = await fetch(`${base}/video/${media.project}`, { headers: { range: 'bytes=0-1023' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1024);
    mediaResult.range = range.headers.get('content-range');
    mediaResult.thumbCache = (await fetch(`${base}/thumb/${media.project}`)).headers.get('cache-control');
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
  await page.addInitScript(() => {
    window.__perf = { long: [], lcp: 0, commits: 0, inputs: [], rough: { line: 0, rectangle: 0, ellipse: 0, toPaths: 0 } };
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__perf.long.push({ start: e.startTime, duration: e.duration }))).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__perf.lcp = e.startTime)).observe({ type: 'largest-contentful-paint', buffered: true });
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(),
      inject(renderer) { this.renderers.set(1, renderer); return 1; },
      onCommitFiberRoot: () => window.__perf.commits++, onCommitFiberUnmount() {} };
    document.addEventListener('keydown', e => {
      if (e.key.length === 1 && e.target.isContentEditable) {
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => window.__perf.inputs.push(performance.now() - start)));
      }
    }, true);
  });
  if (dev) {
    // Instrument only the served module, never src/. Count geometry and SVG-path regeneration.
    await page.route('**/src/sketch.jsx', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = 'const gen = rough.generator();';
      assert.ok(source.includes(marker), 'roughjs instrumentation marker changed');
      await route.fulfill({ response, body: source.replace(marker, marker + `
        for (const name of ['line', 'rectangle', 'ellipse', 'toPaths']) {
          const original = gen[name].bind(gen);
          gen[name] = (...args) => { window.__perf.rough[name]++; return original(...args); };
        }
      `) });
    });
  }
  const loads = [];
  // Clear Chrome's cache between loads; OS filesystem cache stays warm.
  for (let i = 0; i < 7; i++) {
    if (i) { const cdp = await page.context().newCDPSession(page); await cdp.send('Network.clearBrowserCache'); await cdp.detach(); }
    await page.goto('about:blank');
    await page.goto(`${base}/#${date}`);
    await page.locator('.plan-row').waitFor();
    await page.waitForTimeout(700);
    loads.push(await page.evaluate(() => ({ fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, lcp: window.__perf.lcp, longMs: window.__perf.long.reduce((s, e) => s + e.duration, 0), longCount: window.__perf.long.length })));
  }
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(e => ({ name: e.name.split('/').pop(), type: e.initiatorType, bytes: e.encodedBodySize, transfer: e.transferSize, ms: e.duration })));
  const measureAction = async (selector, key) => page.evaluate(async ({ selector, key }) => {
    const commits = window.__perf.commits;
    const rough = { ...window.__perf.rough };
    const start = performance.now();
    if (selector) document.querySelector(selector).click();
    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ms: performance.now() - start, commits: window.__perf.commits - commits,
      rough: Object.fromEntries(Object.entries(rough).map(([name, n]) => [name, window.__perf.rough[name] - n])) };
  }, { selector, key });
  const month = [], day = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  for (let i = 0; i < 20; i++) month.push(await measureAction(`[aria-label="${i % 2 ? 'Previous' : 'Next'} month"]`));
  const monthProfile = (await cdp.send('Profiler.stop')).profile;
  await cdp.send('Profiler.start');
  for (let i = 0; i < 20; i++) day.push(await measureAction(null, i % 2 ? 'ArrowLeft' : 'ArrowRight'));
  const dayProfile = (await cdp.send('Profiler.stop')).profile;
  const open = () => page.evaluate(async () => {
    const start = performance.now();
    const ready = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.ProseMirror[contenteditable="true"]')) {
          observer.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - start));
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    document.querySelector('.plan-row').click();
    return ready;
  });
  // A new context gives a genuine cold editor chunk and script request.
  const coldPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await coldPage.addInitScript(() => {
    window.__editorLong = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__editorLong.push({ start: e.startTime, duration: e.duration }))).observe({ type: 'longtask', buffered: true });
  });
  await coldPage.goto(`${base}/#${date}`);
  await coldPage.waitForFunction(() => document.querySelector('.plan-row'), { polling: 'raf' });
  const coldEditorMs = await coldPage.evaluate(async () => {
    const start = performance.now();
    window.__editorStart = start;
    const ready = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.ProseMirror[contenteditable="true"]')) {
          observer.disconnect(); requestAnimationFrame(() => resolve(performance.now() - start));
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    document.querySelector('.plan-row').click();
    return ready;
  });
  const coldEditorWork = await coldPage.evaluate(() => ({ longTasks: window.__editorLong.filter(e => e.start >= window.__editorStart),
    resources: performance.getEntriesByType('resource').filter(e => e.startTime >= window.__editorStart || e.name.includes('Editor-')).map(e => ({ name: e.name.split('/').pop(), start: e.startTime - window.__editorStart, ms: e.duration })) }));
  await coldPage.close();
  const opens = [];
  for (let i = 0; i < 6; i++) {
    await page.locator('.plan-row').waitFor();
    opens.push(await open());
    if (i < 5) { await page.keyboard.press('Escape'); await page.locator('.calendar:not([inert])').waitFor(); }
  }
  await page.locator('.ProseMirror').click();
  await page.evaluate(() => { window.__perf.inputs = []; window.__perf.typingStart = window.__perf.commits; window.__perf.roughStart = { ...window.__perf.rough }; });
  await cdp.send('Profiler.start');
  await page.keyboard.type('Measuring typing latency in a representative twelve hundred word script. '.repeat(3), { delay: 20 });
  const typingProfile = (await cdp.send('Profiler.stop')).profile;
  await page.waitForTimeout(800);
  const typing = await page.evaluate(() => ({ samples: window.__perf.inputs, commits: window.__perf.commits - window.__perf.typingStart,
    rough: Object.fromEntries(Object.entries(window.__perf.roughStart).map(([name, n]) => [name, window.__perf.rough[name] - n])) }));
  assert.match(fs.readFileSync(path.join(temp, 'plans', date, 'fixture.md'), 'utf8'), /Measuring typing/);
  if (media) {
    await page.goto('about:blank');
    await page.goto(`${base}/#${media.date}`);
    await page.waitForFunction(project => [...document.querySelectorAll('.video-row')].some(el => el.querySelector('img')?.src.endsWith(project)), media.project);
    mediaResult.videoMetadataMs = await page.evaluate(async project => {
      const start = performance.now();
      const loaded = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          const video = document.querySelector('.video-detail video');
          if (!video) return;
          observer.disconnect();
          if (video.readyState >= 1) resolve(performance.now() - start);
          else video.addEventListener('loadedmetadata', () => resolve(performance.now() - start), { once: true });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      [...document.querySelectorAll('.video-row')].find(el => el.querySelector('img')?.src.endsWith(project)).click();
      return loaded;
    }, media.project);
  }
  assert.deepEqual(errors, []);
  const cpu = profile => {
    const names = new Map(profile.nodes.map(n => [n.id, n.callFrame.functionName || n.callFrame.url.split('/').pop()]));
    const counts = {};
    for (const id of profile.samples || []) counts[names.get(id)] = (counts[names.get(id)] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  };
  const result = { mode: dev ? 'dev' : 'production', root, api: { coldMs: +cold.ms.toFixed(2), warmMs: stats(warm), videos: state.videos.length }, media: mediaResult,
    load: { fcpMs: stats(loads.map(x => x.fcp)), lcpMs: stats(loads.map(x => x.lcp)), longTaskMs: stats(loads.map(x => x.longMs)), longTasks: loads.map(x => x.longCount) },
    month: { frameMs: stats(month.map(x => x.ms)), commits: month.map(x => x.commits), rough: dev ? month.map(x => x.rough) : undefined, cpu: cpu(monthProfile) },
    day: { frameMs: stats(day.map(x => x.ms)), commits: day.map(x => x.commits), rough: dev ? day.map(x => x.rough) : undefined, cpu: cpu(dayProfile) },
    editor: { coldOpenMs: coldEditorMs, coldWork: coldEditorWork, prewarmedOpenMs: stats(opens), typingFrameMs: stats(typing.samples), typingCommits: typing.commits, rough: dev ? typing.rough : undefined, cpu: cpu(typingProfile) }, resources };
  const receipt = process.env.PERF_OUT || path.join(temp, 'result.json');
  fs.writeFileSync(receipt, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`Receipt: ${receipt}`);
} catch (err) {
  console.error(await page?.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1800) })).catch(() => null));
  throw err;
} finally {
  await browser?.close();
  child.kill();
  await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
  // Keep the receipt, remove only this script's throwaway writing fixture.
  fs.rmSync(path.join(temp, 'plans'), { recursive: true, force: true });
}

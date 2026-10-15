// One process: JSON API over the reels folders + plan files, media, and the Vite app.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REELS = process.env.REELS_DIR || path.join(os.homedir(), 'Movies/reels');
const PLANS = process.env.PLANS_DIR || path.join(ROOT, 'plans');
const CACHE = process.env.THUMBS_DIR || path.join(ROOT, '.cache/thumbs');
const PORT = Number(process.env.PORT || 4321);
const PROD = process.env.NODE_ENV === 'production';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9-]{1,80}$/;

// ---------- past videos ----------

function loggedCuts() {
  const file = path.join(REELS, 'library/library.db');
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('select project, cut, ord, title, status, posted, views, verdict, record_json from videos').all();
  } finally {
    db.close();
  }
}

const RENDER_DIRS = ['', 'out', 'anim/out', 'film/out', 'edit/renders', 'renders'];
const NOT_FINAL = /draft|preview|picture|camera|skeleton|^_/i;

async function newestRender(dir) {
  // Dirs in priority order: a top-level render is the delivered cut; out/ dirs only when none exist.
  for (const sub of RENDER_DIRS) {
    let names;
    try { names = await fsp.readdir(path.join(dir, sub)); } catch { continue; }
    const mp4s = names.filter(n => n.endsWith('.mp4') && !NOT_FINAL.test(n));
    if (!mp4s.length) continue;
    const stats = await Promise.all(mp4s.map(n => fsp.stat(path.join(dir, sub, n)).then(s => [n, s.mtimeMs])));
    stats.sort((a, b) => b[1] - a[1]);
    return path.join(sub, stats[0][0]);
  }
  return null;
}

const WORDS = { api: 'API', ai: 'AI', openai: 'OpenAI', devday: 'DevDay', github: 'GitHub', forth: 'Forth', apple: 'Apple' };
const humanize = slug => slug.split('-').filter(w => w !== 'reel').map(w => WORDS[w] || w).join(' ').replace(/^[a-z]/, c => c.toUpperCase());

async function videos() {
  const cuts = loggedCuts();
  const names = (await fsp.readdir(REELS)).filter(n => /^\d{4}-\d{2}-\d{2}-/.test(n));
  return Promise.all(names.map(async project => {
    const made = project.slice(0, 10);
    const mine = cuts.filter(c => c.project === project);
    // Representative cut: the posted one with most views, else the latest.
    const best = [...mine].sort((a, b) => (!!b.posted - !!a.posted) || ((b.views || 0) - (a.views || 0)) || (b.ord - a.ord))[0];
    const rec = best ? JSON.parse(best.record_json) : null;
    let render = rec?.render || null;
    if (render && !fs.existsSync(path.join(REELS, project, render))) render = null;
    render ||= await newestRender(path.join(REELS, project));
    return {
      project,
      title: rec?.short || rec?.title || humanize(project.slice(11)),
      fullTitle: rec?.title || null,
      date: best?.posted || made,
      made,
      posted: best?.posted || null,
      views: best?.views ?? null,
      verdict: best?.verdict || null,
      status: best?.status || null,
      logged: !!best,
      render,
    };
  }));
}

// ---------- plans ----------
// plans/YYYY-MM-DD/notes.md is the day blurb; every other .md is one planned video.

const dayDir = date => path.join(PLANS, date);

function parseScript(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const field = k => m?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1].trim() || '';
  return { title: field('title'), project: field('project') || null, created: Number(field('created')) || null, body: m ? text.slice(m[0].length) : text };
}

// `project:` links a plan to the ~/Movies/reels folder it became.
// `created:` lives in the file because every atomic save replaces the file and resets its birthtime.
const serializeScript = ({ title, project, created, body }) =>
  `---\ntitle: ${String(title || '').replace(/\n/g, ' ')}\n${project ? `project: ${project}\n` : ''}${created ? `created: ${created}\n` : ''}---\n${body || ''}`;
const countWords = s => (s.replace(/[#>*_`~\-\[\]()]/g, ' ').match(/\S+/g) || []).length;

async function days() {
  const out = {};
  let dates;
  try { dates = (await fsp.readdir(PLANS)).filter(d => DATE.test(d)); } catch { return out; }
  await Promise.all(dates.map(async date => {
    const files = await fsp.readdir(dayDir(date));
    const day = { blurb: '', scripts: [] };
    await Promise.all(files.filter(f => f.endsWith('.md')).map(async f => {
      const text = await fsp.readFile(path.join(dayDir(date), f), 'utf8');
      if (f === 'notes.md') return void (day.blurb = text);
      const { title, project, created, body } = parseScript(text);
      const stat = created ? null : await fsp.stat(path.join(dayDir(date), f));
      day.scripts.push({ id: f.slice(0, -3), title, project, words: countWords(body), created: created ?? stat.birthtimeMs });
    }));
    day.scripts.sort((a, b) => a.created - b.created);
    if (day.blurb || day.scripts.length) out[date] = day;
  }));
  return out;
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- media ----------

const thumbJobs = new Map();
const thumbLanes = [Promise.resolve(), Promise.resolve()];
let nextThumbLane = 0;

// Thumbnails are keyed by render mtime, so a re-render gets a fresh frame automatically.
async function ensureThumb(project, render) {
  const src = path.join(REELS, project, render);
  const out = path.join(CACHE, `${project}-${Math.round((await fsp.stat(src)).mtimeMs)}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!thumbJobs.has(out)) {
    fs.mkdirSync(CACHE, { recursive: true });
    // ponytail: at most two ffmpeg jobs, including clicks; revisit for a multi-user server.
    // Frame at 1.5s skips black openers; write a temporary file so nobody serves a partial JPEG.
    const lane = nextThumbLane++ % 2;
    const job = thumbLanes[lane].catch(() => {}).then(async () => {
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      try {
        await new Promise((resolve, reject) =>
          execFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.5', '-i', src, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', tmp],
            { timeout: 10000, killSignal: 'SIGKILL' }, err => err ? reject(err) : resolve()));
        await fsp.rename(tmp, out);
        return out;
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    });
    thumbLanes[lane] = job;
    thumbJobs.set(out, job);
    job.finally(() => thumbJobs.delete(out)).catch(() => {});
  }
  return thumbJobs.get(out);
}

async function warmThumbs() {
  const queue = (await cachedVideos()).filter(v => v.render);
  // Two at a time: archived renders may need to come down from iCloud first.
  const worker = async () => { for (let v; (v = queue.shift());) await ensureThumb(v.project, v.render).catch(() => {}); };
  await Promise.all([worker(), worker()]);
}

let scan = null;
// ponytail: video metadata can lag disk by five seconds; plans are always read fresh.
const cachedVideos = () => (scan ||= videos().then(v => {
  setTimeout(() => (scan = null), 5000).unref();
  return v;
}, err => { scan = null; throw err; }));

function pipeFile(file, req, res, options) {
  if (res.destroyed) return;
  if (req.method === 'HEAD') return res.end();
  const input = fs.createReadStream(file, options);
  res.on('close', () => input.destroy());
  input.on('error', err => res.destroy(err));
  input.pipe(res);
}

async function stream(file, req, res) {
  const { size } = await fsp.stat(file);
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  // Ignore unsupported/malformed ranges; valid but unsatisfiable ranges get 416.
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': size });
    return pipeFile(file, req, res);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start || (!range[1] && !Number(range[2]))) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
  pipeFile(file, req, res, { start, end });
}

// ---------- http ----------

const json = (res, data, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

const body = req => new Promise((resolve, reject) => {
  let s = '';
  req.setEncoding('utf8');
  req.on('data', c => (s += c));
  req.on('end', () => resolve(s));
  req.on('error', reject);
});

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [, kind, a, b, c, d] = parts; // ['api', kind, ...]

  if (kind === 'state' && req.method === 'GET') {
    const [v, d] = await Promise.all([cachedVideos(), days()]);
    return json(res, { videos: v, days: d });
  }

  if (kind === 'days' && DATE.test(a)) {
    if (b === 'blurb' && req.method === 'PUT') {
      const text = await body(req);
      const file = path.join(dayDir(a), 'notes.md');
      if (text.trim()) await writeAtomic(file, text);
      else await fsp.rm(file, { force: true });
      return json(res, { ok: true });
    }
    if (b === 'scripts' && !c && req.method === 'POST') {
      const { title = '', id = newId() } = JSON.parse((await body(req)) || '{}');
      if (!ID.test(id)) return json(res, { error: 'bad id' }, 400);
      await writeAtomic(path.join(dayDir(a), `${id}.md`), serializeScript({ title, created: Date.now(), body: '' }));
      return json(res, { id });
    }
    if (b === 'scripts' && ID.test(c) && d === 'move' && req.method === 'POST') {
      const { to } = JSON.parse((await body(req)) || '{}');
      if (!DATE.test(to || '')) return json(res, { error: 'bad date' }, 400);
      await fsp.mkdir(dayDir(to), { recursive: true });
      try { await fsp.rename(path.join(dayDir(a), `${c}.md`), path.join(dayDir(to), `${c}.md`)); }
      catch { return json(res, { error: 'not found' }, 404); }
      return json(res, { ok: true });
    }
    if (b === 'scripts' && ID.test(c) && d === 'link' && req.method === 'POST') {
      const { project = null } = JSON.parse((await body(req)) || '{}');
      if (project !== null && !/^\d{4}-\d{2}-\d{2}-[\w.-]+$/.test(project)) return json(res, { error: 'bad project' }, 400);
      const file = path.join(dayDir(a), `${c}.md`);
      try { const doc = parseScript(await fsp.readFile(file, 'utf8')); doc.created ??= Math.round((await fsp.stat(file)).birthtimeMs); await writeAtomic(file, serializeScript({ ...doc, project })); }
      catch { return json(res, { error: 'not found' }, 404); }
      return json(res, { ok: true });
    }
    if (b === 'scripts' && ID.test(c) && !d) {
      const file = path.join(dayDir(a), `${c}.md`);
      if (req.method === 'GET') {
        try { return json(res, parseScript(await fsp.readFile(file, 'utf8'))); }
        catch { return json(res, { error: 'not found' }, 404); }
      }
      if (req.method === 'PUT') {
        // The editor sends title + body; keep whatever link the file already has unless told otherwise.
        const next = JSON.parse(await body(req));
        let project = null, created = null;
        try { ({ project, created } = parseScript(await fsp.readFile(file, 'utf8'))); created ??= (await fsp.stat(file)).birthtimeMs; } catch {}
        await writeAtomic(file, serializeScript({ project, created: created && Math.round(created), ...next }));
        return json(res, { ok: true });
      }
      if (req.method === 'DELETE') {
        // Never hard-delete writing: park it in plans/.trash.
        const trash = path.join(PLANS, '.trash');
        await fsp.mkdir(trash, { recursive: true });
        await fsp.rename(file, path.join(trash, `${a}-${c}.md`)).catch(() => {});
        return json(res, { ok: true });
      }
    }
  }
  json(res, { error: 'not found' }, 404);
}

async function media(req, res, url) {
  const [kind, project] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!/^\d{4}-\d{2}-\d{2}-[\w.-]+$/.test(project || '')) { res.writeHead(404); return res.end(); }
  const v = (await cachedVideos()).find(x => x.project === project);
  if (!v?.render) { res.writeHead(404); return res.end(); }
  if (kind === 'thumb') {
    const file = await ensureThumb(project, v.render);
    // The URL is stable across re-renders, so revalidate rather than showing yesterday's frame.
    const etag = `"${path.basename(file)}"`;
    const headers = { 'content-type': 'image/jpeg', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'content-length': (await fsp.stat(file)).size });
    return pipeFile(file, req, res);
  }
  return stream(path.join(REELS, project, v.render), req, res);
}

let vite;
const DIST = path.join(ROOT, 'dist');
async function staticFile(req, res, url) {
  const decoded = decodeURIComponent(url.pathname);
  let target = path.resolve(DIST, `.${decoded}`);
  if (!target.startsWith(`${DIST}${path.sep}`) && target !== DIST) { res.writeHead(403); return res.end(); }
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat?.isFile()) {
    if (path.extname(decoded)) { res.writeHead(404); return res.end(); }
    target = path.join(DIST, 'index.html');
  }
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  const headers = {
    'content-type': types[path.extname(target)] || 'application/octet-stream',
    'cache-control': target.startsWith(`${DIST}/assets/`) ? 'max-age=31536000, immutable' : 'no-cache',
    vary: 'Accept-Encoding',
  };
  const gzip = (req.headers['accept-encoding'] || '').split(',').some(part => {
    const [name, ...params] = part.trim().split(';');
    const q = params.find(p => p.trim().startsWith('q='));
    return name.trim() === 'gzip' && (!q || Number(q.trim().slice(2)) > 0);
  });
  if (gzip && fs.existsSync(`${target}.gz`)) { target += '.gz'; headers['content-encoding'] = 'gzip'; }
  const real = await fsp.realpath(target);
  if (!real.startsWith(`${DIST}${path.sep}`)) { res.writeHead(403); return res.end(); }
  headers['content-length'] = (await fsp.stat(target)).size;
  res.writeHead(200, headers);
  pipeFile(target, req, res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/thumb/') || url.pathname.startsWith('/video/')) return await media(req, res, url);
    if (vite) return vite.middlewares(req, res);
    return await staticFile(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, { error: String(err.message || err) }, err instanceof URIError ? 400 : 500);
    else res.destroy(err);
  }
});

if (!PROD) {
  const { createServer } = await import('vite');
  // HMR rides on this server's port, so several instances (dev + smoke test) never collide.
  vite = await createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`reels calendar → http://localhost:${PORT}`);
  warmThumbs().catch(console.error);
});

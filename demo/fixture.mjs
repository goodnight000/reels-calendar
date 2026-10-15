// Synthetic demo dataset for screenshots: `node demo/fixture.mjs [dir]` (default demo/.data).
// Writes <dir>/plans (markdown plans + notes) and <dir>/reels (project folders with generated renders
// and a library.db carrying title / posted / views / verdict). Nothing here comes from a real library.
// Every run wipes and rewrites plans/ and reels/; rendered covers are cached in <dir>/covers by content.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The demo month. capture.mjs freezes the browser clock to TODAY so the dataset never drifts.
export const TODAY = '2026-10-15';

// Finished videos. `made` is the project folder date; `posted` is where the calendar draws it.
const VIDEOS = [
  { slug: 'unix-time-2038', made: '2026-09-26', posted: '2026-09-28', short: 'Unix time runs out', title: 'In 2038, a lot of computers will think it is 1901', big: '2038', views: 18420, verdict: 'solid', bg: ['#2f4858', '#1d2d38'] },
  { slug: 'qwerty', made: '2026-09-29', posted: '2026-10-01', short: 'Why QWERTY won', title: 'QWERTY was never designed to slow you down', big: 'QWE', views: 6210, verdict: 'mid', bg: ['#6b4f3a', '#3f2e22'] },
  { slug: 'cpu-cache', made: '2026-09-30', posted: '2026-10-02', short: 'How a CPU cache works', title: 'Your CPU spends most of its life waiting for memory', big: 'L1', views: 41870, verdict: 'hit', bg: ['#3d5a4c', '#24382f'] },
  { slug: 'undersea-cables', made: '2026-10-02', posted: '2026-10-05', short: 'The internet is underwater', title: '99% of the internet crosses the ocean on cables this thick', big: '99%', views: 132400, verdict: 'breakout', bg: ['#27476e', '#172b44'] },
  { slug: 'floating-point', made: '2026-10-04', posted: '2026-10-06', short: '0.1 + 0.2 is not 0.3', title: 'Why 0.1 + 0.2 is not 0.3 in almost every language', big: '0.3', views: 9550, verdict: 'solid', bg: ['#5b4a6b', '#382d43'] },
  { slug: 'shazam', made: '2026-10-05', posted: '2026-10-08', short: 'How Shazam hears a song', title: 'Shazam turns a song into a constellation of points', big: 'Hz', views: 27300, verdict: 'hit', bg: ['#7a5c2e', '#4a371a'] },
  { slug: 'fax-machines', made: '2026-10-06', posted: '2026-10-08', short: 'Fax machines refuse to die', title: 'Why hospitals still run on fax machines', big: 'FAX', views: 3120, verdict: 'flop', bg: ['#4d5157', '#2c2f33'] },
  { slug: 'e-ink', made: '2026-10-07', posted: '2026-10-09', short: 'E-ink uses no power', title: 'An e-ink screen uses zero power to keep showing this', big: '0 W', views: 15800, verdict: 'solid', bg: ['#56624a', '#343c2c'] },
  { slug: 'ethernet', made: '2026-10-09', posted: '2026-10-12', short: 'Why Ethernet still wins', title: 'Wi-Fi got fast. Ethernet still wins, and here is why', big: '1 ms', views: 7400, verdict: 'mid', bg: ['#2e5e63', '#1b3a3d'] },
  { slug: 'jpeg', made: '2026-10-11', posted: '2026-10-13', short: 'How JPEG throws data away', title: 'JPEG throws away most of your photo and you never notice', big: '8×8', views: 22950, verdict: 'hit', bg: ['#6e3b3b', '#432323'] },
  { slug: 'passkeys', made: '2026-10-12', posted: '2026-10-14', short: 'Passkeys, explained', title: 'Passkeys, explained in one minute', big: 'FIDO', views: 1980, verdict: null, bg: ['#3b4a6e', '#232c43'] },
  // Finished today, not logged or linked yet: the app offers it as a match for today's plan.
  { slug: 'flash-memory-forgets', made: TODAY, big: 'SSD', bg: ['#4a3f63', '#2b243b'], cover: 'Why SSDs slowly forget' },
];

const URL_SCRIPT = `# Hook

You press Enter. In the next tenth of a second, your laptop talks to at least four computers you have never heard of.

## Find the address

Your browser has no idea where the site lives, so it asks a DNS resolver, and the resolver goes looking.

- A root server says: ask the .com servers.
- The .com server says: ask the site's own nameserver.
- The nameserver finally answers with an IP address.

## Shake hands

Now it opens a connection and runs a TLS handshake. Both sides agree on a secret key without ever sending that key across the wire.

## The actual page

Only then does it send one short line asking for the page. The server answers with HTML, and the browser immediately asks for every stylesheet, font and image that HTML points to.

## Payoff

All of that happens every single time, faster than you can blink. On camera: snap on "blink".
`;

// Plans: one markdown file each. `created` (frontmatter, ms) orders a day's plans and decides whether a
// finished render could be the video a plan became.
const PLANS = [
  { date: '2026-10-11', id: 'jpeg', created: '2026-10-03', title: 'How JPEG throws away data', project: '2026-10-11-jpeg',
    body: '# Hook\n\nThis photo is 90% gone, and you cannot tell.\n\n- 8×8 blocks\n- keep the shapes, drop the detail\n' },
  { date: TODAY, id: 'ssd-forget', created: '2026-10-09', title: 'Why SSDs forget',
    body: '# Hook\n\nUnplug an SSD for a few years and it can lose files on its own.\n\nEvery bit is a few hundred electrons stuck in a trap, and they leak out a little at a time. Heat makes them leak faster.\n' },
  { date: '2026-10-16', id: 'wifi-microwave', created: '2026-10-10', title: 'Microwaves vs Wi-Fi',
    body: 'Why your video call stutters when someone heats up lunch.\n\nBoth live at 2.4 GHz because nobody needed a license for it.\n' },
  { date: '2026-10-19', id: 'type-a-url', created: '2026-10-11', title: 'What happens when you type a URL', body: URL_SCRIPT },
  { date: '2026-10-20', id: 'usb-c', created: '2026-10-12', title: 'USB-C cables all look alike', body: '' },
  { date: '2026-10-22', id: 'gps-einstein', created: '2026-10-12', title: 'GPS needs Einstein',
    body: 'Satellite clocks run 38 microseconds a day fast. Without relativity, your blue dot drifts 10 km a day.\n' },
  { date: '2026-10-22', id: 'anc', created: '2026-10-13', title: 'Noise-cancelling, explained', body: '' },
  { date: '2026-10-26', id: 'knight-capital', created: '2026-10-13', title: 'The $440M bug',
    body: '# Hook\n\nOne old flag, reused. 45 minutes. $440 million.\n\nTell it as a countdown.\n' },
  { date: '2026-10-27', id: 'cold-batteries', created: '2026-10-14', title: 'Cold kills batteries', body: '' },
  { date: '2026-10-29', id: 'qr-damage', created: '2026-10-14', title: 'QR codes survive damage', body: '' },
  { date: '2026-11-03', id: 'time-zones', created: '2026-10-14', title: 'Time zones are a mess', body: '' },
];

const NOTES = {
  [TODAY]: 'Record the voiceover for the SSD one before lunch.\nCover: the drive glowing, not the chip.',
  '2026-10-22': 'Film GPS and noise-cancelling back to back, same desk setup.',
  '2026-10-02': 'Cache video ran 4s long. Cut the second analogy next time.',
};

const font = pathToFileURL(path.join(ROOT, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2')).href;

const coverHtml = v => `<!doctype html><html><head><style>
@font-face { font-family: B; src: url('${font}') format('woff2'); font-weight: 200 800; }
html, body { margin: 0; }
body { width: 720px; height: 1280px; overflow: hidden; font-family: B; color: #efece6;
  background: radial-gradient(120% 80% at 20% 15%, ${v.bg[0]} 0%, ${v.bg[1]} 70%); }
.big { position: absolute; left: 64px; right: 40px; top: 210px; font-size: ${v.big.length > 3 ? 210 : 260}px; font-weight: 800;
  line-height: 0.9; letter-spacing: -0.04em; color: rgba(239, 236, 230, 0.16); white-space: nowrap; }
.rule { position: absolute; left: 68px; top: 720px; width: 72px; height: 6px; border-radius: 3px; background: rgba(239, 236, 230, 0.55); }
.title { position: absolute; left: 64px; right: 64px; top: 760px; font-size: 76px; font-weight: 720; line-height: 1.02; letter-spacing: -0.025em; }
</style></head><body><div class="big">${v.big}</div><div class="rule"></div><div class="title">${v.cover || v.short}</div></body></html>`;

async function renderCovers(videos, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const todo = videos.filter(v => !fs.existsSync(v.cached));
  if (!todo.length) return;
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 2 });
    for (const v of todo) {
      const html = path.join(dir, `${v.hash}.html`), png = path.join(dir, `${v.hash}.png`);
      fs.writeFileSync(html, coverHtml(v));
      await page.goto(pathToFileURL(html).href);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: png });
      // Four seconds with a slow push-in, so the inline player has something to play.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png,
        '-vf', "zoompan=z='1+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=120:s=720x1280:fps=30,format=yuv420p",
        '-frames:v', '120', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', `${v.cached}.tmp.mp4`]);
      fs.renameSync(`${v.cached}.tmp.mp4`, v.cached);
      fs.rmSync(html); fs.rmSync(png);
    }
  } finally {
    await browser.close();
  }
}

export async function build(dir = path.join(ROOT, 'demo/.data')) {
  const plans = path.join(dir, 'plans'), reels = path.join(dir, 'reels'), covers = path.join(dir, 'covers');
  fs.rmSync(plans, { recursive: true, force: true });
  fs.rmSync(reels, { recursive: true, force: true });

  const vids = VIDEOS.map(v => {
    const hash = createHash('sha1').update(coverHtml(v)).digest('hex').slice(0, 12);
    return { ...v, project: `${v.made}-${v.slug}`, hash, cached: path.join(covers, `${hash}.mp4`) };
  });
  await renderCovers(vids, covers);

  fs.mkdirSync(path.join(reels, 'library'), { recursive: true });
  const db = new DatabaseSync(path.join(reels, 'library/library.db'));
  db.exec(`create table videos (id text primary key, project text not null, cut text not null, ord integer not null,
    title text not null, file text not null, status text, posted text, views real, verdict text, record_json text not null)`);
  const insert = db.prepare('insert into videos values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const v of vids) {
    fs.mkdirSync(path.join(reels, v.project));
    // A hard link keeps the render's mtime, so the server's thumbnail cache survives a reset.
    fs.linkSync(v.cached, path.join(reels, v.project, `${v.slug}.mp4`));
    if (!v.posted) continue;
    const record = { title: v.title, short: v.short, render: `${v.slug}.mp4` };
    insert.run(`${v.project}/main`, v.project, 'main', 1, v.title, `${v.slug}.mp4`, 'posted', v.posted, v.views, v.verdict, JSON.stringify(record));
  }
  db.close();

  PLANS.forEach((p, i) => {
    const file = path.join(plans, p.date, `${p.id}.md`);
    const created = new Date(`${p.created}T09:00:00`).getTime() + i * 60000;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ntitle: ${p.title}\n${p.project ? `project: ${p.project}\n` : ''}created: ${created}\n---\n${p.body}`);
  });
  for (const [date, text] of Object.entries(NOTES)) {
    fs.mkdirSync(path.join(plans, date), { recursive: true });
    fs.writeFileSync(path.join(plans, date, 'notes.md'), text);
  }
  return { plans, reels };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await build(process.argv[2] && path.resolve(process.argv[2]));
  console.log(`plans: ${out.plans}\nreels: ${out.reels}`);
}

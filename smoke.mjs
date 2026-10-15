// End-to-end check in real Chrome against a throwaway plans dir: `node smoke.mjs`
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PORT = 4399;
const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'reels-plans-'));
// Reels fixture: the real projects (symlinked) plus one finished render made yesterday, so linking has a candidate.
const realReels = path.join(os.homedir(), 'Movies/reels');
const reels = fs.mkdtempSync(path.join(os.tmpdir(), 'reels-dir-'));
for (const name of fs.readdirSync(realReels)) fs.symlinkSync(path.join(realReels, name), path.join(reels, name));
// Made yesterday (inside the matcher's one-day grace) so it sits nearest the 14th's plan, not tied with the 16th's.
const d = new Date(Date.now() - 864e5), made = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fixture = `${made}-smoke-render`;
fs.mkdirSync(path.join(reels, fixture));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x2f56c4:s=180x320:d=2', path.join(reels, fixture, 'smoke-render.mp4')]);
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server.mjs'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: { ...process.env, PORT: String(PORT), PLANS_DIR: plans, REELS_DIR: reels },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(r => server.stdout.on('data', d => String(d).includes('→') && r()));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const shot = name => page.screenshot({ path: `/tmp/rc-${name}.png` });
// The route lives in history.state, not the URL, so the rail's heading is what says which day is selected.
const railDay = () => page.locator('.rail-head h2').innerText();
const cleanUrl = () => assert.equal(new URL(page.url()).hash, '', 'the URL stays clean');

try {
  await page.goto(`http://localhost:${PORT}/#2026-10-12`);
  await page.waitForSelector('.cell .entry.video img');
  await shot('calendar');

  // A typed hash jumps to its day and is wiped; clicking a day selects it without touching the URL.
  assert.equal(await railDay(), 'October 12');
  cleanUrl();
  await page.locator('[data-date="2026-10-13"]').click();
  assert.equal(await railDay(), 'October 13');
  cleanUrl();

  // Keyboard: a day right, n, type, Enter adds a planned video.
  await page.keyboard.press('ArrowRight');
  assert.equal(await railDay(), 'October 14');
  await page.keyboard.press('n');
  await page.keyboard.type('Why EUV machines cost $400M');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Bluetooth logo is a Viking king');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.rows .plan-row >> nth=1');

  // Day notes autosave.
  await page.locator('textarea.notes').fill('Film both on Tuesday.\nNeed the ASML b-roll.');
  await page.waitForTimeout(700);
  assert.equal(fs.readFileSync(path.join(plans, '2026-10-14/notes.md'), 'utf8'), 'Film both on Tuesday.\nNeed the ASML b-roll.');
  await shot('day');

  // Open a script, write in it, autosave lands as markdown.
  await page.locator('.plan-row', { hasText: 'EUV' }).click();
  await page.waitForSelector('.ProseMirror');
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('# Hook\nImagine you have to hit a falling droplet with a laser.\n- 50,000 times a second\ntwice per droplet');
  await page.waitForTimeout(800);
  await shot('editor');
  const file = fs.readdirSync(path.join(plans, '2026-10-14')).find(f => f !== 'notes.md' && fs.readFileSync(path.join(plans, '2026-10-14', f), 'utf8').includes('EUV'));
  const md = fs.readFileSync(path.join(plans, '2026-10-14', file), 'utf8');
  assert.match(md, /^---\ntitle: Why EUV machines cost \$400M\ncreated: \d+\n---\n/);
  assert.match(md, /# Hook/);
  assert.match(md, /- 50,000 times a second\n- twice per droplet/);
  assert.equal(await page.locator('.selection').isVisible(), false, 'calendar must be hidden under the editor');

  // Escape returns to the calendar; the plan shows on the 14th with its word count in the rail.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.calendar:not([inert])');
  assert.equal(await page.locator('.cell .entry.plan').count(), 2);
  assert.match(await page.locator('.plan-row', { hasText: 'EUV' }).innerText(), /\d+ words/);

  // Reload: everything comes back from disk.
  await page.reload();
  await page.waitForSelector('.cell .entry.plan >> nth=1');
  assert.equal(await page.locator('textarea.notes').inputValue(), 'Film both on Tuesday.\nNeed the ASML b-roll.');

  // Drag a plan from the 14th to the 16th: the file moves on disk.
  await page.locator('[data-date="2026-10-14"] .entry.plan', { hasText: 'Viking' }).dragTo(page.locator('[data-date="2026-10-16"]'));
  await page.waitForSelector('[data-date="2026-10-16"] .entry.plan');
  await page.waitForTimeout(300);
  const moved = fs.readdirSync(path.join(plans, '2026-10-16'));
  assert.equal(moved.length, 1);
  assert.match(fs.readFileSync(path.join(plans, '2026-10-16', moved[0]), 'utf8'), /Viking/);
  assert.equal(await railDay(), 'October 16');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');

  // An opened-and-abandoned blank script leaves nothing behind.
  await page.keyboard.press('n');
  await page.keyboard.press('Meta+Enter');
  await page.waitForSelector('.doc-title');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.cell .entry.plan').count(), 2);
  assert.equal(fs.readdirSync(path.join(plans, '2026-10-14')).length, 2, 'notes.md + EUV script only');

  // A video made since the plan was written is offered; linking inks the plan into that video.
  const suggestion = page.locator('.plan-item', { hasText: 'EUV' }).locator('.suggest-link');
  {
    assert.equal(await suggestion.count(), 1, 'a finished render made since planning should be offered');
    await page.locator('.plan-item', { hasText: 'EUV' }).hover();
    await shot('suggest');
    await suggestion.click();
    await page.waitForTimeout(300);
    assert.match(fs.readFileSync(path.join(plans, '2026-10-14', file), 'utf8'), /^---\ntitle: Why EUV machines cost \$400M\nproject: \d{4}-\d{2}-\d{2}-/);
    assert.equal(await page.locator('[data-date="2026-10-14"] .entry.plan').count(), 0);
    await page.goto(`http://localhost:${PORT}/#2026-10-12`); await page.waitForSelector('.video-row'); await shot('linked'); await page.goto(`http://localhost:${PORT}/#2026-10-14`); await page.waitForSelector('.cell');
    assert.equal(await page.locator('.video-row', { hasText: 'planned Oct 14' }).count() + await page.locator('.cell .entry.video', { hasText: 'EUV' }).count() > 0, true);
    // Editing a linked script keeps the link.
    await page.locator('.cell .entry.video', { hasText: 'EUV' }).first().click();
    await page.locator('.link-btn', { hasText: 'Open script' }).click();
    await page.locator('.ProseMirror').click();
    await page.keyboard.type(' More.');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.match(fs.readFileSync(path.join(plans, '2026-10-14', file), 'utf8'), /project: .*[\s\S]*More\./);
  }

  // Deleting asks first: Esc keeps the plan, Enter confirms and moves it to the trash.
  await page.goto(`http://localhost:${PORT}/#2026-10-16`);
  const vikingRow = page.locator('.rows li', { hasText: 'Viking' });
  await vikingRow.hover();
  await vikingRow.locator('.row-delete').click();
  await page.waitForSelector('dialog.confirm[open]');
  await page.waitForTimeout(250);
  await shot('confirm');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.confirm:not([open])', { state: 'attached' });
  assert.equal(await vikingRow.count(), 1);
  assert.equal(await railDay(), 'October 16', 'Esc in the dialog must not reach the app');
  await vikingRow.hover();
  await vikingRow.locator('.row-delete').click();
  await page.waitForSelector('dialog.confirm[open]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.equal(await vikingRow.count(), 0);
  const trash = path.join(plans, '.trash');
  assert.ok(fs.readdirSync(trash).some(f => fs.readFileSync(path.join(trash, f), 'utf8').includes('Viking')));
  assert.equal(await railDay(), 'October 16', 'Enter in the dialog must not reach the app');

  // Blank lines survive a reload: Shift+Enter and Enter both leave empty paragraphs that round-trip.
  await page.goto(`http://localhost:${PORT}/#2026-10-20`);
  await page.keyboard.press('n');
  await page.keyboard.type('Blank lines');
  await page.keyboard.press('Meta+Enter');
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('One');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Three');
  const blocks = () => page.$$eval('.ProseMirror > *', els => els.map(e => `${e.tagName}:${e.textContent}`));
  const typed = await blocks();
  assert.deepEqual(typed, ['P:One', 'P:', 'P:Two', 'P:', 'P:Three']);
  await page.waitForSelector('.save-mark.ic-play:not(.saving)');
  await shot('blank-lines');
  // Reload keeps the open script (the route survives in history.state) and its paragraphs.
  await page.reload();
  await page.waitForSelector('.ProseMirror p >> nth=4');
  assert.deepEqual(await blocks(), typed);
  cleanUrl();

  // Back closes the script and keeps the day; reload keeps the day.
  await page.goBack();
  await page.waitForSelector('.calendar:not([inert])');
  assert.equal(await page.locator('.ProseMirror').count(), 0);
  assert.equal(await railDay(), 'October 20');
  await page.reload();
  await page.waitForSelector('.rail-head h2');
  assert.equal(await railDay(), 'October 20');
  cleanUrl();

  // Visiting a hash jumps there, then the URL is clean again.
  await page.goto(`http://localhost:${PORT}/#2026-12-25`);
  await page.waitForSelector('.cell');
  assert.equal(await railDay(), 'December 25');
  assert.match(await page.locator('.cal-head h1').innerText(), /December/);
  cleanUrl();

  // Past video plays in the rail.
  await page.goto(`http://localhost:${PORT}/#2026-09-19`);
  await page.locator('.video-row', { hasText: 'Jev' }).click();
  await page.waitForFunction(() => document.querySelector('.video-detail video')?.readyState >= 1);
  await shot('video');

  assert.deepEqual(errors, []);
  console.log('smoke ok');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(plans, { recursive: true, force: true });
  fs.rmSync(reels, { recursive: true, force: true });
}

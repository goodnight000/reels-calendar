import { createElement, useLayoutEffect, useState } from 'react';
import { icon } from './vendor/charade/icons.js';

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
export const monthOf = s => s.slice(0, 7);
export const addMonths = (m, n) => { const d = parse(`${m}-01`); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); };

// Charade icons are SVG strings; display: contents keeps the wrapper out of layout.
export const Icon = ({ name, size = 16 }) =>
  createElement('span', { style: { display: 'contents' }, dangerouslySetInnerHTML: { __html: icon(name, { size }) } });

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Spoken pace for short-form: ~150 words a minute.
export const runtime = words => {
  const s = Math.round((words / 150) * 60);
  return s < 60 ? `~${s}s` : `~${Math.floor(s / 60)}m ${pad(s % 60)}s`;
};

export const countWords = s => (s.replace(/[#>*_`~\-[\]()]/g, ' ').match(/\S+/g) || []).length;

// Textareas grow with their text via CSS `field-sizing`; measure by hand only where it's unsupported.
const nativeSizing = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
export function useAutosize(ref, value) {
  useLayoutEffect(() => {
    if (nativeSizing) return;
    const el = ref.current;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

export function useSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect;
      setSize(s => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const json = { 'content-type': 'application/json' };
const scriptCache = new Map();

export const api = {
  state: () => fetch('/api/state').then(r => r.json()),
  saveBlurb: (date, text) => fetch(`/api/days/${date}/blurb`, { method: 'PUT', body: text, keepalive: true }),
  createScript: (date, id, title) => {
    scriptCache.set(`${date}/${id}`, Promise.resolve({ title, body: '' }));
    return fetch(`/api/days/${date}/scripts`, { method: 'POST', headers: json, body: JSON.stringify({ id, title }) });
  },
  // Cached so hovering a row warms the editor and opening feels instant.
  getScript: (date, id) => {
    const key = `${date}/${id}`;
    if (!scriptCache.has(key)) scriptCache.set(key, fetch(`/api/days/${date}/scripts/${id}`).then(r => r.json()));
    return scriptCache.get(key);
  },
  saveScript: (date, id, doc) => {
    scriptCache.set(`${date}/${id}`, Promise.resolve(doc));
    const body = JSON.stringify(doc);
    // keepalive lets a save finish after the tab closes, but browsers cap its body at 64 KB.
    return fetch(`/api/days/${date}/scripts/${id}`, { method: 'PUT', headers: json, body, keepalive: body.length < 60000 });
  },
  moveScript: (from, id, to) => {
    const doc = scriptCache.get(`${from}/${id}`);
    scriptCache.delete(`${from}/${id}`);
    if (doc) scriptCache.set(`${to}/${id}`, doc);
    return fetch(`/api/days/${from}/scripts/${id}/move`, { method: 'POST', headers: json, body: JSON.stringify({ to }) });
  },
  linkScript: (date, id, project) =>
    fetch(`/api/days/${date}/scripts/${id}/link`, { method: 'POST', headers: json, body: JSON.stringify({ project }) }),
  deleteScript: (date, id) => {
    scriptCache.delete(`${date}/${id}`);
    return fetch(`/api/days/${date}/scripts/${id}`, { method: 'DELETE' });
  },
};

// Pair finished, unlinked videos with the plans they most likely became, one to one, nearest first.
// A candidate was made after the plan was written (a day's grace) and within 3 days before to 14 days after its date.
export function matchPlans(days, videos) {
  const pairs = [];
  for (const [date, day] of Object.entries(days))
    for (const s of day.scripts) {
      if (s.project) continue;
      const written = addDays(ymd(new Date(s.created)), -1), lo = addDays(date, -3), hi = addDays(date, 14);
      for (const v of videos)
        if (v.render && !v.plan && v.made >= written && v.made >= lo && v.made <= hi)
          pairs.push({ id: s.id, v, dist: Math.abs(parse(v.made) - parse(date)), created: s.created });
    }
  pairs.sort((a, b) => a.dist - b.dist || a.created - b.created);
  const out = {}, taken = new Set();
  for (const p of pairs) if (!out[p.id] && !taken.has(p.v.project)) { out[p.id] = p.v; taken.add(p.v.project); }
  return out;
}

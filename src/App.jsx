import { lazy, Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Calendar from './Calendar.jsx';
import Rail from './Rail.jsx';
import { addDays, addMonths, api, matchPlans, monthOf, newId, ymd } from './lib.js';

const loadEditor = () => import('./Editor.jsx');
const Editor = lazy(loadEditor);

// The URL stays clean: the route lives in history.state, so Back and reload still work.
// Typing a hash jumps there and is then wiped: #2026-10-14, #2026-10-14/s/<script id>, #2026-10-14/v/<project>
function readRoute() {
  const [date, kind, id] = location.hash.slice(1).split('/');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date))
    return { date, doc: kind === 's' ? id : null, video: kind === 'v' ? decodeURIComponent(id) : null };
  return history.state?.route || { date: ymd(new Date()), doc: null, video: null };
}

function writeRoute(route, push) {
  // React may run the state updater that calls this twice; never push the same route twice.
  if (!location.hash && JSON.stringify(history.state?.route) === JSON.stringify(route)) return;
  history[push ? 'pushState' : 'replaceState']({ route }, '', location.pathname + location.search);
}

const isTyping = el => el.closest('input, textarea, [contenteditable="true"]');

export default function App() {
  const [data, setData] = useState({ videos: [], days: {} });
  const [route, setRouteState] = useState(readRoute);
  const [month, setMonth] = useState(() => monthOf(route.date));
  const newInput = useRef(null);
  const today = ymd(new Date());

  const setRoute = useCallback((next, push = false) => {
    setRouteState(prev => {
      const r = { ...prev, doc: null, video: null, ...next };
      writeRoute(r, push);
      return r;
    });
    if (next.date) setMonth(monthOf(next.date));
  }, []);

  useEffect(() => {
    const refresh = () => api.state().then(d => setData({ ...d, ready: true }));
    refresh();
    // New renders land while the tab sits in the background; pick them up on return.
    window.addEventListener('focus', refresh);
    writeRoute(readRoute(), false);
    const onPop = () => { const r = readRoute(); writeRoute(r, false); setRouteState(r); setMonth(monthOf(r.date)); };
    window.addEventListener('popstate', onPop);
    // Warm the editor chunk once the calendar has painted.
    requestIdleCallback?.(loadEditor) ?? setTimeout(loadEditor, 500);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('popstate', onPop); };
  }, []);

  // A plan linked to a project folder is drawn as that video, inked, on the video's date.
  const videos = useMemo(() => {
    const plans = {};
    for (const [date, day] of Object.entries(data.days))
      for (const s of day.scripts) if (s.project) plans[s.project] = { date, id: s.id, title: s.title };
    return data.videos.map(v => {
      const plan = plans[v.project];
      return plan ? { ...v, plan, title: v.logged ? v.title : plan.title || v.title } : v;
    });
  }, [data.videos, data.days]);

  const suggestions = useMemo(() => matchPlans(data.days, videos), [data.days, videos]);

  const videosByDate = useMemo(() => {
    const m = {};
    for (const v of videos) (m[v.date] ||= []).push(v);
    return m;
  }, [videos]);

  const updateDay = useCallback((date, fn) => {
    setData(d => {
      const day = fn(d.days[date] || { blurb: '', scripts: [] });
      return { ...d, days: { ...d.days, [date]: day } };
    });
  }, []);

  const actions = useMemo(() => ({
    select: date => setRoute({ date }),
    openScript: (date, id) => startTransition(() => setRoute({ date, doc: id }, true)),
    openVideo: (date, project) => setRoute({ date, video: project }, true),
    close: () => setRoute({}),
    createScript: (date, title, open) => {
      const id = newId();
      updateDay(date, day => ({ ...day, scripts: [...day.scripts, { id, title, words: 0, created: Date.now() }] }));
      api.createScript(date, id, title);
      if (open) startTransition(() => setRoute({ date, doc: id }, true));
    },
    planOn: date => {
      setRoute({ date });
      // Focus after the rail re-renders for the new day.
      requestAnimationFrame(() => newInput.current?.focus());
    },
    moveScript: (from, id, to) => {
      if (from === to) return;
      setData(d => {
        const src = d.days[from] || { blurb: '', scripts: [] };
        const s = src.scripts.find(x => x.id === id);
        if (!s) return d;
        const dst = d.days[to] || { blurb: '', scripts: [] };
        return { ...d, days: { ...d.days, [from]: { ...src, scripts: src.scripts.filter(x => x.id !== id) }, [to]: { ...dst, scripts: [...dst.scripts, s] } } };
      });
      api.moveScript(from, id, to);
      setRoute({ date: to });
    },
    linkScript: (date, id, project) => {
      updateDay(date, day => ({ ...day, scripts: day.scripts.map(s => (s.id === id ? { ...s, project } : s)) }));
      api.linkScript(date, id, project);
    },
    deleteScript: (date, id) => {
      updateDay(date, day => ({ ...day, scripts: day.scripts.filter(s => s.id !== id) }));
      api.deleteScript(date, id);
    },
    patchScript: (date, id, patch) =>
      updateDay(date, day => ({ ...day, scripts: day.scripts.map(s => (s.id === id ? { ...s, ...patch } : s)) })),
    saveBlurb: (date, text) => {
      updateDay(date, day => ({ ...day, blurb: text }));
      api.saveBlurb(date, text);
    },
  }), [setRoute, updateDay]);

  useEffect(() => {
    const onKey = e => {
      // A modal owns the keyboard (Enter confirms, Esc cancels) while it's open.
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape' && (route.doc || route.video)) { e.preventDefault(); return actions.close(); }
      if (isTyping(e.target) || route.doc) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (step) { e.preventDefault(); return actions.select(addDays(route.date, step)); }
      if (e.key === 't') return actions.select(today);
      if (e.key === '[' || e.key === 'PageUp') return setMonth(m => addMonths(m, -1));
      if (e.key === ']' || e.key === 'PageDown') return setMonth(m => addMonths(m, 1));
      if (e.key === 'n' || e.key === 'Enter') { e.preventDefault(); newInput.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, actions, today]);

  const day = data.days[route.date] || { blurb: '', scripts: [] };
  const docMeta = route.doc && day.scripts.find(s => s.id === route.doc);

  return (
    <div className="app">
      <main className="main">
        <Calendar
          month={month}
          setMonth={setMonth}
          today={today}
          selected={route.date}
          days={data.days}
          videosByDate={videosByDate}
          actions={actions}
          hidden={!!route.doc}
        />
        <Suspense fallback={null}>
          {route.doc && (
            <Editor
              key={`${route.date}/${route.doc}`}
              date={route.date}
              id={route.doc}
              initialTitle={docMeta?.title ?? ''}
              actions={actions}
            />
          )}
        </Suspense>
      </main>
      <Rail
        date={route.date}
        today={today}
        day={day}
        videos={videosByDate[route.date] || []}
        suggestions={suggestions}
        openDoc={route.doc}
        openVideo={route.video}
        actions={actions}
        newInput={newInput}
        ready={data.ready}
      />
    </div>
  );
}

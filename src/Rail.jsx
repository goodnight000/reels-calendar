import { useEffect, useMemo, useRef, useState } from 'react';
import { Sketch, line, rect } from './sketch.jsx';
import { Icon, api, parse, runtime, useAutosize, useSize } from './lib.js';
import { PLAN_MIME } from './Calendar.jsx';

function relative(date, today) {
  const days = Math.round((parse(date) - parse(today)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

function Edge() {
  const ref = useRef(null);
  const { h } = useSize(ref);
  const shape = useMemo(() => (h ? [line(1.5, 0, 1.5, h, { seed: 3 })] : []), [h]);
  return <div className="rail-edge" ref={ref}><Sketch shape={shape} /></div>;
}

function AutoText({ value, onChange, className, placeholder, inputRef, onKeyDown }) {
  const ref = useRef(null);
  useAutosize(ref, value);
  return (
    <textarea
      ref={el => { ref.current = el; if (inputRef) inputRef.current = el; }}
      className={className}
      value={value}
      placeholder={placeholder}
      rows={1}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

function Notes({ date, initial, save }) {
  const [text, setText] = useState(initial);
  const timer = useRef();
  const latest = useRef(initial);
  // Flush a pending save when switching days or leaving.
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); save(date, latest.current); }
  }, [date, save]);
  const onChange = v => {
    setText(v);
    latest.current = v;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; save(date, v); }, 400);
  };
  return <AutoText className="notes" value={text} onChange={onChange} placeholder="Notes for this day" />;
}

function NewVideo({ date, create, inputRef }) {
  const [title, setTitle] = useState('');
  const [made, setMade] = useState(0);
  const onKeyDown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!title.trim() && !e.metaKey) return;
      create(date, title.trim(), e.metaKey);
      setTitle('');
      setMade(n => n + 1);
    }
    if (e.key === 'Escape') { setTitle(''); e.currentTarget.blur(); }
  };
  return (
    <div className="new-video">
      {/* A fresh key remounts the icon, which replays it. */}
      <span className={`plus${made ? ' ic-play' : ''}`}><Icon key={made} name="plus" size={14} /></span>
      <AutoText inputRef={inputRef} className="new-input" value={title} onChange={setTitle} onKeyDown={onKeyDown} placeholder="Plan a video" />
    </div>
  );
}

function VideoDetail({ video, back, actions }) {
  return (
    <div className="video-detail">
      <button className="back" onClick={back}>‹ Back to day</button>
      <video key={video.project} src={`/video/${video.project}`} poster={`/thumb/${video.project}`} controls autoPlay playsInline preload="metadata" />
      <h3>{video.fullTitle || video.title}</h3>
      <dl className="facts">
        {video.posted ? <><dt>Posted</dt><dd>{video.posted}</dd></> : <><dt>Made</dt><dd>{video.made}</dd></>}
        {video.views != null && <><dt>Views</dt><dd>{video.views.toLocaleString()}</dd></>}
        {video.verdict && <><dt>Your verdict</dt><dd>{video.verdict}</dd></>}
        {!video.logged && <><dt>Library</dt><dd>Not logged yet</dd></>}
        {video.plan && <><dt>Planned</dt><dd>{short(video.plan.date)}</dd></>}
      </dl>
      {video.plan && (
        <div className="detail-actions">
          <button className="link-btn" onClick={() => actions.openScript(video.plan.date, video.plan.id)}>Open script</button>
          <button className="link-btn quiet" onClick={() => actions.linkScript(video.plan.date, video.plan.id, null)}>Unlink</button>
        </div>
      )}
    </div>
  );
}

function ConfirmDelete({ target, onConfirm, onClose }) {
  const ref = useRef(null);
  const box = useRef(null);
  const { w, h } = useSize(box);
  const outline = useMemo(() => (w ? [rect(2, 2, w - 4, h - 4, { seed: 41, roughness: 0.9, bowing: 1.1 })] : []), [w, h]);
  const del = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (target && !d.open) {
      d.returnValue = '';
      d.showModal();
      del.current.focus();
    }
    if (!target && d.open) d.close();
  }, [target]);
  // <form method="dialog"> closes with the clicked button's value; Esc and backdrop close with ''.
  const closed = () => {
    if (ref.current.returnValue === 'delete') onConfirm(target);
    onClose();
  };
  return (
    <dialog ref={ref} className="confirm" onClose={closed} onClick={e => e.target === ref.current && ref.current.close()}>
      <div className="confirm-box" ref={box}>
        <Sketch className="confirm-outline" shape={outline} />
        <div className="confirm-inner">
        <h3>Delete this plan?</h3>
        <p><span className="hand">{target?.title || 'Untitled'}</span> and its script will be moved to <code>plans/.trash</code>.</p>
        <form method="dialog" className="confirm-actions">
          <button value="cancel" className="link-btn quiet">Cancel</button>
          <button value="delete" className="link-btn danger" ref={del}>Delete</button>
        </form>
        </div>
      </div>
    </dialog>
  );
}

// A suggestion's link icon plays once, the first time it shows this session, after the day's selection has drawn.
const introduced = new Set();
function SuggestLink({ id, onClick }) {
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (introduced.has(id)) return;
    introduced.add(id);
    const a = setTimeout(() => setPlay(true), 300), b = setTimeout(() => setPlay(false), 1300);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [id]);
  return <button className={`suggest-link${play ? ' ic-play' : ''}`} onClick={onClick}><Icon name="link" size={14} />Link</button>;
}

const short = s => parse(s).toLocaleString('en-US', { month: 'short', day: 'numeric' });

export default function Rail({ date, today, day, videos, suggestions, openDoc, openVideo, actions, newInput, ready }) {
  const d = parse(date);
  const video = openVideo && videos.find(v => v.project === openVideo);
  const plans = day.scripts.filter(s => !s.project);
  const [confirm, setConfirm] = useState(null);

  return (
    <aside className="rail">
      <Edge />
      <div className="rail-scroll">
        <header className="rail-head">
          <span className="rel">{d.toLocaleString('en-US', { weekday: 'long' })} · {relative(date, today)}</span>
          <h2>{d.toLocaleString('en-US', { month: 'long', day: 'numeric' })}</h2>
        </header>

        {video ? (
          <VideoDetail video={video} back={actions.close} actions={actions} />
        ) : (
          <>
            {videos.length > 0 && (
              <section className="rail-section">
                <h4>Made</h4>
                <ul className="rows">
                  {videos.map(v => (
                    <li key={v.project}>
                      <button className="row video-row" onClick={() => actions.openVideo(date, v.project)}>
                        {v.render ? <img src={`/thumb/${v.project}`} alt="" decoding="async" /> : <span className="thumb-empty" />}
                        <span className="row-main">
                          <span className="row-title">{v.title}</span>
                          <span className="row-meta">
                            {v.views != null ? `${v.views.toLocaleString()} views` : v.render ? (v.logged ? 'Not posted' : 'Not logged') : 'In progress'}
                            {v.plan && ` · planned ${short(v.plan.date)}`}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="rail-section">
              <h4>Planned</h4>
              <ul className="rows">
                {plans.map(s => {
                  const match = suggestions[s.id];
                  return (
                  <li key={s.id} className={`plan-item${s.id === openDoc ? ' active' : ''}`}>
                    <div className="plan-line">
                      <button
                        className="plan-row"
                        draggable
                        onDragStart={e => {
                          e.dataTransfer.setData(PLAN_MIME, JSON.stringify({ from: date, id: s.id }));
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onMouseEnter={() => api.getScript(date, s.id)}
                        onClick={() => actions.openScript(date, s.id)}
                      >
                        <span className="row-title hand">{s.title || <span className="untitled">Untitled</span>}</span>
                        {s.words > 0 && <span className="row-meta">{s.words} words · {runtime(s.words)}</span>}
                      </button>
                      <button className="row-delete" aria-label={`Delete ${s.title || 'untitled'}`} onClick={() => setConfirm({ date, id: s.id, title: s.title })}><Icon name="trash" size={15} /></button>
                    </div>
                    {match && (
                      <div className="suggest">
                        <img src={`/thumb/${match.project}`} alt="" decoding="async" />
                        <span className="suggest-text">Made it? <b>{match.title}</b><span className="suggest-date"> · {short(match.made)}</span></span>
                        <SuggestLink id={`${s.id}/${match.project}`} onClick={() => actions.linkScript(date, s.id, match.project)} />
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
              <NewVideo key={date} date={date} create={actions.createScript} inputRef={newInput} />
            </section>

            <section className="rail-section">
              <h4>Notes</h4>
              <Notes key={`${date}-${!!ready}`} date={date} initial={day.blurb} save={actions.saveBlurb} />
            </section>
          </>
        )}
      </div>
      <ConfirmDelete target={confirm} onConfirm={t => actions.deleteScript(t.date, t.id)} onClose={() => setConfirm(null)} />
    </aside>
  );
}

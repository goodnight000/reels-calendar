import { memo, useMemo, useRef, useState } from 'react';
import { Sketch, ellipse, line, rect } from './sketch.jsx';
import { addDays, addMonths, parse, ymd, useSize } from './lib.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Always six rows, so switching months never changes the grid's height.
function gridDates(month) {
  const first = parse(`${month}-01`);
  const start = addDays(ymd(first), -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function GridLines({ w, h }) {
  const shape = useMemo(() => {
    if (!w || !h) return [];
    const out = [line(0, 0, w, 0, { seed: 1 })];
    for (let c = 1; c < 7; c++) out.push(line((w / 7) * c, 0, (w / 7) * c, h, { seed: 10 + c }));
    for (let r = 1; r < 6; r++) out.push(line(0, (h / 6) * r, w, (h / 6) * r, { seed: 20 + r }));
    return out;
  }, [w, h]);
  return <Sketch className="grid-lines" shape={shape} />;
}

function Selection({ index, w, h }) {
  const cw = w / 7, ch = h / 6;
  const x = (index % 7) * cw, y = Math.floor(index / 7) * ch;
  // Seed from the index so each day gets its own stroke, but the same day always gets the same one.
  const shape = useMemo(() => [rect(4, 4, cw - 8, ch - 8, { seed: 100 + index, roughness: 1.1, strokeWidth: 1.6, bowing: 1.4 })], [cw, ch, index]);
  return (
    <div className="selection" style={{ transform: `translate(${x}px, ${y}px)`, width: cw, height: ch }}>
      <Sketch key={index} shape={shape} draw />
    </div>
  );
}

const todayRing = [ellipse(16, 13, 29, 23, { seed: 7, roughness: 1.2, strokeWidth: 1.4 })];

// Pixel heights of each entry kind, so a cell shows exactly what fits.
const VIDEO_ROW = 38, PLAN_ROW = 21, STRIP_THUMB = 24;
export const PLAN_MIME = 'application/x-reel-plan';

const Thumb = ({ v }) =>
  v.render ? <img src={`/thumb/${v.project}`} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className="thumb-empty" />;

function layout(videos, scripts, room, cw) {
  // Several videos that won't fit as rows collapse into one strip of thumbnails.
  const strip = videos.length > 1 && videos.length * VIDEO_ROW + scripts.length * PLAN_ROW > room;
  const used = strip ? VIDEO_ROW : videos.length * VIDEO_ROW;
  const perStrip = Math.max(1, Math.floor((cw - 18) / STRIP_THUMB));
  const stripShown = strip && videos.length > perStrip ? videos.slice(0, perStrip - 1) : videos;
  const slots = Math.max(0, Math.floor((room - used) / PLAN_ROW));
  // When plans overflow, the last slot becomes the "+n" line.
  const plans = scripts.length > slots ? scripts.slice(0, Math.max(0, slots - 1)) : scripts;
  return { strip, stripShown, plans, more: scripts.length - plans.length, spare: slots - scripts.length };
}

const Cell = memo(function Cell({ date, inMonth, isToday, day, videos, actions, room, cw, drop, setDrop }) {
  const scripts = useMemo(() => (day?.scripts || EMPTY).filter(s => !s.project), [day]);
  const { strip, stripShown, plans, more, spare } = layout(videos, scripts, room, cw);
  const blurb = day?.blurb?.trim().split('\n')[0];

  const dragProps = s => ({
    draggable: true,
    onDragStart: e => {
      e.dataTransfer.setData(PLAN_MIME, JSON.stringify({ from: date, id: s.id }));
      e.dataTransfer.effectAllowed = 'move';
    },
  });

  return (
    <div
      data-date={date}
      className={`cell${inMonth ? '' : ' out'}${isToday ? ' today' : ''}${drop ? ' drop' : ''}`}
      onMouseDown={() => actions.select(date)}
      onDoubleClick={e => { if (!e.target.closest('button')) actions.planOn(date); }}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(PLAN_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!drop) setDrop(date);
      }}
      onDrop={e => {
        const raw = e.dataTransfer.getData(PLAN_MIME);
        setDrop(null);
        if (!raw) return;
        e.preventDefault();
        const { from, id } = JSON.parse(raw);
        actions.moveScript(from, id, date);
      }}
    >
      <span className="num">
        {isToday && <Sketch className="today-ring" shape={todayRing} />}
        {Number(date.slice(8))}
      </span>
      <div className="entries">
        {strip ? (
          <div className="strip">
            {stripShown.map(v => (
              <button key={v.project} className="strip-thumb" title={v.fullTitle || v.title} onClick={() => actions.openVideo(date, v.project)}>
                <Thumb v={v} />
              </button>
            ))}
            {stripShown.length < videos.length && <span className="more">+{videos.length - stripShown.length}</span>}
          </div>
        ) : (
          videos.map(v => (
            <button
              key={v.project}
              className={`entry video${v.render ? '' : ' unfinished'}`}
              onClick={() => actions.openVideo(date, v.project)}
              title={v.fullTitle || v.title}
            >
              <Thumb v={v} />
              <span className="label">{v.title}</span>
            </button>
          ))
        )}
        {plans.map(s => (
          <button key={s.id} className="entry plan" onClick={() => actions.openScript(date, s.id)} {...dragProps(s)}>
            {s.title || <span className="untitled">Untitled</span>}
          </button>
        ))}
        {more > 0 && <span className="more">+{more}</span>}
        {!more && blurb && spare > 0 && <span className="snippet">{blurb}</span>}
      </div>
    </div>
  );
});

export default function Calendar({ month, setMonth, today, selected, days, videosByDate, actions, hidden }) {
  const gridRef = useRef(null);
  const { w, h } = useSize(gridRef);
  const dates = useMemo(() => gridDates(month), [month]);
  const selIndex = dates.indexOf(selected);
  const [drop, setDrop] = useState(null);
  // Cell height minus padding (14), the date line (19) and its gap (4).
  const room = Math.max(VIDEO_ROW, h / 6 - 37);
  const cw = w / 7;
  const label = parse(`${month}-01`);

  return (
    <section className="calendar" aria-hidden={hidden} inert={hidden}>
      <header className="cal-head">
        <h1>
          {label.toLocaleString('en-US', { month: 'long' })} <span className="year">{label.getFullYear()}</span>
        </h1>
        <nav className="cal-nav">
          <button onClick={() => setMonth(m => addMonths(m, -1))} aria-label="Previous month">‹</button>
          <button className="today-btn" onClick={() => actions.select(today)}>Today</button>
          <button onClick={() => setMonth(m => addMonths(m, 1))} aria-label="Next month">›</button>
        </nav>
      </header>
      <div className="weekdays">{WEEKDAYS.map(d => <span key={d}>{d}</span>)}</div>
      <div className="grid" ref={gridRef} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDrop(null); }}>
        <GridLines w={w} h={h} />
        {selIndex >= 0 && w > 0 && <Selection index={selIndex} w={w} h={h} />}
        {dates.map(date => (
          <Cell
            key={date}
            date={date}
            inMonth={date.startsWith(month)}
            isToday={date === today}
            day={days[date]}
            videos={videosByDate[date] || EMPTY}
            actions={actions}
            room={room}
            cw={cw}
            drop={drop === date}
            setDrop={setDrop}
          />
        ))}
      </div>
    </section>
  );
}

const EMPTY = [];

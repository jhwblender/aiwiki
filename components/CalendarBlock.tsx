'use client';
import { useMemo, useState } from 'react';
import Md from './Md';
import { parseCalendar, daysOf } from '../lib/calendar';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// A month view over a calendar block: arrows walk the months, days list what was scheduled. The
// view starts on the month of the next entry, or this month when the calendar holds none ahead.
export default function CalendarBlock({ text }: { text: string }) {
  const entries = useMemo(() => parseCalendar(text), [text]);
  const byDay = useMemo(() => {
    // An item that runs several days shows on every day it covers
    const map = new Map<string, { title: string; note: string; span: boolean }[]>();
    for (const e of entries) {
      for (const day of daysOf(e)) {
        const holds = map.get(day) ?? [];
        holds.push({ title: e.title, note: e.note, span: !!e.end });
        map.set(day, holds);
      }
    }
    return map;
  }, [entries]);

  const today = new Date();
  const startMonth = useMemo(() => {
    const todayIso = iso(today.getFullYear(), today.getMonth(), today.getDate());
    const ahead = entries.map((e) => e.date).sort().find((d) => d >= todayIso);
    const start = ahead ?? entries.map((e) => e.date).sort().at(-1) ?? todayIso;
    return [Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1] as const;
  }, [entries]);
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);
  const shown = month ?? { y: startMonth[0], m: startMonth[1] };

  const cells = useMemo(() => {
    const first = new Date(shown.y, shown.m, 1);
    const days = new Date(shown.y, shown.m + 1, 0).getDate();
    const lead = first.getDay();
    const out: ({ y: number; m: number; d: number } | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push({ y: shown.y, m: shown.m, d });
    while (out.length % 7) out.push(null);
    return out;
  }, [shown]);

  const step = (delta: number) => {
    const next = new Date(shown.y, shown.m + delta, 1);
    setMonth({ y: next.getFullYear(), m: next.getMonth() });
  };

  // The day to read in full, picked by clicking a cell; shown below the grid
  const [sel, setSel] = useState<string | null>(null);
  const items = (sel && byDay.get(sel)) || [];
  const selLabel = sel
    ? new Date(sel + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  const pick = (y: number, m: number, d: number) => setSel((prev) => (iso(y, m, d) === prev ? null : iso(y, m, d)));
  // A run of days, as people say it: by month name and day, with the year only when it changes
  const ran = (a: string, b: string) => {
    const f = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8, 10))}`;
    return a.slice(0, 4) === b.slice(0, 4) ? `${f(a)} – ${f(b)}` : `${f(a)} ${a.slice(0, 4)} – ${f(b)} ${b.slice(0, 4)}`;
  };

  const todayIso = iso(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" onClick={() => step(-1)} aria-label="The month before">
          &lsaquo;
        </button>
        <span>
          {MONTHS[shown.m]} {shown.y}
        </span>
        <button type="button" onClick={() => step(1)} aria-label="The month after">
          &rsaquo;
        </button>
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="cal-wd">
            {w}
          </span>
        ))}
        {cells.map((c, i) =>
          c ? (
            <span
              key={i}
              className={'cal-day' + (iso(c.y, c.m, c.d) === todayIso ? ' today' : '') + (iso(c.y, c.m, c.d) === sel ? ' sel' : '')}
              role="button"
              tabIndex={0}
              onClick={() => pick(c.y, c.m, c.d)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pick(c.y, c.m, c.d);
                }
              }}
            >
              <span className="n">{c.d}</span>
              {(byDay.get(iso(c.y, c.m, c.d)) ?? []).slice(0, 2).map((e, j) => (
                <span key={j} className={'cal-entry' + (e.span ? ' span' : '')}>
                  <Md>{e.title ? `${e.title}${e.note ? ` — ${e.note}` : ''}` : e.note || '(day)'}</Md>
                </span>
              ))}
              {(byDay.get(iso(c.y, c.m, c.d))?.length ?? 0) > 2 && <span className="cal-more">+{(byDay.get(iso(c.y, c.m, c.d))?.length ?? 0) - 2} more</span>}
            </span>
          ) : (
            <span key={i} className="cal-day dim" />
          ),
        )}
      </div>
      {sel && (
        <div className="cal-detail">
          <div className="cal-detail-head">
            {selLabel}
            <button type="button" className="link-button" onClick={() => setSel(null)}>
              Close
            </button>
          </div>
          {items.length === 0 ? (
            <p className="muted small-text">Nothing scheduled that day.</p>
          ) : (
            <ul className="cal-items">
              {items.map((e, i) => (
                <li key={i} className="cal-item">
                  <span className="cal-item-body">
                    <Md>{e.title || e.note || '(without title)'}</Md>
                    {e.note && e.title && <span className="cal-item-note"><Md>{e.note}</Md></span>}
                  </span>
                  {e.end && e.span && <span className="cal-item-range">Runs {ran(e.date, e.end)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {entries.length === 0 && <p className="muted small-text cal-empty">Nothing scheduled yet.</p>}
    </div>
  );
}

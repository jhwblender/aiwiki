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
            <span key={i} className={'cal-day' + (iso(c.y, c.m, c.d) === todayIso ? ' today' : '')}>
              <span className="n">{c.d}</span>
              {(byDay.get(iso(c.y, c.m, c.d)) ?? []).map((e, j) => (
                <span key={j} className={'cal-entry' + (e.span ? ' span' : '')}>
                  <Md>{e.title ? `${e.title}${e.note ? ` — ${e.note}` : ''}` : e.note || '(day)'}</Md>
                </span>
              ))}
            </span>
          ) : (
            <span key={i} className="cal-day dim" />
          ),
        )}
      </div>
      {entries.length === 0 && <p className="muted small-text cal-empty">Nothing scheduled yet.</p>}
    </div>
  );
}

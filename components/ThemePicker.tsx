'use client';
import { useEffect, useRef, useState } from 'react';
import { applyTheme, THEME_KEY, THEME_PLACE_KEY, type ThemeMode, type ThemeState } from '@/lib/theme';

const CHOICES: { mode: ThemeMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Light, dark, or Auto by sunrise and sunset. The choice and any shared location stay in this browser.
export default function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ThemeState | null>(null);
  const [note, setNote] = useState('');
  const [canLocate, setCanLocate] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setState(applyTheme());
    // Browsers only share a location with secure pages, so a plain http address never offers it
    setCanLocate(window.isSecureContext && 'geolocation' in navigator);
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function save(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
    setState(applyTheme());
  }

  function shareLocation() {
    setNote('Asking your browser for your location…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setNote('');
        // A tenth of a degree moves sunset by under a minute, so nothing finer is kept
        const round = (n: number) => Math.round(n * 10) / 10;
        save(THEME_PLACE_KEY, JSON.stringify({ lat: round(coords.latitude), lon: round(coords.longitude) }));
      },
      () => setNote('Your browser did not share a location, so the time zone estimate stays in use.'),
      { maximumAge: 86400000, timeout: 15000 },
    );
  }

  return (
    <div className="theme-picker" ref={box}>
      <button className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
        Theme
      </button>
      {open && state && (
        <div className="theme-pop">
          <div className="theme-choices" role="radiogroup" aria-label="Theme">
            {CHOICES.map((c) => (
              <button
                key={c.mode}
                className={`btn small${state.mode === c.mode ? ' primary' : ''}`}
                role="radio"
                aria-checked={state.mode === c.mode}
                onClick={() => save(THEME_KEY, c.mode === 'auto' ? null : c.mode)}
              >
                {c.label}
              </button>
            ))}
          </div>
          {state.mode === 'auto' && (
            <>
              <p className="muted small-text">
                {state.changesAt === null
                  ? 'The sun does not rise or set here in the next day.'
                  : `Turns ${state.dark ? 'light at sunrise' : 'dark at sunset'}, ${clock(state.changesAt)}`}
                {state.exact ? ', from your location.' : ', estimated from your time zone.'}
              </p>
              {state.exact ? (
                <button className="settings-link" onClick={() => save(THEME_PLACE_KEY, null)}>
                  Use my time zone instead
                </button>
              ) : (
                canLocate && (
                  <button className="settings-link" onClick={shareLocation}>
                    Use my location
                  </button>
                )
              )}
              {note && <p className="muted small-text">{note}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

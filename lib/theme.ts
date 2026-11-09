// Light or dark, chosen per browser. Auto (the default) follows the sun where the person is.
export type ThemeMode = 'auto' | 'light' | 'dark';
export const THEME_KEY = 'wiki-theme';
export const THEME_PLACE_KEY = 'wiki-theme-place';
export const THEME_EVENT = 'wiki-theme-change';

export interface ThemeState {
  mode: ThemeMode;
  dark: boolean;
  // When Auto next switches; null when the sun does not rise or set within a day (far north or south)
  changesAt: number | null;
  // True when the sun is worked out from a location the person shared, false for the time zone estimate
  exact: boolean;
}

// Works out the theme and puts it on <html>. This also runs as an inline script before the first
// paint (see themeScript), so it must stay self-contained: no imports and nothing from this module.
export function applyTheme(): ThemeState {
  const rad = Math.PI / 180;

  // Height of the sun above the horizon in degrees, at a moment and place
  function sunHeight(ms: number, lat: number, lon: number): number {
    const d = ms / 86400000 - 10957.5;
    const g = (357.529 + 0.98560028 * d) * rad;
    const l = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
    const tilt = (23.439 - 0.00000036 * d) * rad;
    const declination = Math.asin(Math.sin(tilt) * Math.sin(l));
    const ascension = Math.atan2(Math.cos(tilt) * Math.sin(l), Math.cos(l));
    const hour = (280.46061837 + 360.98564736629 * d + lon) * rad - ascension;
    const la = lat * rad;
    return Math.asin(Math.sin(la) * Math.sin(declination) + Math.cos(la) * Math.cos(declination) * Math.cos(hour)) / rad;
  }

  // Without a shared location: longitude from the standard UTC offset, latitude from the zone's region
  function estimatePlace(now: Date): { lat: number; lon: number } {
    const y = now.getFullYear();
    const standard = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
    let zone = '';
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {}
    let lat = 30;
    if (/^Europe\//.test(zone)) lat = 50;
    else if (/^America\/(Argentina|Sao_Paulo|Santiago|Montevideo|Asuncion|Lima|La_Paz)/.test(zone)) lat = -25;
    else if (/^America\//.test(zone)) lat = 40;
    else if (/^Australia\/|Auckland|Chatham/.test(zone)) lat = -35;
    else if (/^Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek)/.test(zone)) lat = -25;
    else if (/^Africa\//.test(zone)) lat = 5;
    return { lat, lon: -standard / 4 };
  }

  let mode: ThemeMode = 'auto';
  let place: { lat: number; lon: number } | null = null;
  try {
    const saved = localStorage.getItem('wiki-theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
    const p = JSON.parse(localStorage.getItem('wiki-theme-place') || 'null');
    if (p && typeof p.lat === 'number' && typeof p.lon === 'number') place = p;
  } catch {}

  const now = new Date();
  const { lat, lon } = place ?? estimatePlace(now);
  // -0.833 degrees is the moment the top of the sun crosses the horizon
  const isDark = (ms: number) => sunHeight(ms, lat, lon) < -0.833;
  const start = now.getTime();
  const darkNow = isDark(start);
  let changesAt: number | null = null;
  for (let m = 1; m <= 1440 && changesAt === null; m++) {
    if (isDark(start + m * 60000) !== darkNow) changesAt = start + m * 60000;
  }

  const dark = mode === 'auto' ? darkNow : mode === 'dark';
  const theme = dark ? 'dark' : 'light';
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    const first = !root.dataset.theme;
    root.dataset.theme = theme;
    if (!first) window.dispatchEvent(new Event('wiki-theme-change'));
  }
  return { mode, dark, changesAt, exact: !!place };
}

// Runs before the first paint so a dark page never flashes white, then keeps Auto current on every page
export const themeScript = `(function(){var apply=${applyTheme.toString()};apply();setInterval(apply,60000)})()`;

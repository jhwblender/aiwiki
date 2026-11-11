'use client';
import { useEffect, useSyncExternalStore } from 'react';

// Installing the wiki as an app of its own. Chrome and Edge (Android and Windows) offer it through
// beforeinstallprompt once the page is secure (https or localhost); elsewhere the browser's own menu
// can still add it, so the suggestion says where to look instead.

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type State = { ready: boolean; prompt: PromptEvent | null; installed: boolean; hint: string; open: boolean };

const DISMISSED = 'wiki-install-dismissed';
let state: State = { ready: false, prompt: null, installed: false, hint: '', open: false };
const listeners = new Set<() => void>();
const set = (change: Partial<State>) => {
  state = { ...state, ...change };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const SERVER: State = state;

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

function start() {
  if (state.ready) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hint = standalone
    ? ''
    : ios
      ? 'On iPhone or iPad, tap Share, then Add to Home Screen.'
      : window.isSecureContext
        ? ''
        : 'Open your browser menu and choose Add to Home screen on Android, or Install page as app on Windows. The wiki opens in a window of its own once it has a secure (https) address.';
  set({ ready: true, installed: standalone, hint, open: !standalone && !!hint && !dismissed() });
  if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    set({ prompt: e as PromptEvent, open: !dismissed() });
  });
  window.addEventListener('appinstalled', () => set({ prompt: null, installed: true, open: false }));
}

export function useInstall() {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  useEffect(start, []);
  return {
    // Something to offer: a one-click install, or where to find it in the browser
    available: !s.installed && (!!s.prompt || !!s.hint),
    show: () => set({ open: true }),
  };
}

export function InstallSuggestion() {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  useEffect(start, []);
  if (!s.open || s.installed || (!s.prompt && !s.hint)) return null;

  function later() {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {}
    set({ open: false });
  }

  async function install() {
    const p = state.prompt;
    if (!p) return;
    await p.prompt();
    const { outcome } = await p.userChoice;
    // The browser offers each prompt once; it fires a fresh one later if it may ask again
    set({ prompt: null, open: false });
    if (outcome === 'dismissed') later();
  }

  return (
    <div className="install-card" role="dialog" aria-label="Install the wiki">
      <img src="/icon.svg" alt="" width={36} height={36} />
      <div className="install-text">
        <strong>Install the wiki as an app</strong>
        <span className="muted small-text">
          {s.prompt ? 'It opens in a window of its own, with an icon on your home screen, desktop or Start menu.' : s.hint}
        </span>
        <div className="install-actions">
          {s.prompt && (
            <button className="btn small primary" onClick={install}>
              Install app
            </button>
          )}
          <button className="btn small quiet" onClick={later}>
            {s.prompt ? 'Not now' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}

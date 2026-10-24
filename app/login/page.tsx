'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Sign in, or set up the first account when the wiki has none yet. The first account is an admin.
export default function LoginPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [setup, setSetup] = useState(false);
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/login', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setSetup(!!d.needsSetup);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, []);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setup ? { name, passcode, confirm } : { name, passcode }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'That did not work.');
        setBusy(false);
        return;
      }
      let where = '/wiki/index';
      try {
        const last = sessionStorage.getItem('wiki-last-path');
        if (last) where = `/wiki/${last}`;
      } catch {}
      router.push(where);
    } catch {
      setError('The wiki did not answer. Is it still running?');
      setBusy(false);
    }
  }

  if (checking) return <main className="login"><p className="muted">Checking who you are…</p></main>;

  return (
    <main className="login">
      <form className="login-card" onSubmit={go}>
        <h1>{setup ? 'Set up the wiki' : 'Sign in'}</h1>
        {setup ? (
          <>
            <p className="muted">
              This wiki has no accounts yet. Create the first one — it owns the settings and can add other people later.
            </p>
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
            </label>
            <label>
              Passcode
              <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
            </label>
            <label>
              Repeat the passcode
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
            </label>
            <label>
              Passcode
              <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
            </label>
          </>
        )}
        {error && <p className="login-error">{error}</p>}
        <button className="btn" disabled={busy || !name.trim() || !passcode}>
          {busy ? 'One moment…' : setup ? 'Create the account' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
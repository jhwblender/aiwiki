'use client';
import { useCallback, useEffect, useState } from 'react';

type Rule = 'file' | 'sample' | 'index' | 'skip';
type Node = {
  dir: string;
  name: string;
  files: number;
  rule: { rule: Rule; reason: string; setBy: string } | null;
  effective: Rule;
  counts: Record<string, number>;
  children: Node[];
};

const RULE_LABEL: Record<Rule, string> = {
  file: 'File each document',
  sample: 'File a sample',
  index: 'Keep searchable only',
  skip: 'Skip',
};
const RULE_HELP: Record<Rule, string> = {
  file: 'Every document is read and filed.',
  sample: 'Look-alike files: the first two of each kind are filed, the rest kept searchable.',
  index: 'The assistant can look things up in them, but they are not filed. Photos are not read.',
  skip: 'Not read at all, for raw data, assets and anything nobody needs.',
};
// filing outcomes, in the order they are listed
const OUTCOMES: [string, string][] = [
  ['done', 'filed'],
  ['kept', 'kept searchable'],
  ['skipped', 'skipped'],
  ['working', 'reading'],
  ['queued', 'waiting'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['unfiled', 'not filed'],
];

function who(setBy: string) {
  if (setBy === 'pattern') return 'from the folder pattern';
  if (setBy === 'librarian') return 'from the librarian';
  return `set by ${setBy}`;
}

// One watched folder as a tree: how each folder in it is filed, and what happened to its files
export default function FolderPlan({ folderId, user }: { folderId: number; user: string }) {
  const [tree, setTree] = useState<Node | null>(null);
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/folders/${folderId}/plan`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setTree(d.tree);
      setPlanning(d.planning);
    } catch (e: any) {
      setError(e.message || 'Could not load the folder.');
    }
  }, [folderId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: object) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await fetch(`/api/folders/${folderId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, user }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'That did not work.');
      return d;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
      load();
    }
  }

  if (!tree) return error ? <div className="error">{error}</div> : <p className="muted small-text">Loading</p>;
  return (
    <div className="folder-plan">
      <div className="plan-head">
        <strong>{tree.name}</strong>
        <span className="muted small-text">{tree.files} files</span>
        <span className="spacer" />
        <button className="btn small quiet" disabled={busy || planning} onClick={() => post({ action: 'plan' })}>
          {planning ? 'Planning' : 'Plan again'}
        </button>
      </div>
      <p className="muted small-text">
        {planning
          ? 'The librarian is looking over the folder tree to decide how each folder is filed.'
          : 'Each folder follows its own rule, or the one above it. Rules you set are kept when the folder is planned again.'}
      </p>
      {error && <div className="error">{error}</div>}
      {note && <div className="notice">{note}</div>}
      <ul className="plan-tree">
        <Branch node={tree} parentRule="file" depth={0} busy={busy} post={post} onNote={setNote} />
      </ul>
    </div>
  );
}

function Branch({
  node,
  parentRule,
  depth,
  busy,
  post,
  onNote,
}: {
  node: Node;
  parentRule: Rule;
  depth: number;
  busy: boolean;
  post: (body: object) => Promise<any>;
  onNote: (text: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const outcomes = OUTCOMES.filter(([k]) => node.counts[k]).map(([k, label]) => `${node.counts[k]} ${label}`);
  // After a folder's own rule was set to file or sample, what it skipped, kept searchable or never
  // filed can be sent to be filed
  const notFiled = (node.counts.skipped ?? 0) + (node.counts.kept ?? 0) + (node.counts.unfiled ?? 0);
  const canFile = notFiled > 0 && !!node.rule && (node.rule.rule === 'file' || node.rule.rule === 'sample');

  async function change(value: string) {
    const rule = value === 'inherit' ? null : value;
    if (node.dir === '.' && rule === null) return;
    await post({ dir: node.dir, rule });
  }

  async function fileNow() {
    const d = await post({ action: 'refile', dir: node.dir });
    if (d) onNote(d.queued ? `${d.queued} file${d.queued === 1 ? '' : 's'} from ${node.name} sent to be filed.` : `Nothing in ${node.name} needs filing.`);
  }

  return (
    <li>
      <div className={'plan-row rule-' + node.effective}>
        {node.children.length > 0 ? (
          <button className="plan-toggle" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={open ? `Close ${node.name}` : `Open ${node.name}`}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="plan-toggle" />
        )}
        <div className="plan-name">
          <span>{node.name}</span>
          <span className="muted small-text">
            {' '}
            {node.files} file{node.files === 1 ? '' : 's'}
            {outcomes.length > 0 && `: ${outcomes.join(', ')}`}
          </span>
          {node.rule && node.rule.reason && (
            <div className="muted small-text plan-reason">
              {node.rule.reason} ({who(node.rule.setBy)})
            </div>
          )}
        </div>
        <select
          value={node.rule ? node.rule.rule : 'inherit'}
          disabled={busy}
          onChange={(e) => change(e.target.value)}
          aria-label={`How ${node.name} is filed`}
          title={RULE_HELP[node.effective]}
        >
          {node.dir !== '.' && <option value="inherit">Same as above ({RULE_LABEL[parentRule].toLowerCase()})</option>}
          {(Object.keys(RULE_LABEL) as Rule[]).map((r) => (
            <option key={r} value={r}>
              {RULE_LABEL[r]}
            </option>
          ))}
        </select>
        {canFile && (
          <button className="btn small quiet" disabled={busy} onClick={fileNow} title="Send what was skipped or kept searchable here to be filed under the current rule">
            File these now
          </button>
        )}
      </div>
      {open && node.children.length > 0 && (
        <ul className="plan-tree">
          {node.children.map((c) => (
            <Branch key={c.dir} node={c} parentRule={node.effective} depth={depth + 1} busy={busy} post={post} onNote={onNote} />
          ))}
        </ul>
      )}
    </li>
  );
}

export type Segment =
  | { type: 'same'; blocks: string[] }
  | { type: 'change'; index: number; fp: string; removed: string[]; added: string[] };

export type SourceInfo = {
  id: number;
  kind: 'chat' | 'file' | 'manual';
  user: string;
  folderLabel: string | null;
  relPath: string | null;
  filename: string | null;
  contentHash: string | null;
  version: number;
  note: string | null;
  detectedAt: string;
};

export type PendingSet = {
  proposalId: number;
  changeSetId: number;
  summary: string;
  createdBy: string;
  createdAt: string;
  isNew: boolean;
  // The page changed in the same places after this was suggested; it can only be rejected.
  // Its segments then show the suggestion against the text it was written for.
  conflict: boolean;
  source: SourceInfo | null;
  // Messages this suggestion revised, oldest first (a chat refining its own suggestion)
  earlierSources: SourceInfo[];
  segments: Segment[];
};

// A suggested move or removal of a whole page, reviewed on that page
export type PendingOp = {
  opId: number;
  changeSetId: number;
  kind: 'move' | 'remove';
  newPath: string | null;
  summary: string;
  createdBy: string;
  createdAt: string;
  source: SourceInfo | null;
  // Why it can no longer be applied, if the wiki changed since it was suggested
  stale: string | null;
};

export type PageSourceRef = {
  source: SourceInfo;
  approvedBy: string;
  approvedAt: string;
};

export type PageData = {
  path: string;
  exists: boolean;
  title: string;
  content: string;
  pending: PendingSet[];
  ops: PendingOp[];
  sources: PageSourceRef[];
  children: { path: string; title: string; exists: boolean; below: number }[];
};

export type PageListItem = { path: string; title: string; pending: number; isNew: boolean };

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

export type ChatResponse = {
  reply: string;
  trace: string[];
  proposed: { path: string; isNew: boolean }[];
  error?: string;
};

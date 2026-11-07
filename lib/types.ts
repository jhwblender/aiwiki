export type Segment =
  | { type: 'same'; blocks: string[] }
  | { type: 'change'; index: number; fp: string; removed: string[]; added: string[] };

export type SourceInfo = {
  id: number;
  kind: 'chat' | 'file' | 'manual' | 'librarian';
  user: string;
  folderLabel: string | null;
  relPath: string | null;
  filename: string | null;
  contentHash: string | null;
  version: number;
  note: string | null;
  detectedAt: string;
  hasFile: boolean; // the original file is stored and can be opened from the source chip
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
  // Other files that came in the same message
  alsoSources: SourceInfo[];
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

export type Attachment = { id: number; name: string; mime: string; size: number; kind: string };

// One approved change to a page, as the approval history shows it
export type HistoryAction = {
  kind: 'created' | 'removed' | 'moved' | 'edited';
  path: string; // the page's path (for a move, where it came from)
  newPath?: string; // for a move, where it went
  title: string;
  newTitle?: string; // for a move, shown for the place it went to
  exists: boolean; // whether the page is in the wiki now
};

export type HistoryEntry = {
  commit: string;
  at: string;
  approver: string;
  summary: string;
  changeSet: number;
  actions: HistoryAction[];
};

// A suggestion a person rejected: it never reached the wiki, so it lives in the decision records,
// and taking the rejection back puts it on its page to review again
export type RejectedItem = {
  kind: 'edit' | 'move' | 'remove';
  table: 'proposal' | 'op';
  id: number;
  pagePath: string;
  newPath?: string;
  title: string;
  isNew?: boolean;
  summary: string;
  rejectedBy: string;
  at: string;
  exists: boolean;
};

export type ChatResponse = {
  reply: string;
  trace: string[];
  proposed: { path: string; isNew: boolean }[];
  error?: string;
};

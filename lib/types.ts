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
  segments: Segment[];
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
  sources: PageSourceRef[];
};

export type PageListItem = { path: string; title: string; pending: number; isNew: boolean };

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

export type ChatResponse = {
  reply: string;
  trace: string[];
  proposed: { path: string; isNew: boolean }[];
  error?: string;
};

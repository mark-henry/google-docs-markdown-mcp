/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';

/** One rendering of a doc tab, as an agent last saw it or last wrote it. */
export interface Snapshot {
  revisionId: string;
  time: string;
  markdown: string;
  /** True when this server's own write produced this revision. */
  own: boolean;
}

const KEEP = 30;

export function stateDir(): string {
  const account = process.env['WORKSPACE_ACCOUNT'] || 'main-account';
  const base =
    process.env['WORKSPACE_STATE_DIR'] ||
    path.join(os.homedir(), '.local', 'state', 'google-docs-markdown-mcp');
  return path.join(base, account.replace(/[^\w.-]/g, '_'));
}

/**
 * Per-document history of markdown snapshots, so `changesSince` can show what
 * other editors changed between an agent's turns while leaving out the
 * agent's own writes.
 */
export class SnapshotStore {
  constructor(private dir: string = stateDir()) {}

  private file(docId: string, tabId: string): string {
    return path.join(
      this.dir,
      `${docId}.${tabId}.json`.replace(/[^\w.-]/g, '_'),
    );
  }

  history(docId: string, tabId: string): Snapshot[] {
    const f = this.file(docId, tabId);
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Snapshot[];
  }

  record(docId: string, tabId: string, snap: Snapshot): void {
    const h = this.history(docId, tabId);
    const last = h[h.length - 1];
    if (last && last.revisionId === snap.revisionId) {
      // Same revision: an own-write marker wins, the content is identical.
      last.own = last.own || snap.own;
    } else {
      h.push(snap);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(docId, tabId), JSON.stringify(h.slice(-KEEP)));
  }
}

/**
 * Diff of everything others changed from `baseline` to `current`. History is
 * a chain of snapshots; a step that ends in one of our own writes is skipped,
 * every other step is diffed. Returns the per-step patches, oldest first.
 */
export function othersChanges(
  history: Snapshot[],
  baselineIndex: number,
  current: Snapshot,
): Array<{ from: Snapshot; to: Snapshot; patch: string }> {
  const chain = [...history.slice(baselineIndex), current];
  const out: Array<{ from: Snapshot; to: Snapshot; patch: string }> = [];
  for (let i = 1; i < chain.length; i++) {
    const from = chain[i - 1];
    const to = chain[i];
    if (to.own || from.revisionId === to.revisionId) continue;
    if (from.markdown === to.markdown) continue;
    out.push({ from, to, patch: unifiedDiff(from.markdown, to.markdown) });
  }
  return out;
}

export function unifiedDiff(a: string, b: string): string {
  const patch = createTwoFilesPatch('before', 'after', a, b, '', '', {
    context: 2,
  });
  // Drop the "Index/===/---/+++" file header; keep the hunks.
  return patch
    .split('\n')
    .filter((l) => !/^(Index:|={3,}|--- |\+\+\+ )/.test(l))
    .join('\n')
    .trim();
}

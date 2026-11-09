/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderDiscussion,
  Discussion,
} from '../../services/docsMarkdown/discussion';
import {
  SnapshotStore,
  othersChanges,
  Snapshot,
} from '../../services/docsMarkdown/snapshots';

const mom = { displayName: 'Mom' };
const me = { displayName: 'Mark Henry', me: true };

const d: Discussion = {
  comments: [
    {
      commentId: 'c1',
      status: 'OPEN',
      plainTextQuote: 'Day 3: Tulum',
      headPost: {
        author: mom,
        createTime: '2026-11-08T10:00:00.000Z',
        content: 'Can we do\ncenotes instead?',
      },
      replies: [
        {
          author: me,
          createTime: '2026-11-09T12:30:00.000Z',
          content: 'Sure',
        },
      ],
    },
    {
      commentId: 'c2',
      status: 'RESOLVED',
      plainTextQuote: 'flights',
      headPost: { author: mom, createTime: '2026-11-01T00:00:00.000Z' },
      replies: [
        {
          author: me,
          createTime: '2026-11-02T00:00:00.000Z',
          commentAction: 'RESOLVE',
        },
      ],
    },
  ],
  suggestions: [
    {
      suggestionId: 's1',
      status: 'OPEN',
      summaryText: 'Insert: “bring sunscreen”',
      headPost: { author: mom, createTime: '2026-11-09T08:00:00.000Z' },
    },
  ],
};

describe('renderDiscussion', () => {
  it('lists open threads with ids, quote, authors and times; hides resolved', () => {
    const out = renderDiscussion(d);
    expect(out).toContain('## Comments (1 open, 1 resolved hidden)');
    expect(out).toContain('- **c1** · OPEN · on "Day 3: Tulum"');
    expect(out).toContain(
      '  - Mom · 2026-11-08 10:00 UTC: Can we do ⏎ cenotes instead?',
    );
    expect(out).toContain('  - Mark Henry (you) · 2026-11-09 12:30 UTC: Sure');
    expect(out).not.toContain('c2');
    expect(out).toContain(
      '- **s1** · Mom · 2026-11-09 08:00 UTC · Insert: “bring sunscreen”',
    );
  });

  it('shows resolved threads and the resolve action on request', () => {
    const out = renderDiscussion(d, { includeResolved: true });
    expect(out).toContain('- **c2** · RESOLVED · on "flights"');
    expect(out).toContain('[resolved the thread]');
  });

  it('with since, shows only newer posts', () => {
    const out = renderDiscussion(d, { since: '2026-11-09T00:00:00.000Z' });
    expect(out).toContain('**c1**');
    expect(out).not.toContain('cenotes');
    expect(out).toContain('Sure');
    expect(out).not.toContain('**c2**');
    expect(out).toContain('**s1**');
  });

  it('with othersOnly, leaves out your own posts', () => {
    const out = renderDiscussion(d, {
      since: '2026-11-09T00:00:00.000Z',
      othersOnly: true,
    });
    expect(out).not.toContain('**c1**');
    expect(out).toContain('**s1**');
  });
});

describe('SnapshotStore and othersChanges', () => {
  const snap = (
    revisionId: string,
    markdown: string,
    own = false,
  ): Snapshot => ({
    revisionId,
    markdown,
    own,
    time: '2026-11-09T00:00:00.000Z',
  });

  it('persists history and merges a repeat revision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
    const store = new SnapshotStore(dir);
    expect(store.history('doc', 't.0')).toEqual([]);
    store.record('doc', 't.0', snap('r1', 'a\n'));
    store.record('doc', 't.0', snap('r1', 'a\n', true));
    store.record('doc', 't.0', snap('r2', 'b\n'));
    const h = store.history('doc', 't.0');
    expect(h.map((s) => [s.revisionId, s.own])).toEqual([
      ['r1', true],
      ['r2', false],
    ]);
    fs.rmSync(dir, { recursive: true });
  });

  it("diffs others' edits and skips steps that end in our own write", () => {
    const history = [
      snap('r1', '# Plan\nDay 1\n'),
      snap('r2', '# Plan\nDay 1\nDay 2 (mom)\n'),
      snap('r3', '# Plan\nDay 1\nDay 2 (mom)\nDay 3 (agent)\n', true),
    ];
    const now = snap('r4', '# Plan\nDay 1 (sis)\nDay 2 (mom)\nDay 3 (agent)\n');
    const steps = othersChanges(history, 0, now);
    expect(steps).toHaveLength(2);
    expect(steps[0].patch).toContain('+Day 2 (mom)');
    expect(steps[1].patch).toContain('-Day 1');
    expect(steps[1].patch).toContain('+Day 1 (sis)');
    const all = steps.map((s) => s.patch).join('\n');
    expect(all).not.toContain('+Day 3 (agent)');
  });
});

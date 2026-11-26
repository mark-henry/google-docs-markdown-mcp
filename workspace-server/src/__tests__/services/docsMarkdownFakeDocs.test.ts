/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from '@jest/globals';
import { FakeDoc, FakeDocsError } from './docsMarkdownHarness/fakeDocs';

const ins = (index: number, text: string) => ({
  insertText: { location: { index }, text },
});

describe('FakeDoc (the harness fake itself)', () => {
  it('starts as a section break plus one empty paragraph', () => {
    const c = new FakeDoc().toDocument().body!.content!;
    expect(c.map((e) => [e.startIndex, e.endIndex])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('throws on unknown request types so new features must teach it', () => {
    const doc = new FakeDoc();
    expect(() =>
      doc.batchUpdate([{ replaceAllText: { replaceText: 'x' } }]),
    ).toThrow(/does not support "replaceAllText"/);
  });

  it('rejects tab ids, bad ranges and the final newline', () => {
    const doc = new FakeDoc();
    doc.batchUpdate([ins(1, 'abc')]);
    expect(() =>
      doc.batchUpdate([
        { insertText: { location: { index: 1, tabId: 't1' }, text: 'x' } },
      ]),
    ).toThrow(FakeDocsError);
    expect(() =>
      doc.batchUpdate([
        { deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } },
      ]),
    ).toThrow(/final newline/);
    expect(() => doc.batchUpdate([ins(99, 'x')])).toThrow(FakeDocsError);
  });

  it('inserts text, splitting paragraphs on newlines', () => {
    const doc = new FakeDoc();
    doc.batchUpdate([ins(1, 'ab\ncd')]);
    const paras = doc.toDocument().body!.content!.slice(1);
    expect(paras.map((p) => [p.startIndex, p.endIndex])).toEqual([
      [1, 4],
      [4, 7],
    ]);
  });

  it('lays out tables with the offsets documented in tableRequests', () => {
    const R = 2;
    const C = 3;
    const doc = new FakeDoc();
    // Placeholder paragraph at Q = 1: table lands at T = Q + 1.
    doc.batchUpdate([{ insertTable: { rows: R, columns: C, location: { index: 1 } } }]);
    const content = doc.toDocument().body!.content!;
    const table = content.find((e) => e.table)!;
    const T = table.startIndex!;
    expect(T).toBe(2);
    expect(table.endIndex! - T).toBe(2 + R * (1 + 2 * C));
    table.table!.tableRows!.forEach((row, r) =>
      row.tableCells!.forEach((cell, c) => {
        expect(cell.content![0].startIndex).toBe(T + 3 + r * (1 + 2 * C) + 2 * c);
      }),
    );
  });

  it('createParagraphBullets strips nesting tabs into nesting levels', () => {
    const doc = new FakeDoc();
    doc.batchUpdate([
      ins(1, 'a\n\tb\n\t\tc'),
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 9 },
          bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
        },
      },
    ]);
    const d = doc.toDocument();
    const paras = d.body!.content!.slice(1).map((e) => e.paragraph!);
    expect(paras.map((p) => p.bullet!.nestingLevel)).toEqual([0, 1, 2]);
    expect(paras.map((p) => p.elements![0].textRun!.content)).toEqual([
      'a\n',
      'b\n',
      'c\n',
    ]);
    const listId = paras[0].bullet!.listId!;
    expect(d.lists![listId].listProperties!.nestingLevels![0].glyphType).toBe(
      'DECIMAL',
    );
  });

  it('refuses to delete the newline directly before a table', () => {
    const doc = new FakeDoc();
    doc.batchUpdate([
      ins(1, 'x'),
      { insertTable: { rows: 1, columns: 1, location: { index: 2 } } },
    ]);
    // Body: x, newline (new), table..., original newline.
    expect(() =>
      doc.batchUpdate([
        { deleteContentRange: { range: { startIndex: 2, endIndex: 3 } } },
      ]),
    ).toThrow(/followed by tbl/);
  });
});

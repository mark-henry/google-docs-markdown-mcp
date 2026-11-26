/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from '@jest/globals';
import { markdownToDocs } from '../../services/docsMarkdown/markdownToDocs';
import { flatten, AnchorError } from '../../services/docsMarkdown/docIndex';
import {
  findSection,
  replaceSectionBody,
  replaceWholeSection,
  insertInSection,
  moveSection,
  copyLosses,
  elementsIn,
} from '../../services/docsMarkdown/sections';
import { planReplaceAll } from '../../services/docsMarkdown/replaceAll';
import { docsToMarkdown } from '../../services/docsMarkdown/docsToMarkdown';

/** Paragraphs as [style, text-without-newline]. */
function doc(...paras: [string, string][]) {
  const content: any[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const [style, t] of paras) {
    const text = t + '\n';
    content.push({
      startIndex: i,
      endIndex: i + text.length,
      paragraph: {
        paragraphStyle: { namedStyleType: style },
        elements: [
          {
            startIndex: i,
            endIndex: i + text.length,
            textRun: { content: text },
          },
        ],
      },
    });
    i += text.length;
  }
  return content;
}

const N = 'NORMAL_TEXT';
const content = doc(
  ['HEADING_1', 'Intro'], // 1-7
  [N, 'hello'], // 7-13
  ['HEADING_2', 'Pricing'], // 13-21
  [N, 'price text'], // 21-32
  ['HEADING_3', 'Plans'], // 32-38
  [N, 'plan text'], // 38-47
  ['HEADING_2', 'Terms'], // 47-53
  [N, 'terms'], // 53-59
  ['HEADING_1', 'End'], // 59-63
  [N, 'bye'], // 63-67
);
const flat = flatten(content);

describe('findSection', () => {
  it('spans to the next heading of the same or higher level', () => {
    const s = findSection(flat, 'Pricing');
    expect([s.start, s.end, s.level]).toEqual([13, 48, 2]);
    expect(s.paragraphs.map((p) => p.text)).toEqual([
      'Pricing',
      'price text',
      'Plans',
      'plan text',
    ]);
    expect(findSection(flat, 'End').end).toBe(68);
  });

  it('accepts "## Heading" and is case-insensitive as a fallback', () => {
    expect(findSection(flat, '## Pricing').start).toBe(13);
    expect(findSection(flat, 'pricing').start).toBe(13);
    expect(() => findSection(flat, '# Pricing')).toThrow(AnchorError);
  });

  it('lists matches when ambiguous and headings when missing', () => {
    const dup = flatten(
      doc(['HEADING_2', 'Notes'], [N, 'a'], ['HEADING_1', 'Notes'], [N, 'b']),
    );
    expect(() => findSection(dup, 'Notes')).toThrow(/matches 2 headings/);
    expect(findSection(dup, '# Notes').start).toBe(9);
    expect(() => findSection(flat, 'Nope')).toThrow(/Headings in the doc/);
  });
});

describe('section edits', () => {
  it('replaces the body and keeps the heading', () => {
    const sec = findSection(flat, 'Pricing');
    const e = replaceSectionBody(markdownToDocs('new text'), sec, flat, 't');
    expect(e.requests[0]).toEqual({
      deleteContentRange: {
        range: { startIndex: 21, endIndex: 47, tabId: 't' },
      },
    });
    expect(e.requests[1]).toEqual({
      insertText: { location: { index: 21, tabId: 't' }, text: 'new text' },
    });
  });

  it('clears the body with empty markdown', () => {
    const e = replaceSectionBody(
      markdownToDocs(''),
      findSection(flat, 'Pricing'),
      flat,
    );
    expect(e.requests).toEqual([
      {
        deleteContentRange: {
          range: { startIndex: 21, endIndex: 48, tabId: undefined },
        },
      },
    ]);
  });

  it('deletes a whole section', () => {
    const e = replaceWholeSection(
      markdownToDocs(''),
      findSection(flat, 'Pricing'),
      flat,
    );
    expect(e.requests).toEqual([
      {
        deleteContentRange: {
          range: { startIndex: 13, endIndex: 48, tabId: undefined },
        },
      },
    ]);
  });

  it('deleting the last section removes the newline before it', () => {
    const e = replaceWholeSection(
      markdownToDocs(''),
      findSection(flat, 'End'),
      flat,
    );
    expect(e.requests).toEqual([
      {
        deleteContentRange: {
          range: { startIndex: 59, endIndex: 67, tabId: undefined },
        },
      },
    ]);
  });

  it('inserts at the start and end of a section', () => {
    const sec = findSection(flat, 'Pricing');
    const start = insertInSection(markdownToDocs('x'), sec, 'beginning', flat);
    expect(start.requests[0]).toMatchObject({
      insertText: { location: { index: 20 }, text: '\nx' },
    });
    const end = insertInSection(markdownToDocs('x'), sec, 'end', flat);
    expect(end.requests[0]).toMatchObject({
      insertText: { location: { index: 47 }, text: '\nx' },
    });
  });

  it('replaces a heading-only section body by inserting', () => {
    const f = flatten(doc(['HEADING_1', 'A'], ['HEADING_1', 'B'], [N, 'b']));
    const e = replaceSectionBody(markdownToDocs('hi'), findSection(f, 'A'), f);
    expect(e.requests[0]).toMatchObject({
      insertText: { location: { index: 2 }, text: '\nhi' },
    });
  });
});

describe('moveSection', () => {
  const src = () => findSection(flat, 'Pricing');
  const md = () =>
    markdownToDocs(docsToMarkdown(elementsIn(content, 13, 48), undefined));

  it('moving forward inserts first, then deletes the original', () => {
    const e = moveSection(md(), src(), { at: 'end' }, flat, 't');
    const kinds = e.requests.map((r) => Object.keys(r)[0]);
    expect(kinds[0]).toBe('insertText');
    expect(kinds[kinds.length - 1]).toBe('deleteContentRange');
    expect(e.requests[0]).toMatchObject({
      insertText: { location: { index: 67 } },
    });
    expect(e.requests[e.requests.length - 1]).toEqual({
      deleteContentRange: {
        range: { startIndex: 13, endIndex: 48, tabId: 't' },
      },
    });
  });

  it('moving backward deletes first, then inserts', () => {
    const terms = findSection(flat, 'Terms');
    const e = moveSection(
      markdownToDocs('## Terms\n\nterms'),
      terms,
      { before: findSection(flat, 'Pricing') },
      flat,
    );
    expect(Object.keys(e.requests[0])[0]).toBe('deleteContentRange');
    expect(e.requests[1]).toMatchObject({
      insertText: { location: { index: 13 } },
    });
  });

  it('refuses a no-op or an inside destination', () => {
    expect(() =>
      moveSection(md(), src(), { before: findSection(flat, 'Terms') }, flat),
    ).toThrow(/nothing to move/);
    expect(() => moveSection(md(), src(), { before: src() }, flat)).toThrow(
      /nothing to move/,
    );
  });

  it('copyLosses flags non-text elements and passes plain sections', () => {
    const s = src();
    expect(copyLosses(flat, s, elementsIn(content, 13, 48), md())).toEqual([]);
    const withImage = flatten([
      ...doc(['HEADING_1', 'A']),
      {
        startIndex: 3,
        endIndex: 6,
        paragraph: {
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          elements: [
            { startIndex: 3, endIndex: 4, textRun: { content: 'x' } },
            { startIndex: 4, endIndex: 5, inlineObjectElement: {} },
            { startIndex: 5, endIndex: 6, textRun: { content: '\n' } },
          ],
        },
      },
    ]);
    const sec = findSection(withImage, 'A');
    expect(
      copyLosses(withImage, sec, [], markdownToDocs('# A\n\nx')).join(),
    ).toMatch(/images/);
  });
});

describe('planReplaceAll', () => {
  const f = flatten(doc([N, 'cat and cat'], [N, 'Cat']));
  it('counts, replaces back to front, and keeps the match style by inserting at its end', () => {
    const p = planReplaceAll(f, 'cat', 'dog');
    expect(p.count).toBe(2);
    expect(p.requests).toEqual([
      {
        insertText: { location: { index: 12, tabId: undefined }, text: 'dog' },
      },
      {
        deleteContentRange: {
          range: { startIndex: 9, endIndex: 12, tabId: undefined },
        },
      },
      { insertText: { location: { index: 4, tabId: undefined }, text: 'dog' } },
      {
        deleteContentRange: {
          range: { startIndex: 1, endIndex: 4, tabId: undefined },
        },
      },
    ]);
  });

  it('honors matchCase false, within, and empty replacement', () => {
    expect(planReplaceAll(f, 'cat', 'x', { matchCase: false }).count).toBe(3);
    expect(
      planReplaceAll(f, 'cat', 'x', { within: { start: 1, end: 6 } }).count,
    ).toBe(1);
    expect(planReplaceAll(f, 'cat', '').requests).toHaveLength(2);
    expect(planReplaceAll(f, 'zzz', 'x').count).toBe(0);
  });

  it('rejects newlines, empties and no-ops', () => {
    expect(() => planReplaceAll(f, 'a\nb', 'x')).toThrow(AnchorError);
    expect(() => planReplaceAll(f, '', 'x')).toThrow(AnchorError);
    expect(() => planReplaceAll(f, 'cat', 'cat')).toThrow(AnchorError);
  });
});

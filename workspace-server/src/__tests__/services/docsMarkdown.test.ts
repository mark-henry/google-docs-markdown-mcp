/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from '@jest/globals';
import {
  markdownToDocs,
  isInline,
  UnsupportedMarkdownError,
} from '../../services/docsMarkdown/markdownToDocs';
import {
  flatten,
  findUnique,
  paragraphAt,
  AnchorError,
} from '../../services/docsMarkdown/docIndex';
import {
  insertAfter,
  replaceParagraphs,
} from '../../services/docsMarkdown/buildRequests';
import { docsToMarkdown } from '../../services/docsMarkdown/docsToMarkdown';

/** A body: sectionBreak, then paragraphs given as strings (each ends '\n'). */
function body(...paras: string[]) {
  const content: any[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
  let i = 1;
  for (const text of paras) {
    content.push({
      startIndex: i,
      endIndex: i + text.length,
      paragraph: {
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

describe('markdownToDocs', () => {
  it('converts headings, inline styles and links to text plus styles', () => {
    const md = markdownToDocs(
      '## Title **b**\n\nSee [x](https://e.com) and `c`.',
    );
    expect(md.text).toBe('Title b\nSee x and c.\n');
    expect(md.paragraphs).toEqual([
      { start: 0, end: 8, namedStyleType: 'HEADING_2' },
      { start: 8, end: 21, namedStyleType: 'NORMAL_TEXT' },
    ]);
    expect(md.runs).toEqual([
      { start: 6, end: 7, bold: true },
      { start: 12, end: 13, link: 'https://e.com' },
      { start: 18, end: 19, code: true },
    ]);
  });

  it('encodes nested list levels as leading tabs', () => {
    const md = markdownToDocs('- a\n  - b\n1. c');
    expect(md.text).toBe('a\n\tb\nc\n');
    expect(md.paragraphs.map((p) => p.bullet)).toEqual([
      { ordered: false, level: 0 },
      { ordered: false, level: 1 },
      { ordered: true, level: 0 },
    ]);
  });

  it('keeps escaped markers and decodes entities', () => {
    expect(markdownToDocs('a \\*b\\* & <c>').text).toBe('a *b* & <c>\n');
  });

  it('parses tables into a placeholder paragraph', () => {
    const md = markdownToDocs('| a |\n|---|\n| 1 |');
    expect(md.tables).toHaveLength(1);
    expect(md.paragraphs[0].table).toBe(0);
  });

  it('detects inline (single plain paragraph) markdown', () => {
    expect(isInline(markdownToDocs('just **text**'))).toBe(true);
    expect(isInline(markdownToDocs('# heading'))).toBe(false);
    expect(isInline(markdownToDocs('a\n\nb'))).toBe(false);
  });
});

describe('flatten / findUnique', () => {
  it('maps text to real doc indices across a non-text element', () => {
    const content = body('Hi\n');
    // Insert a 1-index chip before a later run in a second paragraph.
    content.push({
      startIndex: 4,
      endIndex: 10,
      paragraph: {
        elements: [
          {
            startIndex: 4,
            endIndex: 5,
            person: { personProperties: { name: 'X' } },
          },
          { startIndex: 5, endIndex: 10, textRun: { content: 'ZEBR\n' } },
        ],
      },
    });
    const flat = flatten(content);
    expect(findUnique(flat, 'ZEBR')).toEqual({ start: 5, end: 9 });
    expect(paragraphAt(flat, 5)).toMatchObject({ start: 4, end: 10 });
  });

  it('errors on ambiguous and missing anchors', () => {
    const flat = flatten(body('dup dup\n'));
    expect(() => findUnique(flat, 'dup')).toThrow(/matches 2 places/);
    expect(() => findUnique(flat, 'nope')).toThrow(AnchorError);
  });

  it('accepts anchors quoted with CriticMarkup from readMarkdown', () => {
    const flat = flatten(body('newold text\n'));
    expect(findUnique(flat, '{++new++}{--old--} text')).toEqual({
      start: 1,
      end: 12,
    });
  });

  it('accepts anchors quoted with markdown markers', () => {
    const flat = flatten(body('Section\n', 'Some bold text\n'));
    expect(findUnique(flat, '## Section\n\nSome **bold**')).toEqual({
      start: 1,
      end: 18,
    });
  });
});

describe('buildRequests', () => {
  it('insertAfter inserts at the paragraph newline with a leading newline', () => {
    const flat = flatten(body('One\n', 'Two\n'));
    const edit = insertAfter(markdownToDocs('# New'), flat.paragraphs[0]);
    expect(edit.requests[0]).toEqual({
      insertText: { location: { index: 4, tabId: undefined }, text: '\nNew' },
    });
    expect(edit.inserted).toEqual({ startIndex: 5, endIndex: 9 });
  });

  it('insertAfter fills an empty paragraph instead of leaving it above', () => {
    const flat = flatten(body('One\n', '\n'));
    const edit = insertAfter(markdownToDocs('# New'), flat.paragraphs[1]);
    expect(edit.requests[0]).toEqual({
      insertText: { location: { index: 5, tabId: undefined }, text: 'New' },
    });
    expect(edit.inserted).toEqual({ startIndex: 5, endIndex: 9 });
  });

  it('applies bullets last and back to front', () => {
    const flat = flatten(body('One\n'));
    const edit = insertAfter(
      markdownToDocs('- a\n\npara\n\n1. b'),
      flat.paragraphs[0],
    );
    const bullets = edit.requests
      .map((r, i) => [i, r.createParagraphBullets?.range?.startIndex] as const)
      .filter(([, s]) => s !== undefined);
    expect(bullets.map(([, s]) => s)).toEqual([12, 5]);
    expect(bullets[0][0]).toBeGreaterThan(edit.requests.length - 3);
  });

  it('keeps a bullet nested under a numbered item in one list', () => {
    const flat = flatten(body('One\n'));
    const edit = insertAfter(
      markdownToDocs('1. first\n   - nested'),
      flat.paragraphs[0],
    );
    const bullets = edit.requests.filter((r) => r.createParagraphBullets);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].createParagraphBullets!.bulletPreset).toBe(
      'NUMBERED_DECIMAL_NESTED',
    );
  });

  it('replaceParagraphs keeps the last paragraph newline', () => {
    const flat = flatten(body('One\n', 'Two\n', 'Three\n'));
    const edit = replaceParagraphs(
      markdownToDocs('X'),
      flat.paragraphs[1],
      flat.paragraphs[1],
      flat,
    );
    expect(edit.requests.slice(0, 2)).toEqual([
      {
        deleteContentRange: {
          range: { startIndex: 5, endIndex: 8, tabId: undefined },
        },
      },
      { insertText: { location: { index: 5, tabId: undefined }, text: 'X' } },
    ]);
  });

  it('deleting the last paragraph removes the preceding newline instead', () => {
    const flat = flatten(body('One\n', 'Two\n'));
    const edit = replaceParagraphs(
      markdownToDocs(''),
      flat.paragraphs[1],
      flat.paragraphs[1],
      flat,
    );
    expect(edit.requests).toEqual([
      {
        deleteContentRange: {
          range: { startIndex: 4, endIndex: 8, tabId: undefined },
        },
      },
    ]);
  });
});

describe('task lists', () => {
  it('writes task items as BULLET_CHECKBOX groups, split from plain lists', () => {
    const flat = flatten(body('One\n'));
    const md = markdownToDocs('- [ ] a\n- [x] b\n  - nested\n- plain');
    expect(md.text).toBe('a\nb\n\tnested\nplain\n');
    expect(md.paragraphs.map((p) => p.bullet?.task)).toEqual([
      true,
      true,
      undefined,
      undefined,
    ]);
    const edit = insertAfter(md, flat.paragraphs[0]);
    const presets = edit.requests
      .filter((r) => r.createParagraphBullets)
      .map((r) => r.createParagraphBullets!.bulletPreset);
    expect(presets).toEqual(['BULLET_DISC_CIRCLE_SQUARE', 'BULLET_CHECKBOX']);
  });

  it('reads checkbox lists as unchecked task items', () => {
    const content: any[] = [
      {
        paragraph: {
          bullet: { listId: 'L', nestingLevel: 0 },
          elements: [{ textRun: { content: 'todo\n' } }],
        },
      },
    ];
    const lists = {
      L: { listProperties: { nestingLevels: [{ glyphSymbol: '\u274f' }] } },
    };
    expect(docsToMarkdown(content, lists)).toBe('- [ ] todo\n');
  });
});

describe('multi-paragraph list items', () => {
  it('joins continuation paragraphs and code with line breaks in one item', () => {
    const md = markdownToDocs(
      '1. a\n\n   more\n\n   ```\n   x\n   y\n   ```\n2. b',
    );
    expect(md.text).toBe('a\u000bmore\u000bx\u000by\nb\n');
    expect(md.paragraphs).toHaveLength(2);
    expect(md.runs.filter((r) => r.code)).toHaveLength(2);
  });

  it('rejects text after a nested list', () => {
    expect(() => markdownToDocs('- a\n  - n\n\n  more')).toThrow(
      UnsupportedMarkdownError,
    );
  });

  it('reads line breaks in an item as indented continuation lines', () => {
    const content: any[] = [
      {
        paragraph: {
          bullet: { listId: 'L', nestingLevel: 0 },
          elements: [{ textRun: { content: 'a\u000bb\n' } }],
        },
      },
    ];
    const lists = {
      L: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } },
    };
    expect(docsToMarkdown(content, lists)).toBe('1. a  \n   b\n');
  });
});

describe('underline, superscript, subscript', () => {
  it('parses inline HTML tags into styles', () => {
    const md = markdownToDocs(
      'x<sup>2</sup> H<sub>**2**</sub>O <u>u</u> <sup>open',
    );
    expect(md.text).toBe('x2 H2O u <sup>open\n');
    expect(md.runs).toEqual([
      { start: 1, end: 2, baseline: 'SUPERSCRIPT' },
      { start: 4, end: 5, baseline: 'SUBSCRIPT', bold: true },
      { start: 7, end: 8, underline: true },
    ]);
  });

  it('writes them as text styles and reads them back', () => {
    const flat = flatten(body('One\n'));
    const edit = insertAfter(
      markdownToDocs('a<sup>b</sup><u>c</u>'),
      flat.paragraphs[0],
    );
    const styles = edit.requests
      .filter(
        (r) =>
          r.updateTextStyle?.textStyle?.baselineOffset ||
          r.updateTextStyle?.textStyle?.underline,
      )
      .map((r) => r.updateTextStyle!.textStyle);
    expect(styles).toEqual([
      { baselineOffset: 'SUPERSCRIPT' },
      { underline: true },
    ]);
    const content: any[] = [
      {
        paragraph: {
          elements: [
            { textRun: { content: 'a' } },
            {
              textRun: {
                content: 'b',
                textStyle: { baselineOffset: 'SUPERSCRIPT' },
              },
            },
            { textRun: { content: 'c', textStyle: { underline: true } } },
            {
              textRun: {
                content: 'l',
                textStyle: { underline: true, link: { url: 'http://x' } },
              },
            },
            { textRun: { content: '\n' } },
          ],
        },
      },
    ];
    expect(docsToMarkdown(content, {})).toBe(
      'a<sup>b</sup><u>c</u>[l](http://x)\n',
    );
  });
});

describe('horizontal rule and page break', () => {
  it('writes --- as a bordered empty paragraph and reads it back', () => {
    const md = markdownToDocs('a\n\n---\n\nb');
    expect(md.text).toBe('a\n\nb\n');
    expect(md.paragraphs[1].hr).toBe(true);
    const flat = flatten(body('One\n'));
    const edit = insertAfter(md, flat.paragraphs[0]);
    const ruled = edit.requests.filter(
      (r) => r.updateParagraphStyle?.paragraphStyle?.borderBottom,
    );
    expect(ruled).toHaveLength(1);
    const content: any[] = [
      { paragraph: { elements: [{ textRun: { content: 'a\n' } }] } },
      {
        paragraph: {
          paragraphStyle: { borderBottom: { width: { magnitude: 1 } } },
          elements: [{ textRun: { content: '\n' } }],
        },
      },
      {
        paragraph: {
          elements: [{ horizontalRule: {} }, { textRun: { content: '\n' } }],
        },
      },
    ];
    expect(docsToMarkdown(content, {})).toBe('a\n\n---\n\n---\n');
  });

  it('writes a page break comment as insertPageBreak, back to front', () => {
    const md = markdownToDocs('a\n\n<!-- pagebreak -->\n\nb');
    expect(md.paragraphs[1].pageBreak).toBe(true);
    const flat = flatten(body('One\n'));
    const edit = insertAfter(md, flat.paragraphs[0]);
    const pb = edit.requests.findIndex((r) => r.insertPageBreak);
    expect(edit.requests[pb].insertPageBreak!.location!.index).toBe(7);
    // placeholder newline removed since a paragraph follows
    expect(edit.requests[pb + 1].deleteContentRange!.range).toMatchObject({
      startIndex: 9,
      endIndex: 10,
    });
    expect(edit.inserted).toEqual({
      startIndex: 5,
      endIndex: 5 + md.text.length + 1,
    });
    const content: any[] = [
      {
        paragraph: {
          elements: [{ pageBreak: {} }, { textRun: { content: '\n' } }],
        },
      },
    ];
    expect(docsToMarkdown(content, {})).toBe('<!-- pagebreak -->\n');
  });
});

describe('docsToMarkdown', () => {
  it('marks pending suggestions with CriticMarkup', () => {
    const content: any[] = [
      {
        paragraph: {
          elements: [
            { textRun: { content: 'new', suggestedInsertionIds: ['s1'] } },
            { textRun: { content: 'old', suggestedDeletionIds: ['s2'] } },
            { textRun: { content: '\n' } },
          ],
        },
      },
    ];
    expect(docsToMarkdown(content, {})).toBe('{++new++}{--old--}\n');
  });

  it('renders headings, bold runs and lists', () => {
    const content: any[] = [
      {
        paragraph: {
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          elements: [{ textRun: { content: 'Head\n' } }],
        },
      },
      {
        paragraph: {
          elements: [
            { textRun: { content: 'a ' } },
            { textRun: { content: 'bold', textStyle: { bold: true } } },
            { textRun: { content: ' word\n' } },
          ],
        },
      },
      {
        paragraph: {
          bullet: { listId: 'L', nestingLevel: 0 },
          elements: [{ textRun: { content: 'item\n' } }],
        },
      },
    ];
    expect(
      docsToMarkdown(content, {
        L: { listProperties: { nestingLevels: [{}] } },
      }),
    ).toBe('## Head\n\na **bold** word\n\n- item\n');
  });
});

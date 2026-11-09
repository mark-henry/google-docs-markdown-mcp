/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';
import { MdDoc } from './markdownToDocs';
import { DocParagraph, FlatDoc } from './docIndex';

type Request = docs_v1.Schema$Request;

/** Character styles cleared on inserted text so it doesn't inherit neighbors'. */
const RESET_TEXT_FIELDS =
  'bold,italic,underline,strikethrough,smallCaps,baselineOffset,link,weightedFontFamily,backgroundColor,foregroundColor';

const CODE_FONT = 'Courier New';
const QUOTE_INDENT_PT = 36;

export interface Edit {
  requests: Request[];
  /** Doc range the new content occupies after the edit. */
  inserted: { startIndex: number; endIndex: number };
}

/** Insert block markdown as new paragraphs before paragraph `p`. */
export function insertBefore(md: MdDoc, p: DocParagraph, tabId?: string): Edit {
  const requests: Request[] = [insertText(p.start, md.text, tabId)];
  return finishBlock(md, p.start, requests, tabId);
}

/**
 * Insert block markdown as new paragraphs after paragraph `p`. Inserting at
 * p's own newline works whether or not p is the last paragraph of its body or
 * table cell, which a plain insert at p.end would not.
 */
export function insertAfter(md: MdDoc, p: DocParagraph, tabId?: string): Edit {
  const at = p.end - 1;
  const requests: Request[] = [
    insertText(at, '\n' + md.text.slice(0, -1), tabId),
  ];
  return finishBlock(md, at + 1, requests, tabId);
}

/**
 * Replace whole paragraphs first..last with block markdown. The last
 * paragraph's newline is kept and terminates the new content, so the edit
 * never deletes a body's or cell's final newline.
 */
export function replaceParagraphs(
  md: MdDoc,
  first: DocParagraph,
  last: DocParagraph,
  flat: FlatDoc,
  tabId?: string,
): Edit {
  const requests: Request[] = [];
  if (md.text === '') {
    return deleteParagraphs(first, last, flat, tabId);
  }
  if (last.end - 1 > first.start) {
    requests.push(deleteRange(first.start, last.end - 1, tabId));
  }
  const body = md.text.slice(0, -1);
  if (body) requests.push(insertText(first.start, body, tabId));
  return finishBlock(md, first.start, requests, tabId);
}

/** Replace [start, end) inside a paragraph with inline markdown. */
export function replaceInline(
  md: MdDoc,
  start: number,
  end: number,
  tabId?: string,
): Edit {
  const text = md.text.replace(/\n$/, '');
  const requests: Request[] = [deleteRange(start, end, tabId)];
  if (text) {
    requests.push(insertText(start, text, tabId));
    requests.push(resetTextStyle(start, start + text.length, tabId));
    requests.push(...runStyles(md, start, tabId, text.length));
  }
  return {
    requests,
    inserted: { startIndex: start, endIndex: start + text.length },
  };
}

function deleteParagraphs(
  first: DocParagraph,
  last: DocParagraph,
  flat: FlatDoc,
  tabId?: string,
): Edit {
  const siblings = flat.paragraphs.filter(
    (p) => p.container === first.container,
  );
  const isLastInContainer = siblings[siblings.length - 1].end === last.end;
  const prev = siblings.filter((p) => p.end <= first.start).pop();
  let range: [number, number];
  if (!isLastInContainer) {
    range = [first.start, last.end];
  } else if (prev) {
    // Remove the preceding newline instead of the container's final one.
    range = [prev.end - 1, last.end - 1];
  } else {
    // The container would be empty; leave one empty paragraph.
    range = [first.start, last.end - 1];
  }
  const requests =
    range[1] > range[0] ? [deleteRange(range[0], range[1], tabId)] : [];
  return { requests, inserted: { startIndex: range[0], endIndex: range[0] } };
}

function finishBlock(
  md: MdDoc,
  base: number,
  requests: Request[],
  tabId?: string,
): Edit {
  const end = base + md.text.length;
  requests.push({
    deleteParagraphBullets: {
      range: { startIndex: base, endIndex: end, tabId },
    },
  });
  for (const p of md.paragraphs) {
    const indent = (p.quote ?? 0) * QUOTE_INDENT_PT;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: base + p.start, endIndex: base + p.end, tabId },
        paragraphStyle: {
          namedStyleType: p.namedStyleType,
          indentStart: { magnitude: indent, unit: 'PT' },
          indentFirstLine: { magnitude: indent, unit: 'PT' },
        },
        fields: 'namedStyleType,indentStart,indentFirstLine',
      },
    });
  }
  requests.push(resetTextStyle(base, end, tabId));
  for (const p of md.paragraphs) {
    if (p.code && p.end - 1 > p.start) {
      requests.push(
        textStyle(
          base + p.start,
          base + p.end - 1,
          {
            weightedFontFamily: { fontFamily: CODE_FONT },
          },
          tabId,
        ),
      );
    }
  }
  requests.push(...runStyles(md, base, tabId));
  requests.push(...bulletRequests(md, base, tabId));
  return { requests, inserted: { startIndex: base, endIndex: end } };
}

function runStyles(
  md: MdDoc,
  base: number,
  tabId?: string,
  limit = Infinity,
): Request[] {
  const out: Request[] = [];
  for (const r of md.runs) {
    const end = Math.min(r.end, limit);
    if (end <= r.start) continue;
    const style: docs_v1.Schema$TextStyle = {};
    if (r.bold) style.bold = true;
    if (r.italic) style.italic = true;
    if (r.strikethrough) style.strikethrough = true;
    if (r.code) style.weightedFontFamily = { fontFamily: CODE_FONT };
    if (r.link) style.link = { url: r.link };
    out.push(textStyle(base + r.start, base + end, style, tabId));
  }
  return out;
}

/**
 * Bullets go last: createParagraphBullets strips the leading tabs that encode
 * nesting, which shifts later indices, so groups are applied back to front.
 */
function bulletRequests(md: MdDoc, base: number, tabId?: string): Request[] {
  const groups: { start: number; end: number; ordered: boolean }[] = [];
  for (const p of md.paragraphs) {
    if (!p.bullet) continue;
    const g = groups[groups.length - 1];
    // One group per run of consecutive items: splitting at an ordered/
    // unordered change would drop the nesting of the later items. The
    // preset follows the run's first (top-level) item.
    if (g && g.end === p.start) {
      g.end = p.end;
    } else {
      groups.push({ start: p.start, end: p.end, ordered: p.bullet.ordered });
    }
  }
  return groups.reverse().map((g) => ({
    createParagraphBullets: {
      range: { startIndex: base + g.start, endIndex: base + g.end - 1, tabId },
      bulletPreset: g.ordered
        ? 'NUMBERED_DECIMAL_ALPHA_ROMAN'
        : 'BULLET_DISC_CIRCLE_SQUARE',
    },
  }));
}

function insertText(index: number, text: string, tabId?: string): Request {
  return { insertText: { location: { index, tabId }, text } };
}

function deleteRange(start: number, end: number, tabId?: string): Request {
  return {
    deleteContentRange: { range: { startIndex: start, endIndex: end, tabId } },
  };
}

function resetTextStyle(start: number, end: number, tabId?: string): Request {
  return {
    updateTextStyle: {
      range: { startIndex: start, endIndex: end, tabId },
      textStyle: {},
      fields: RESET_TEXT_FIELDS,
    },
  };
}

function textStyle(
  start: number,
  end: number,
  style: docs_v1.Schema$TextStyle,
  tabId?: string,
): Request {
  return {
    updateTextStyle: {
      range: { startIndex: start, endIndex: end, tabId },
      textStyle: style,
      fields: Object.keys(style).join(','),
    },
  };
}

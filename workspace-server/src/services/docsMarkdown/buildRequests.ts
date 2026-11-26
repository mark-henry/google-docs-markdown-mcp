/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';
import { MdDoc, MdParagraph } from './markdownToDocs';
import { DocParagraph, FlatDoc } from './docIndex';

type Request = docs_v1.Schema$Request;

/** Character styles cleared on inserted text so it doesn't inherit neighbors'. */
const RESET_TEXT_FIELDS =
  'bold,italic,underline,strikethrough,smallCaps,baselineOffset,link,weightedFontFamily,backgroundColor,foregroundColor';

const CODE_FONT = 'Courier New';
const QUOTE_INDENT_PT = 36;

/**
 * The Docs API has no request that inserts a horizontal-rule element, so a
 * rule is an empty paragraph with a bottom border (it reads back as `---`).
 */
const RULE_BORDER: docs_v1.Schema$ParagraphBorder = {
  color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
  width: { magnitude: 1, unit: 'PT' },
  padding: { magnitude: 1, unit: 'PT' },
  dashStyle: 'SOLID',
};

/**
 * What surrounds the new content in the doc, which decides whether the empty
 * paragraphs Docs leaves around an inserted table can be removed: a table
 * needs a paragraph before it and after it.
 */
export interface Surroundings {
  /** A body paragraph ends right where the new content starts. */
  preceded: boolean;
  /** A body paragraph starts right after the new content's last newline. */
  followed: boolean;
}

const OPEN: Surroundings = { preceded: false, followed: false };

export interface Edit {
  requests: Request[];
  /** Doc range the new content occupies after the edit. */
  inserted: { startIndex: number; endIndex: number };
}

/** Insert block markdown as new paragraphs before paragraph `p`. */
export function insertBefore(
  md: MdDoc,
  p: DocParagraph,
  tabId?: string,
  around: Surroundings = OPEN,
): Edit {
  const requests: Request[] = [insertText(p.start, md.text, tabId)];
  return finishBlock(md, p.start, requests, tabId, around);
}

/**
 * Insert block markdown as new paragraphs after paragraph `p`. Inserting at
 * p's own newline works whether or not p is the last paragraph of its body or
 * table cell, which a plain insert at p.end would not.
 */
export function insertAfter(
  md: MdDoc,
  p: DocParagraph,
  tabId?: string,
  around: Surroundings = OPEN,
): Edit {
  if (p.end - p.start === 1) {
    // p is empty (just its newline), as in a new doc: fill it rather than
    // leaving a blank line above the new content.
    const requests: Request[] = [
      insertText(p.start, md.text.slice(0, -1), tabId),
    ];
    return finishBlock(md, p.start, requests, tabId, around);
  }
  const at = p.end - 1;
  const requests: Request[] = [
    insertText(at, '\n' + md.text.slice(0, -1), tabId),
  ];
  return finishBlock(md, at + 1, requests, tabId, {
    ...around,
    preceded: true,
  });
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
  around: Surroundings = OPEN,
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
  return finishBlock(md, first.start, requests, tabId, around);
}

/**
 * Replace the body range [start, tableEnd), which ends with a whole table,
 * with block markdown. The paragraph after the table is kept and follows the
 * new content.
 */
export function replaceThroughTable(
  md: MdDoc,
  start: number,
  tableEnd: number,
  tabId?: string,
  preceded = false,
): Edit {
  const requests: Request[] = [deleteRange(start, tableEnd, tabId)];
  if (md.text === '') {
    return { requests, inserted: { startIndex: start, endIndex: start } };
  }
  requests.push(insertText(start, md.text, tabId));
  return finishBlock(md, start, requests, tabId, { preceded, followed: true });
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
  around: Surroundings = OPEN,
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
          // Always listed so a border inherited from a neighbor is cleared.
          ...(p.hr ? { borderBottom: RULE_BORDER } : {}),
        },
        fields: 'namedStyleType,indentStart,indentFirstLine,borderBottom',
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
  const tables = tableRequests(md, base, tabId, around);
  requests.push(...tables.requests);
  const tabs = md.paragraphs
    .filter((p) => p.bullet)
    .reduce((n, p) => n + p.bullet!.level, 0);
  return {
    requests,
    inserted: { startIndex: base, endIndex: end - tabs + tables.growth },
  };
}

/**
 * Tables go in after everything else, back to front, each into its
 * placeholder paragraph. Docs inserts a newline before a new table, so the
 * table at Q sits at Q + 1 and its cells' paragraphs at fixed offsets from
 * there (verified against the live API): cell (r, c) of a C-column table at T
 * has its paragraph at T + 3 + r * (1 + 2C) + 2c, and the empty table is
 * 2 + R * (1 + 2C) long. Cells are filled back to front, so earlier offsets
 * hold. The empty paragraphs left on either side are then removed where a
 * paragraph remains to hold the table's place.
 */
function tableRequests(
  md: MdDoc,
  base: number,
  tabId: string | undefined,
  around: Surroundings,
): { requests: Request[]; growth: number } {
  const requests: Request[] = [];
  let growth = 0;
  const paras = md.paragraphs;
  // Bullet creation (earlier in the batch) removed the nesting tabs.
  const tabsBefore = (p: MdParagraph) =>
    paras
      .filter((q) => q.bullet && q.start < p.start)
      .reduce((n, q) => n + q.bullet!.level, 0);
  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i];
    if (p.table === undefined && !p.pageBreak) continue;
    if (p.pageBreak) {
      // Docs inserts the break plus a newline at Q, so the placeholder's own
      // newline ends up after them; remove it where a paragraph remains to
      // follow (never right before a table, which Docs refuses).
      const Q = base + p.start - tabsBefore(p);
      requests.push({ insertPageBreak: { location: { index: Q, tabId } } });
      growth += 2;
      const next = paras[i + 1];
      if (next ? next.table === undefined : around.followed) {
        requests.push(deleteRange(Q + 2, Q + 3, tabId));
        growth -= 1;
      }
      continue;
    }
    const table = md.tables[p.table!];
    const C = table.columns;
    const R = table.rows.length;
    const Q = base + p.start - tabsBefore(p);
    const T = Q + 1;
    requests.push({
      insertTable: { rows: R, columns: C, location: { index: Q, tabId } },
    });
    let filled = 0;
    for (let r = R - 1; r >= 0; r--) {
      for (let c = C - 1; c >= 0; c--) {
        const cell = table.rows[r][c];
        if (!cell.text) continue;
        const at = T + 3 + r * (1 + 2 * C) + 2 * c;
        filled += cell.text.length;
        requests.push(insertText(at, cell.text, tabId));
        requests.push(resetTextStyle(at, at + cell.text.length, tabId));
        requests.push(
          ...runStyles(
            { text: cell.text, paragraphs: [], runs: cell.runs, tables: [] },
            at,
            tabId,
          ),
        );
      }
    }
    const length = 2 + R * (1 + 2 * C) + filled;
    growth += 1 + length;
    const next = paras[i + 1];
    const followed = next ? next.table === undefined : around.followed;
    if (followed) {
      // The placeholder's own newline, now just after the table.
      requests.push(deleteRange(T + length, T + length + 1, tabId));
      growth -= 1;
    }
    const prev = paras[i - 1];
    const preceded = prev ? prev.table === undefined : around.preceded;
    if (preceded) {
      // Docs refuses to delete the newline right before a table, but
      // deleting the previous paragraph's newline merges it with the new
      // empty one and keeps the previous paragraph's style.
      requests.push(deleteRange(Q - 1, Q, tabId));
      growth -= 1;
    }
  }
  return { requests, growth };
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
    if (r.underline) style.underline = true;
    if (r.baseline) style.baselineOffset = r.baseline;
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
  const kindOf = (b: { ordered: boolean; task?: boolean }) =>
    b.task ? 'task' : b.ordered ? 'ordered' : 'bullet';
  const groups: { start: number; end: number; kind: string }[] = [];
  for (const p of md.paragraphs) {
    if (!p.bullet) continue;
    const g = groups[groups.length - 1];
    // One group per run of consecutive items, split only where a top-level
    // item changes kind (task / numbered / bulleted): splitting at a nested
    // item would drop its nesting. The preset follows the group's first item.
    if (
      g &&
      g.end === p.start &&
      (p.bullet.level > 0 || kindOf(p.bullet) === g.kind)
    ) {
      g.end = p.end;
    } else {
      groups.push({ start: p.start, end: p.end, kind: kindOf(p.bullet) });
    }
  }
  const PRESETS: Record<string, string> = {
    task: 'BULLET_CHECKBOX',
    // The only preset whose nested levels stay numeric (1. / 1.1. / 1.1.1.);
    // the alternatives show a./b./c. at level 1 and i./ii. at level 2.
    ordered: 'NUMBERED_DECIMAL_NESTED',
    bullet: 'BULLET_DISC_CIRCLE_SQUARE',
  };
  return groups.reverse().map((g) => ({
    createParagraphBullets: {
      range: { startIndex: base + g.start, endIndex: base + g.end - 1, tabId },
      bulletPreset: PRESETS[g.kind],
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

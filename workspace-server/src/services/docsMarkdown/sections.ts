/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';
import { DocParagraph, FlatDoc, AnchorError, OBJECT_CHAR } from './docIndex';
import { MdDoc, markdownToDocs, markdownToPlain } from './markdownToDocs';
import {
  Edit,
  Surroundings,
  insertAfter,
  insertBefore,
  replaceParagraphs,
} from './buildRequests';

/**
 * A section runs from a heading to the next heading of the same or a higher
 * level (so it includes its subsections), or to the end of the body.
 */
export interface Section {
  heading: DocParagraph;
  level: number;
  title: string;
  /** Doc index of the heading's first character. */
  start: number;
  /** Doc index just past the section's last paragraph. */
  end: number;
  /** The heading that ends the section, if any. */
  next?: DocParagraph;
  /** Body paragraphs of the section, heading first. */
  paragraphs: DocParagraph[];
}

export function headingLevel(p: DocParagraph): number {
  const m = /^HEADING_(\d)$/.exec(p.style ?? '');
  return m ? Number(m[1]) : 0;
}

function bodyParagraphs(flat: FlatDoc): DocParagraph[] {
  return flat.paragraphs.filter((p) => p.container === 'body');
}

function sectionOf(flat: FlatDoc, heading: DocParagraph): Section {
  const level = headingLevel(heading);
  const body = bodyParagraphs(flat);
  const next = body.find(
    (p) =>
      p.start >= heading.end && headingLevel(p) > 0 && headingLevel(p) <= level,
  );
  const paragraphs = body.filter(
    (p) => p.start >= heading.start && (!next || p.start < next.start),
  );
  return {
    heading,
    level,
    title: (heading.text ?? '').trim(),
    start: heading.start,
    end: paragraphs[paragraphs.length - 1].end,
    next,
    paragraphs,
  };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Finds the one section whose heading matches `query`: the heading's text,
 * or `## Text` to also pin the level. Exact match wins over a
 * case-insensitive one.
 */
export function findSection(flat: FlatDoc, query: string): Section {
  let wanted = query.trim();
  let level = 0;
  const m = /^(#{1,6})\s+(.*)$/.exec(wanted);
  if (m) {
    level = m[1].length;
    wanted = m[2];
  }
  let plain = wanted;
  try {
    plain = markdownToPlain(wanted).replace(/\n$/, '') || wanted;
  } catch {
    // Not parseable markdown; compare literally.
  }
  if (!normalize(plain)) throw new AnchorError('Section heading is empty.');

  const headings = bodyParagraphs(flat).filter((p) => headingLevel(p) > 0);
  const eligible = headings.filter((p) => !level || headingLevel(p) === level);
  const tiers = [
    (t: string) => normalize(t) === normalize(plain),
    (t: string) =>
      normalize(t).toLowerCase() === normalize(plain).toLowerCase(),
  ];
  for (const same of tiers) {
    const hits = eligible.filter((p) => same(p.text ?? ''));
    if (hits.length === 1) return sectionOf(flat, hits[0]);
    if (hits.length > 1) {
      const lines = hits
        .slice(0, 5)
        .map((p) => {
          const after = flat.paragraphs.find((q) => q.start === p.end);
          const ctx = after?.text
            ? ` — followed by "${after.text.slice(0, 40)}"`
            : '';
          return `  ${'#'.repeat(headingLevel(p))} ${p.text}${ctx}`;
        })
        .join('\n');
      throw new AnchorError(
        `Section ${JSON.stringify(query)} matches ${hits.length} headings; prefix the heading with its level (e.g. "## Title") or quote its exact text so it matches exactly one:\n${lines}`,
      );
    }
  }
  const available = headings
    .slice(0, 15)
    .map((p) => `  ${'#'.repeat(headingLevel(p))} ${p.text}`)
    .join('\n');
  throw new AnchorError(
    `Section ${JSON.stringify(query)} not found: no heading has that text. Headings in the doc:\n${available || '  (none)'}`,
  );
}

/** Body paragraphs under the heading, up to the end of the section. */
function bodyOf(sec: Section): DocParagraph[] {
  return sec.paragraphs.slice(1);
}

/** Surroundings of a block inserted at `boundary`, from its neighbors. */
function around(flat: FlatDoc, boundary: number): Surroundings {
  const body = bodyParagraphs(flat);
  return {
    preceded: body.some((p) => p.end === boundary),
    followed: body.some((p) => p.start === boundary),
  };
}

/** Replace everything under the heading, keeping the heading itself. */
export function replaceSectionBody(
  md: MdDoc,
  sec: Section,
  flat: FlatDoc,
  tabId?: string,
): Edit {
  const body = bodyOf(sec);
  if (body.length === 0) {
    if (!md.text) {
      return {
        requests: [],
        inserted: { startIndex: sec.end, endIndex: sec.end },
      };
    }
    return insertAfter(md, sec.heading, tabId, around(flat, sec.end));
  }
  // Start at the heading's end, not the first paragraph's, so a table
  // directly under the heading goes too.
  const first: DocParagraph = {
    start: sec.heading.end,
    end: body[0].end,
    container: 'body',
  };
  return replaceParagraphs(
    md,
    first,
    body[body.length - 1],
    flat,
    tabId,
    around(flat, sec.heading.end),
  );
}

/** Replace the heading and everything under it (empty markdown deletes). */
export function replaceWholeSection(
  md: MdDoc,
  sec: Section,
  flat: FlatDoc,
  tabId?: string,
): Edit {
  return replaceParagraphs(
    md,
    sec.heading,
    sec.paragraphs[sec.paragraphs.length - 1],
    flat,
    tabId,
    around(flat, sec.start),
  );
}

/** Insert right under the heading, or after the section's last paragraph. */
export function insertInSection(
  md: MdDoc,
  sec: Section,
  where: 'beginning' | 'end',
  flat: FlatDoc,
  tabId?: string,
): Edit {
  const p =
    where === 'beginning'
      ? sec.heading
      : sec.paragraphs[sec.paragraphs.length - 1];
  return insertAfter(md, p, tabId, {
    preceded: true,
    followed: bodyParagraphs(flat).some((q) => q.start === p.end),
  });
}

export type MoveTarget =
  | { before: Section }
  | { after: Section }
  | { at: 'beginning' | 'end' };

/**
 * Move `src` to `target`: insert its markdown copy at the destination and
 * delete the original, later position first so the earlier indices hold
 * (also true in suggest mode, where deletions don't shift anything).
 */
export function moveSection(
  md: MdDoc,
  src: Section,
  target: MoveTarget,
  flat: FlatDoc,
  tabId?: string,
): Edit {
  const body = bodyParagraphs(flat);
  let boundary: number;
  let insert: Edit;
  if ('before' in target) {
    boundary = target.before.start;
    insert = insertBefore(
      md,
      target.before.heading,
      tabId,
      around(flat, boundary),
    );
  } else if ('after' in target) {
    const t = target.after;
    if (t.next) {
      boundary = t.next.start;
      insert = insertBefore(md, t.next, tabId, around(flat, boundary));
    } else {
      const last = t.paragraphs[t.paragraphs.length - 1];
      boundary = last.end;
      insert = insertAfter(md, last, tabId, around(flat, boundary));
    }
  } else if (target.at === 'beginning') {
    boundary = body[0].start;
    insert = insertBefore(md, body[0], tabId, around(flat, boundary));
  } else {
    const last = body[body.length - 1];
    boundary = last.end;
    insert = insertAfter(md, last, tabId, around(flat, boundary));
  }
  if (boundary >= src.start && boundary <= src.end) {
    throw new AnchorError(
      'That destination is inside the section or right where it already is; nothing to move.',
    );
  }
  const remove = replaceWholeSection(markdownToDocs(''), src, flat, tabId);
  const requests =
    boundary > src.end
      ? [...insert.requests, ...remove.requests]
      : [...remove.requests, ...insert.requests];
  return { requests, inserted: insert.inserted };
}

/** Structural elements lying within doc range [start, end). */
export function elementsIn(
  content: docs_v1.Schema$StructuralElement[] | undefined,
  start: number,
  end: number,
): docs_v1.Schema$StructuralElement[] {
  return (content ?? []).filter(
    (el) => (el.startIndex ?? 0) >= start && (el.endIndex ?? 0) <= end,
  );
}

/**
 * Reasons a section can't be copied through markdown without losing content
 * (empty means the copy is faithful as far as text goes). Formatting beyond
 * what markdown carries (colors, fonts, alignment) is not checked.
 */
export function copyLosses(
  flat: FlatDoc,
  sec: Section,
  content: docs_v1.Schema$StructuralElement[],
  md: MdDoc,
): string[] {
  const losses: string[] = [];
  const text = flat.paragraphs
    .filter((p) => p.start >= sec.start && p.end <= sec.end)
    .map((p) => p.text ?? '')
    .join('\n');
  if (text.includes(OBJECT_CHAR)) {
    losses.push(
      'it contains images, chips, footnotes or other non-text elements, which markdown cannot carry',
    );
  }
  if (JSON.stringify(content).match(/"suggested(Insertion|Deletion)Ids"/)) {
    losses.push('it contains pending suggestions; resolve them first');
  }
  const strip = (s: string) => s.replace(/[\t\s]+/g, ' ').trim();
  const orig = flat.paragraphs
    .filter(
      (p) => p.container === 'body' && p.start >= sec.start && p.end <= sec.end,
    )
    .map((p) => strip(p.text ?? ''))
    .filter(Boolean);
  const copy = md.paragraphs
    .filter((p) => p.table === undefined)
    .map((p) => strip(md.text.slice(p.start, p.end)))
    .filter(Boolean);
  if (JSON.stringify(orig) !== JSON.stringify(copy)) {
    losses.push(
      'its text would not survive the markdown round trip unchanged (e.g. unusual line breaks or characters)',
    );
  }
  const cells = (xs: string[]) => strip(xs.join(' '));
  const origCells = cells(
    flat.paragraphs
      .filter(
        (p) =>
          p.container !== 'body' && p.start >= sec.start && p.end <= sec.end,
      )
      .map((p) => p.text ?? ''),
  );
  const copyCells = cells(
    md.tables.flatMap((t) => t.rows.flatMap((r) => r.map((c) => c.text))),
  );
  if (origCells !== copyCells) {
    losses.push('table contents would change in the copy');
  }
  return losses;
}

/** Open comment threads whose quoted text lies in the section's text. */
export function commentsIn(sec: Section, quotes: string[]): string[] {
  const text = sec.paragraphs.map((p) => p.text ?? '').join('\n');
  return quotes.filter((q) => q && text.includes(q));
}

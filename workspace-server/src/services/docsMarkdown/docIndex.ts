/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';
import { markdownToPlain } from './markdownToDocs';

/** Placeholder for non-text inline elements (chips, images, footnote refs). */
export const OBJECT_CHAR = '￼';

export interface DocParagraph {
  /** Doc index of the paragraph's first character. */
  start: number;
  /** Doc index just past the paragraph's trailing '\n'. */
  end: number;
  /** Paragraphs in the same body or table cell share a container. */
  container: string;
}

/**
 * A segment's text with each character's real document index, so positions
 * come from the document structure rather than from counting characters.
 */
export interface FlatDoc {
  text: string;
  /** index[i] is the document index of text[i]. */
  index: number[];
  paragraphs: DocParagraph[];
  /** Doc index of the segment's final '\n' (cannot be deleted). */
  endIndex: number;
}

export function flatten(
  content: docs_v1.Schema$StructuralElement[] | undefined,
): FlatDoc {
  const flat: FlatDoc = { text: '', index: [], paragraphs: [], endIndex: 1 };

  const walk = (
    elements: docs_v1.Schema$StructuralElement[] | undefined,
    container: string,
  ) => {
    for (const el of elements ?? []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          const start = pe.startIndex ?? 0;
          if (pe.textRun?.content != null) {
            const content = pe.textRun.content;
            for (let k = 0; k < content.length; k++) {
              flat.text += content[k];
              flat.index.push(start + k);
            }
          } else {
            const width = (pe.endIndex ?? start + 1) - start;
            for (let k = 0; k < width; k++) {
              flat.text += OBJECT_CHAR;
              flat.index.push(start + k);
            }
          }
        }
        flat.paragraphs.push({
          start: el.startIndex ?? 0,
          end: el.endIndex ?? 0,
          container,
        });
      } else if (el.table) {
        el.table.tableRows?.forEach((row, r) =>
          row.tableCells?.forEach((cell, c) =>
            walk(cell.content, `table@${el.startIndex}:${r}:${c}`),
          ),
        );
      }
      if (container === 'body' && el.endIndex != null) {
        flat.endIndex = el.endIndex - 1;
      }
    }
  };

  walk(content, 'body');
  return flat;
}

export class AnchorError extends Error {}

/**
 * Finds `needle` exactly once in the document and returns its doc range
 * [start, end). Falls back to matching the needle with markdown markers
 * stripped, so text quoted from readMarkdown output works as an anchor.
 */
export function findUnique(
  flat: FlatDoc,
  needle: string,
): { start: number; end: number } {
  if (!needle) throw new AnchorError('Anchor text is empty.');

  // readMarkdown marks pending suggestions with CriticMarkup; the document
  // text contains both the suggested insertion and deletion, unmarked.
  const unmarked = needle.replace(/\{\+\+|\+\+\}|\{--|--\}/g, '');
  const candidates = unmarked === needle ? [needle] : [needle, unmarked];
  try {
    const plain = markdownToPlain(unmarked);
    if (plain && plain !== needle) candidates.push(plain);
  } catch {
    // Not parseable as markdown we support; only the literal form is tried.
  }

  for (const candidate of candidates) {
    const hits = occurrences(flat.text, candidate);
    if (hits.length === 1) {
      const i = hits[0];
      return {
        start: flat.index[i],
        end: flat.index[i + candidate.length - 1] + 1,
      };
    }
    if (hits.length > 1) {
      const contexts = hits
        .slice(0, 5)
        .map((i) => `  …${snippet(flat.text, i, candidate.length)}…`)
        .join('\n');
      throw new AnchorError(
        `Anchor ${JSON.stringify(candidate)} matches ${hits.length} places; quote more surrounding text so it matches exactly one:\n${contexts}`,
      );
    }
  }
  throw new AnchorError(
    `Anchor ${JSON.stringify(needle)} not found in the document. Quote text exactly as it appears (readMarkdown output works).`,
  );
}

export function paragraphAt(flat: FlatDoc, docIndex: number): DocParagraph {
  const p = flat.paragraphs.find(
    (para) => para.start <= docIndex && docIndex < para.end,
  );
  if (!p) throw new AnchorError(`No paragraph contains index ${docIndex}.`);
  return p;
}

function occurrences(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    hits.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return hits;
}

function snippet(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 30);
  const to = Math.min(text.length, at + len + 30);
  return text.slice(from, to).replace(/\n/g, '⏎');
}

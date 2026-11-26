/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';
import { FlatDoc, AnchorError, OBJECT_CHAR } from './docIndex';

export interface ReplaceAllPlan {
  count: number;
  /** Doc ranges of the matches, in document order. */
  hits: { start: number; end: number }[];
  /** Back to front, so earlier indices hold. */
  requests: docs_v1.Schema$Request[];
}

/**
 * Plan a plain-text replace of every non-overlapping occurrence of `find`
 * (optionally only inside doc range `within`). Each match is replaced by
 * inserting the new text at the match's end, then deleting the match: the
 * new text inherits the matched text's style, and indices before the match
 * don't move, in edit or suggest mode alike. The count comes from the same
 * scan that builds the requests, so a count check is exact.
 */
export function planReplaceAll(
  flat: FlatDoc,
  find: string,
  replacement: string,
  opts: {
    matchCase?: boolean;
    within?: { start: number; end: number };
    tabId?: string;
  } = {},
): ReplaceAllPlan {
  if (!find) throw new AnchorError('Text to find is empty.');
  if (find.includes('\n') || replacement.includes('\n')) {
    throw new AnchorError(
      'Replace-all works within a paragraph: neither the text nor its replacement may contain a newline. Use replaceMarkdown for multi-paragraph edits.',
    );
  }
  if (find === replacement) {
    throw new AnchorError('The replacement is identical to the text found.');
  }
  const matchCase = opts.matchCase ?? true;
  const hay = matchCase ? flat.text : flat.text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  if (hay.length !== flat.text.length) {
    throw new AnchorError(
      'Case-insensitive matching is not supported for this document text; use matchCase.',
    );
  }
  const hits: { start: number; end: number }[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const start = flat.index[i];
    const end = flat.index[i + needle.length - 1] + 1;
    const inside =
      !opts.within || (start >= opts.within.start && end <= opts.within.end);
    const contiguous = end - start === needle.length;
    const plain = !flat.text.slice(i, i + needle.length).includes(OBJECT_CHAR);
    if (inside && contiguous && plain) hits.push({ start, end });
    i = hay.indexOf(needle, i + needle.length);
  }
  const requests: docs_v1.Schema$Request[] = [];
  for (const h of [...hits].reverse()) {
    if (replacement) {
      requests.push({
        insertText: {
          location: { index: h.end, tabId: opts.tabId },
          text: replacement,
        },
      });
    }
    requests.push({
      deleteContentRange: {
        range: { startIndex: h.start, endIndex: h.end, tabId: opts.tabId },
      },
    });
  }
  return { count: hits.length, hits, requests };
}

/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';
import { markdownToDocs } from '../../../services/docsMarkdown/markdownToDocs';
import { flatten } from '../../../services/docsMarkdown/docIndex';
import {
  insertAfter,
  Edit,
} from '../../../services/docsMarkdown/buildRequests';
import { docsToMarkdown } from '../../../services/docsMarkdown/docsToMarkdown';
import { FakeDoc } from './fakeDocs';

/** Reads a (fake or real) document back the way docs_readMarkdown does. */
export function readMarkdown(doc: docs_v1.Schema$Document): string {
  return docsToMarkdown(
    doc.body?.content,
    doc.lists ?? undefined,
    doc.inlineObjects ?? undefined,
  );
}

/** Appends markdown after the last body paragraph, as docs_insertMarkdown does. */
export function insertMarkdownAtEnd(doc: FakeDoc, markdown: string): Edit {
  const flat = flatten(doc.toDocument().body?.content);
  const bodyParas = flat.paragraphs.filter((p) => p.container === 'body');
  const edit = insertAfter(
    markdownToDocs(markdown),
    bodyParas[bodyParas.length - 1],
  );
  doc.batchUpdate(edit.requests);
  return edit;
}

export interface RoundTripResult {
  /** Markdown read back from the doc. */
  markdown: string;
  doc: FakeDoc;
  edit: Edit;
}

/** markdown -> requests -> fake doc -> readMarkdown, starting from a new empty doc. */
export function roundTripDetailed(markdown: string): RoundTripResult {
  const doc = new FakeDoc();
  const edit = insertMarkdownAtEnd(doc, markdown);
  return { markdown: readMarkdown(doc.toDocument()), doc, edit };
}

export function roundTrip(markdown: string): string {
  return roundTripDetailed(markdown).markdown;
}

/**
 * The only normalization applied before comparing: line endings and one
 * trailing newline. Everything else must match or be listed as a drift.
 */
export function normalize(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

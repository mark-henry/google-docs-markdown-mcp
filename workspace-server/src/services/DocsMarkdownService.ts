/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, docs_v1 } from 'googleapis';
import { AuthManager } from '../auth/AuthManager';
import { logToFile } from '../utils/logger';
import { extractDocId } from '../utils/IdUtils';
import { gaxiosOptions } from '../utils/GaxiosConfig';
import { markdownToDocs, isInline } from './docsMarkdown/markdownToDocs';
import {
  flatten,
  findUnique,
  paragraphAt,
  FlatDoc,
} from './docsMarkdown/docIndex';
import {
  insertAfter,
  insertBefore,
  replaceInline,
  replaceParagraphs,
  Edit,
} from './docsMarkdown/buildRequests';
import { docsToMarkdown } from './docsMarkdown/docsToMarkdown';

type Mode = 'edit' | 'suggest';

interface Loaded {
  id: string;
  tabId: string;
  revisionId: string;
  flat: FlatDoc;
  tab: docs_v1.Schema$Tab;
  title: string;
}

/**
 * Markdown-in, markdown-out editing for Google Docs. Callers point at places
 * by quoting document text; all index arithmetic happens here, against the
 * document structure, and each call is one atomic batchUpdate pinned to the
 * revision it read.
 */
export class DocsMarkdownService {
  constructor(private authManager: AuthManager) {}

  private async client(): Promise<docs_v1.Docs> {
    const auth = await this.authManager.getAuthenticatedClient();
    return google.docs({ version: 'v1', ...gaxiosOptions, auth });
  }

  private async load(
    docs: docs_v1.Docs,
    documentId: string,
    tabId?: string,
  ): Promise<Loaded> {
    const id = extractDocId(documentId) || documentId;
    const res = await docs.documents.get({
      documentId: id,
      includeTabsContent: true,
      suggestionsViewMode: 'SUGGESTIONS_INLINE',
    });
    const tabs = flattenTabs(res.data.tabs ?? []);
    const tab = tabId
      ? tabs.find((t) => t.tabProperties?.tabId === tabId)
      : tabs[0];
    if (!tab) {
      throw new Error(
        `Tab ${tabId} not found. Tabs: ${tabs.map((t) => `${t.tabProperties?.tabId} (${t.tabProperties?.title})`).join(', ')}`,
      );
    }
    return {
      id,
      tabId: tab.tabProperties?.tabId ?? '',
      revisionId: res.data.revisionId ?? '',
      flat: flatten(tab.documentTab?.body?.content),
      tab,
      title: res.data.title ?? '',
    };
  }

  private async apply(docs: docs_v1.Docs, doc: Loaded, edit: Edit, mode: Mode) {
    if (edit.requests.length === 0) return;
    await docs.documents.batchUpdate({
      documentId: doc.id,
      requestBody: {
        requests: edit.requests,
        // writeMode is in the live API but not yet in the generated types.
        writeControl: {
          requiredRevisionId: doc.revisionId,
          ...(mode === 'suggest' ? { writeMode: 'SUGGEST' } : {}),
        } as docs_v1.Schema$WriteControl,
      },
    });
  }

  public readMarkdown = ({
    documentId,
    tabId,
  }: {
    documentId: string;
    tabId?: string;
  }) =>
    run('readMarkdown', async () => {
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const md = docsToMarkdown(
        doc.tab.documentTab?.body?.content,
        doc.tab.documentTab?.lists ?? undefined,
      );
      return `<!-- ${doc.title} | tab ${doc.tabId} -->\n${md}`;
    });

  public insertMarkdown = ({
    documentId,
    markdown,
    at,
    after,
    before,
    tabId,
    mode = 'edit',
  }: {
    documentId: string;
    markdown: string;
    at?: 'beginning' | 'end';
    after?: string;
    before?: string;
    tabId?: string;
    mode?: Mode;
  }) =>
    run('insertMarkdown', async () => {
      const targets = [at, after, before].filter((x) => x !== undefined);
      if (targets.length !== 1) {
        throw new Error(
          'Give exactly one of: at ("beginning" | "end"), after (quoted text), before (quoted text).',
        );
      }
      const md = markdownToDocs(markdown);
      if (!md.text) throw new Error('Markdown is empty.');
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const { flat } = doc;
      const body = flat.paragraphs.filter((p) => p.container === 'body');

      let edit: Edit;
      if (at === 'beginning') {
        edit = insertBefore(md, body[0], doc.tabId);
      } else if (at === 'end') {
        edit = insertAfter(md, body[body.length - 1], doc.tabId);
      } else if (after !== undefined) {
        const hit = findUnique(flat, after);
        edit = insertAfter(md, paragraphAt(flat, hit.end - 1), doc.tabId);
      } else {
        const hit = findUnique(flat, before!);
        edit = insertBefore(md, paragraphAt(flat, hit.start), doc.tabId);
      }
      await this.apply(docs, doc, edit, mode);
      return summary('Inserted', doc, edit, mode);
    });

  public replaceMarkdown = ({
    documentId,
    find,
    markdown,
    tabId,
    mode = 'edit',
  }: {
    documentId: string;
    find: string;
    markdown: string;
    tabId?: string;
    mode?: Mode;
  }) =>
    run('replaceMarkdown', async () => {
      const md = markdownToDocs(markdown);
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const { flat } = doc;
      const hit = findUnique(flat, find);
      const first = paragraphAt(flat, hit.start);
      const last = paragraphAt(flat, hit.end - 1);

      let edit: Edit;
      let scope: string;
      if (md.text && isInline(md) && first === last && hit.end < last.end) {
        edit = replaceInline(md, hit.start, hit.end, doc.tabId);
        scope = 'inline';
      } else {
        if (first.container !== last.container) {
          throw new Error(
            'The quoted text spans a table boundary; replace inside one cell, or around the table, at a time.',
          );
        }
        edit = replaceParagraphs(md, first, last, flat, doc.tabId);
        scope = `whole paragraph${first === last ? '' : 's'} containing the match`;
      }
      await this.apply(docs, doc, edit, mode);
      return summary(`Replaced (${scope})`, doc, edit, mode);
    });

  public comment = ({
    documentId,
    anchor,
    comment,
    tabId,
  }: {
    documentId: string;
    anchor: string;
    comment: string;
    tabId?: string;
  }) =>
    run('comment', async () => {
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const hit = findUnique(doc.flat, anchor);
      await docs.documents.batchUpdate({
        documentId: doc.id,
        requestBody: {
          requests: [
            {
              insertComment: {
                range: {
                  startIndex: hit.start,
                  endIndex: hit.end,
                  tabId: doc.tabId,
                },
                content: comment,
              },
            } as docs_v1.Schema$Request,
          ],
        },
      });
      return `Commented on ${JSON.stringify(anchor)} in "${doc.title}".`;
    });
}

function summary(verb: string, doc: Loaded, edit: Edit, mode: Mode): string {
  const how = mode === 'suggest' ? ' as suggestions' : '';
  return `${verb}${how} in "${doc.title}" (tab ${doc.tabId}), now at doc range [${edit.inserted.startIndex}, ${edit.inserted.endIndex}).`;
}

function flattenTabs(tabs: docs_v1.Schema$Tab[]): docs_v1.Schema$Tab[] {
  return tabs.flatMap((t) => [t, ...flattenTabs(t.childTabs ?? [])]);
}

async function run(name: string, fn: () => Promise<string>) {
  logToFile(`[DocsMarkdownService] ${name}`);
  try {
    return { content: [{ type: 'text' as const, text: await fn() }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logToFile(`[DocsMarkdownService] ${name} failed: ${message}`);
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: JSON.stringify({ error: message }) },
      ],
    };
  }
}

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
import {
  findSection,
  replaceSectionBody,
  replaceWholeSection,
  insertInSection,
  moveSection,
  elementsIn,
  copyLosses,
  commentsIn,
  MoveTarget,
} from './docsMarkdown/sections';
import { planReplaceAll } from './docsMarkdown/replaceAll';
import { docsToMarkdown } from './docsMarkdown/docsToMarkdown';
import {
  discussionOf,
  renderDiscussion,
  when,
  Discussion,
} from './docsMarkdown/discussion';
import {
  SnapshotStore,
  othersChanges,
  Snapshot,
} from './docsMarkdown/snapshots';

type Mode = 'edit' | 'suggest';

interface Loaded {
  id: string;
  tabId: string;
  revisionId: string;
  flat: FlatDoc;
  tab: docs_v1.Schema$Tab;
  title: string;
  discussion: Discussion;
  /** When this state was fetched. */
  time: string;
}

/**
 * Markdown-in, markdown-out editing for Google Docs. Callers point at places
 * by quoting document text; all index arithmetic happens here, against the
 * document structure, and each call is one atomic batchUpdate pinned to the
 * revision it read.
 */
export class DocsMarkdownService {
  constructor(
    private authManager: AuthManager,
    private snapshots: SnapshotStore = new SnapshotStore(),
  ) {}

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
    const time = new Date().toISOString();
    const res = await docs.documents.get({
      documentId: id,
      includeTabsContent: true,
      // Comments require the inline suggestions view.
      suggestionsViewMode: 'SUGGESTIONS_INLINE',
      // In the live API but not yet in the generated types.
      commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
    } as docs_v1.Params$Resource$Documents$Get);
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
      discussion: discussionOf(res.data),
      time,
    };
  }

  private snapshotOf(doc: Loaded, own = false): Snapshot {
    return {
      revisionId: doc.revisionId,
      time: doc.time,
      own,
      markdown: docsToMarkdown(
        doc.tab.documentTab?.body?.content,
        doc.tab.documentTab?.lists ?? undefined,
      ),
    };
  }

  /**
   * Keeps changesSince's history honest across a write: the state just before
   * it (others may have edited since the last snapshot) and the state it
   * produced, marked as ours. Only for docs that already have a history.
   */
  private async recordWrite(
    docs: docs_v1.Docs,
    before: Loaded,
    newRevision: string | undefined,
  ) {
    if (this.snapshots.history(before.id, before.tabId).length === 0) return;
    this.snapshots.record(before.id, before.tabId, this.snapshotOf(before));
    const after = await this.load(docs, before.id, before.tabId);
    // If someone else edited in the instant after our write, the fetched
    // revision isn't ours alone; leave it unmarked so their edit still shows.
    const own = !!newRevision && after.revisionId === newRevision;
    this.snapshots.record(after.id, after.tabId, this.snapshotOf(after, own));
  }

  private async apply(docs: docs_v1.Docs, doc: Loaded, edit: Edit, mode: Mode) {
    if (edit.requests.length === 0) return;
    const res = await docs.documents.batchUpdate({
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
    await this.recordWrite(
      docs,
      doc,
      res.data.writeControl?.requiredRevisionId ?? undefined,
    );
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
      const snap = this.snapshotOf(doc);
      this.snapshots.record(doc.id, doc.tabId, snap);
      return `<!-- ${header(doc)} -->\n${snap.markdown}`;
    });

  public listComments = ({
    documentId,
    includeResolved = false,
  }: {
    documentId: string;
    includeResolved?: boolean;
  }) =>
    run('listComments', async () => {
      const docs = await this.client();
      const doc = await this.load(docs, documentId);
      return `# Discussion in "${doc.title}"\n\n${renderDiscussion(doc.discussion, { includeResolved })}`;
    });

  public replyToComment = ({
    documentId,
    commentId,
    reply,
    action,
  }: {
    documentId: string;
    commentId: string;
    reply?: string;
    action?: 'resolve' | 'reopen';
  }) =>
    run('replyToComment', async () => {
      if (!reply && !action) {
        throw new Error(
          'Give a reply, an action ("resolve" | "reopen"), or both.',
        );
      }
      const docs = await this.client();
      const id = extractDocId(documentId) || documentId;
      await docs.documents.batchUpdate({
        documentId: id,
        requestBody: {
          requests: [
            {
              addCommentReply: {
                commentId,
                post: {
                  ...(reply ? { content: reply } : {}),
                  ...(action ? { commentAction: action.toUpperCase() } : {}),
                },
              },
            } as docs_v1.Schema$Request,
          ],
        },
      });
      const did = [reply && 'Replied', action && `${action}d the thread`]
        .filter(Boolean)
        .join(' and ');
      return `${did} (${commentId}).`;
    });

  public changesSince = ({
    documentId,
    revisionId,
    tabId,
  }: {
    documentId: string;
    revisionId?: string;
    tabId?: string;
  }) =>
    run('changesSince', async () => {
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const history = this.snapshots.history(doc.id, doc.tabId);
      if (history.length === 0) {
        throw new Error(
          'No earlier snapshot of this doc tab. Call docs.readMarkdown first; changesSince then reports what others changed after that.',
        );
      }
      let i = history.length - 1;
      if (revisionId) {
        i = history.findIndex((h) => h.revisionId === revisionId);
        if (i < 0) {
          throw new Error(
            `No snapshot at revision ${revisionId}. Known: ${history.map((h) => `${h.revisionId} (${when(h.time)})`).join(', ')}`,
          );
        }
      }
      const base = history[i];
      const now = this.snapshotOf(doc);
      const steps = othersChanges(history, i, now);
      this.snapshots.record(doc.id, doc.tabId, now);

      const out = [
        `# Changes in "${doc.title}" (tab ${doc.tabId}) since ${when(base.time)}`,
        `Revision ${base.revisionId} → ${doc.revisionId}. Edits made through this server are left out.`,
        '',
        '## Text',
      ];
      if (steps.length === 0) out.push('No text changes by others.');
      for (const s of steps) {
        out.push(
          `Between ${when(s.from.time)} and ${when(s.to.time)}:`,
          '```diff',
          s.patch,
          '```',
        );
      }
      out.push(
        '',
        renderDiscussion(doc.discussion, {
          since: base.time,
          othersOnly: true,
        }),
        '',
        "Direct typing isn't attributed by the Docs API; suggestions and comments are.",
      );
      return out.join('\n');
    });

  public insertMarkdown = ({
    documentId,
    markdown,
    at,
    after,
    before,
    section,
    tabId,
    mode = 'edit',
  }: {
    documentId: string;
    markdown: string;
    at?: 'beginning' | 'end';
    after?: string;
    before?: string;
    section?: string;
    tabId?: string;
    mode?: Mode;
  }) =>
    run('insertMarkdown', async () => {
      if (section !== undefined) {
        if (!at || after !== undefined || before !== undefined) {
          throw new Error(
            'With section, give `at` ("beginning" = right under the heading, "end" = after the section\'s last paragraph) and not after/before.',
          );
        }
      } else {
        const targets = [at, after, before].filter((x) => x !== undefined);
        if (targets.length !== 1) {
          throw new Error(
            'Give exactly one of: at ("beginning" | "end"), after (quoted text), before (quoted text).',
          );
        }
      }
      const md = markdownToDocs(markdown);
      if (!md.text) throw new Error('Markdown is empty.');
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const { flat } = doc;
      const body = flat.paragraphs.filter((p) => p.container === 'body');

      let edit: Edit;
      if (section !== undefined) {
        edit = insertInSection(
          md,
          findSection(flat, section),
          at!,
          flat,
          doc.tabId,
        );
      } else if (at === 'beginning') {
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
    section,
    scope = 'body',
    markdown,
    tabId,
    mode = 'edit',
  }: {
    documentId: string;
    find?: string;
    section?: string;
    scope?: 'body' | 'whole';
    markdown: string;
    tabId?: string;
    mode?: Mode;
  }) =>
    run('replaceMarkdown', async () => {
      const md = markdownToDocs(markdown);
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const { flat } = doc;
      if ((find === undefined) === (section === undefined)) {
        throw new Error(
          'Give exactly one of: find (quoted text), section (heading).',
        );
      }
      if (section !== undefined) {
        const sec = findSection(flat, section);
        const edit =
          scope === 'whole'
            ? replaceWholeSection(md, sec, flat, doc.tabId)
            : replaceSectionBody(md, sec, flat, doc.tabId);
        await this.apply(docs, doc, edit, mode);
        const what =
          scope === 'whole' ? 'section incl. heading' : 'section body';
        return summary(
          md.text
            ? `Replaced (${what} of "${sec.title}")`
            : `Deleted (${what} of "${sec.title}")`,
          doc,
          edit,
          mode,
        );
      }
      const hit = findUnique(flat, find!);
      const first = paragraphAt(flat, hit.start);
      const last = paragraphAt(flat, hit.end - 1);

      let edit: Edit;
      let where: string;
      if (md.text && isInline(md) && first === last && hit.end < last.end) {
        edit = replaceInline(md, hit.start, hit.end, doc.tabId);
        where = 'inline';
      } else {
        if (first.container !== last.container) {
          throw new Error(
            'The quoted text spans a table boundary; replace inside one cell, or around the table, at a time.',
          );
        }
        edit = replaceParagraphs(md, first, last, flat, doc.tabId);
        where = `whole paragraph${first === last ? '' : 's'} containing the match`;
      }
      await this.apply(docs, doc, edit, mode);
      return summary(`Replaced (${where})`, doc, edit, mode);
    });

  public moveSection = ({
    documentId,
    section,
    before,
    after,
    at,
    allowLoss = false,
    tabId,
    mode = 'edit',
  }: {
    documentId: string;
    section: string;
    before?: string;
    after?: string;
    at?: 'beginning' | 'end';
    allowLoss?: boolean;
    tabId?: string;
    mode?: Mode;
  }) =>
    run('moveSection', async () => {
      const dests = [before, after, at].filter((x) => x !== undefined);
      if (dests.length !== 1) {
        throw new Error(
          'Give exactly one destination: before (section heading), after (section heading; lands after that whole section), or at ("beginning" | "end").',
        );
      }
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const { flat } = doc;
      const src = findSection(flat, section);
      let target: MoveTarget;
      if (before !== undefined) {
        target = { before: findSection(flat, before) };
        if (target.before.start >= src.start && target.before.start < src.end) {
          throw new Error(
            'The destination section is inside the section being moved.',
          );
        }
      } else if (after !== undefined) {
        target = { after: findSection(flat, after) };
        if (target.after.start >= src.start && target.after.start < src.end) {
          throw new Error(
            'The destination section is inside the section being moved.',
          );
        }
      } else {
        target = { at: at! };
      }
      const content = elementsIn(
        doc.tab.documentTab?.body?.content,
        src.start,
        src.end,
      );
      const md = markdownToDocs(
        docsToMarkdown(content, doc.tab.documentTab?.lists ?? undefined),
      );
      const losses = copyLosses(flat, src, content, md);
      if (losses.length && !allowLoss) {
        throw new Error(
          `Not moving "${src.title}": ${losses.join('; ')}. Nothing was changed. Pass allowLoss: true to move anyway.`,
        );
      }
      const edit = moveSection(md, src, target, flat, doc.tabId);
      const anchored = commentsIn(
        src,
        doc.discussion.comments
          .filter((c) => c.status !== 'RESOLVED')
          .map((c) => c.plainTextQuote ?? ''),
      );
      await this.apply(docs, doc, edit, mode);
      const how = mode === 'suggest' ? ' as suggestions' : '';
      const notes = [
        'Rebuilt from markdown: headings, lists, tables, bold/italic/strikethrough/code and links are kept; colors, fonts, alignment, images and named ranges are not.',
      ];
      if (anchored.length) {
        notes.push(
          `${anchored.length} open comment thread${anchored.length === 1 ? ' is' : 's are'} anchored in the moved text and will lose ${anchored.length === 1 ? 'its' : 'their'} anchor.`,
        );
      }
      if (losses.length) notes.push(`Moved despite: ${losses.join('; ')}.`);
      return `Moved section "${src.title}"${how} in "${doc.title}" (tab ${doc.tabId}).\n${notes.join('\n')}`;
    });

  public replaceAll = ({
    documentId,
    find,
    replacement,
    expectedCount,
    matchCase = true,
    section,
    tabId,
    mode = 'edit',
  }: {
    documentId: string;
    find: string;
    replacement: string;
    expectedCount?: number;
    matchCase?: boolean;
    section?: string;
    tabId?: string;
    mode?: Mode;
  }) =>
    run('replaceAll', async () => {
      const docs = await this.client();
      const doc = await this.load(docs, documentId, tabId);
      const within = section
        ? (() => {
            const s = findSection(doc.flat, section);
            return { start: s.start, end: s.end };
          })()
        : undefined;
      const plan = planReplaceAll(doc.flat, find, replacement, {
        matchCase,
        within,
        tabId: doc.tabId,
      });
      if (expectedCount !== undefined && plan.count !== expectedCount) {
        throw new Error(
          `Found ${plan.count} occurrence${plan.count === 1 ? '' : 's'} of ${JSON.stringify(find)}, but expectedCount is ${expectedCount}. Nothing was changed.`,
        );
      }
      if (plan.count === 0) {
        return `No occurrences of ${JSON.stringify(find)} in "${doc.title}"; nothing changed.`;
      }
      await this.apply(
        docs,
        doc,
        { requests: plan.requests, inserted: { startIndex: 0, endIndex: 0 } },
        mode,
      );
      const how = mode === 'suggest' ? ' as suggestions' : '';
      return `Replaced ${plan.count} occurrence${plan.count === 1 ? '' : 's'} of ${JSON.stringify(find)}${how} in "${doc.title}" (tab ${doc.tabId}).`;
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

function header(doc: Loaded): string {
  const open = doc.discussion.comments.filter((c) => c.status !== 'RESOLVED');
  const pending = doc.discussion.suggestions.filter(
    (c) => c.status !== 'RESOLVED',
  );
  const talk =
    open.length || pending.length
      ? ` | ${open.length} open comment${open.length === 1 ? '' : 's'}, ${pending.length} pending suggestion${pending.length === 1 ? '' : 's'} (docs.listComments)`
      : '';
  return `${doc.title} | tab ${doc.tabId} | revision ${doc.revisionId}${talk}`;
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

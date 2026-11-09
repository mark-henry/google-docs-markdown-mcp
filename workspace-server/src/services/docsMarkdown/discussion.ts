/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';

// Comment and suggestion threads are in the live Docs API (comments GA
// 2026-09-30) but not yet in the generated googleapis types.
export interface PostAuthor {
  displayName?: string;
  anonymous?: boolean;
  me?: boolean;
}

export interface Post {
  postId?: string;
  content?: string;
  author?: PostAuthor;
  createTime?: string;
  updateTime?: string;
  deleted?: boolean;
  commentAction?: string;
  suggestionAction?: string;
}

export interface CommentThread {
  commentId?: string;
  status?: string;
  plainTextQuote?: string;
  headPost?: Post;
  replies?: Post[];
}

export interface SuggestionThread {
  suggestionId?: string;
  status?: string;
  summaryText?: string;
  headPost?: Post;
  replies?: Post[];
}

export interface Discussion {
  comments: CommentThread[];
  suggestions: SuggestionThread[];
}

export function discussionOf(doc: docs_v1.Schema$Document): Discussion {
  const d = doc as unknown as {
    comments?: CommentThread[];
    suggestions?: SuggestionThread[];
  };
  return { comments: d.comments ?? [], suggestions: d.suggestions ?? [] };
}

export function who(author: PostAuthor | undefined): string {
  if (!author || author.anonymous) return 'Anonymous';
  const name = author.displayName || 'Unknown';
  return author.me ? `${name} (you)` : name;
}

/** "2026-11-09T19:03:52.803Z" → "2026-11-09 19:03 UTC" */
export function when(iso: string | undefined): string {
  if (!iso) return '?';
  return iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
}

function postLine(p: Post): string {
  const action =
    p.commentAction === 'RESOLVE'
      ? ' [resolved the thread]'
      : p.commentAction === 'REOPEN'
        ? ' [reopened the thread]'
        : p.suggestionAction === 'ACCEPT'
          ? ' [accepted]'
          : p.suggestionAction === 'REJECT'
            ? ' [rejected]'
            : '';
  const text = p.deleted ? '(deleted)' : (p.content ?? '').trim();
  return `${who(p.author)} · ${when(p.createTime)}${action}${text ? `: ${oneLine(text)}` : ''}`;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ');
}

/** Latest activity time in a thread (head post or any reply). */
export function lastActivity(t: CommentThread | SuggestionThread): string {
  return [t.headPost, ...(t.replies ?? [])]
    .map((p) => p?.createTime ?? '')
    .reduce((a, b) => (b > a ? b : a), '');
}

/**
 * Renders threads as compact markdown an agent can act on: thread IDs for
 * replying, who said what and when, and the quoted text each comment is on.
 * With `since`, only posts created after it are shown; with `othersOnly`,
 * posts by the signed-in user are left out.
 */
export function renderDiscussion(
  d: Discussion,
  opts: {
    includeResolved?: boolean;
    since?: string;
    othersOnly?: boolean;
  } = {},
): string {
  const { includeResolved = false, since, othersOnly = false } = opts;
  const fresh = (p: Post | undefined) =>
    !!p &&
    (!since || (p.createTime ?? '') > since) &&
    !(othersOnly && p.author?.me);
  const out: string[] = [];

  const comments = d.comments.filter(
    (t) =>
      (includeResolved || since || t.status !== 'RESOLVED') &&
      (!since || [t.headPost, ...(t.replies ?? [])].some(fresh)),
  );
  const open = d.comments.filter((t) => t.status !== 'RESOLVED').length;
  const resolved = d.comments.length - open;
  out.push(
    `## Comments (${open} open${resolved ? `, ${resolved} resolved${includeResolved || since ? '' : ' hidden'}` : ''})`,
  );
  if (comments.length === 0)
    out.push(since ? 'No new comment activity.' : 'None.');
  for (const t of comments) {
    out.push(
      `- **${t.commentId}** · ${t.status ?? '?'} · on "${oneLine(t.plainTextQuote ?? '')}"`,
    );
    for (const p of [t.headPost, ...(t.replies ?? [])]) {
      if (p && (!since || fresh(p))) out.push(`  - ${postLine(p)}`);
    }
  }

  const suggestions = d.suggestions.filter(
    (s) =>
      (includeResolved || since || s.status !== 'RESOLVED') &&
      (!since || [s.headPost, ...(s.replies ?? [])].some(fresh)),
  );
  out.push(
    '',
    `## Pending suggestions (${d.suggestions.filter((s) => s.status !== 'RESOLVED').length})`,
  );
  if (suggestions.length === 0)
    out.push(since ? 'No new suggestions.' : 'None.');
  for (const s of suggestions) {
    out.push(
      `- **${s.suggestionId}** · ${who(s.headPost?.author)} · ${when(s.headPost?.createTime)} · ${oneLine(s.summaryText ?? '')}`,
    );
    for (const p of s.replies ?? []) {
      if (!since || fresh(p)) out.push(`  - ${postLine(p)}`);
    }
  }
  return out.join('\n');
}

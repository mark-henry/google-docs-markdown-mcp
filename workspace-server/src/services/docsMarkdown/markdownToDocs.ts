/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { marked, Token, Tokens } from 'marked';

/**
 * Markdown converted to the plain text a Google Doc stores, plus the styling
 * to apply on top of it. All offsets are UTF-16 code units into `text`, which
 * is how the Docs API counts indices.
 */
export interface MdParagraph {
  /** Offset of the paragraph's first character. */
  start: number;
  /** Offset just past the paragraph's trailing '\n'. */
  end: number;
  namedStyleType: string;
  bullet?: { ordered: boolean; level: number; task?: boolean };
  /** Code-block line: whole paragraph rendered in a monospace font. */
  code?: boolean;
  /** Blockquote nesting depth (rendered as indentation). */
  quote?: number;
  /**
   * Index into MdDoc.tables: this empty paragraph is a placeholder where
   * that table goes.
   */
  table?: number;
  /** Empty paragraph drawn as a horizontal rule (a bottom border). */
  hr?: boolean;
  /** Empty placeholder paragraph where a page break goes. */
  pageBreak?: boolean;
}

export interface MdRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  baseline?: 'SUPERSCRIPT' | 'SUBSCRIPT';
  code?: boolean;
  link?: string;
}

/** Inline content of one table cell; offsets are into `text`. */
export interface MdCell {
  text: string;
  runs: MdRun[];
}

export interface MdTable {
  /** rows[0] is the header row. Every row has `columns` cells. */
  rows: MdCell[][];
  columns: number;
}

export interface MdDoc {
  /** Every paragraph ends with '\n', so `text` does too (unless empty). */
  text: string;
  paragraphs: MdParagraph[];
  runs: MdRun[];
  tables: MdTable[];
}

type InlineStyle = Omit<MdRun, 'start' | 'end'>;

const HEADINGS = [
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
];

/** The markdown spellings of a page break: an invisible HTML comment, or pandoc's div. */
const PAGE_BREAK =
  /^(<!--\s*page-?break\s*-->|<div\s+style=["']\s*page-break-(?:after|before):\s*always;?\s*["']\s*>\s*<\/div>)$/i;

export class UnsupportedMarkdownError extends Error {}

export function markdownToDocs(markdown: string): MdDoc {
  const out: MdDoc = { text: '', paragraphs: [], runs: [], tables: [] };
  // Inline content goes to the doc, or to a table cell while one is built.
  let cur: { text: string; runs: MdRun[] } = out;

  const pushInline = (tokens: Token[] | undefined, outer: InlineStyle) => {
    let style = outer;
    // Open <u>/<sup>/<sub> tags, innermost last; each needs a matching close
    // tag later in this same token list, else it stays literal text.
    const open: { tag: string; before: InlineStyle }[] = [];
    const list = tokens ?? [];
    for (let i = 0; i < list.length; i++) {
      const tok = list[i];
      if (tok.type === 'html') {
        const m = /^<(\/?)(u|sup|sub)>$/i.exec(tok.raw.trim());
        if (m) {
          const tag = m[2].toLowerCase();
          if (!m[1]) {
            const closes = list
              .slice(i + 1)
              .some(
                (t) =>
                  t.type === 'html' &&
                  t.raw.trim().toLowerCase() === `</${tag}>`,
              );
            if (closes) {
              open.push({ tag, before: style });
              style =
                tag === 'u'
                  ? { ...style, underline: true }
                  : {
                      ...style,
                      baseline: tag === 'sup' ? 'SUPERSCRIPT' : 'SUBSCRIPT',
                    };
              continue;
            }
          } else {
            const at = open.map((o) => o.tag).lastIndexOf(tag);
            if (at >= 0) {
              style = open[at].before;
              open.length = at;
              continue;
            }
          }
        }
      }
      switch (tok.type) {
        case 'text': {
          const t = tok as Tokens.Text;
          if (t.tokens && t.tokens.length > 0) {
            pushInline(t.tokens, style);
          } else {
            pushText(decodeEntities(t.text), style);
          }
          break;
        }
        case 'escape':
          pushText((tok as Tokens.Escape).text, style);
          break;
        case 'strong':
          pushInline((tok as Tokens.Strong).tokens, { ...style, bold: true });
          break;
        case 'em':
          pushInline((tok as Tokens.Em).tokens, { ...style, italic: true });
          break;
        case 'del':
          pushInline((tok as Tokens.Del).tokens, {
            ...style,
            strikethrough: true,
          });
          break;
        case 'codespan':
          pushText(decodeEntities((tok as Tokens.Codespan).text), {
            ...style,
            code: true,
          });
          break;
        case 'link': {
          const l = tok as Tokens.Link;
          pushInline(l.tokens, { ...style, link: l.href });
          break;
        }
        case 'html':
          // Docs has no HTML; an agent writing <x> means the literal text.
          pushText(tok.raw, style);
          break;
        case 'checkbox':
          // The `[ ]` / `[x]` of a task item; the item carries the state.
          break;
        case 'br':
          // A soft line break inside a paragraph: Docs uses vertical tab.
          pushText('\u000b', style);
          break;
        default:
          throw new UnsupportedMarkdownError(
            `Unsupported inline markdown (${tok.type}): ${JSON.stringify(tok.raw)}`,
          );
      }
    }
  };

  const pushText = (text: string, style: InlineStyle) => {
    if (!text) return;
    const start = cur.text.length;
    cur.text += text;
    if (Object.keys(style).length > 0) {
      cur.runs.push({ start, end: cur.text.length, ...style });
    }
  };

  const endParagraph = (
    start: number,
    props: Omit<MdParagraph, 'start' | 'end'>,
  ) => {
    out.text += '\n';
    out.paragraphs.push({ start, end: out.text.length, ...props });
  };

  const pushBlocks = (
    tokens: Token[],
    ctx: { quote: number; listLevel: number },
  ) => {
    for (const tok of tokens) {
      const base = ctx.quote > 0 ? { quote: ctx.quote } : {};
      switch (tok.type) {
        case 'space':
          break;
        case 'heading': {
          const h = tok as Tokens.Heading;
          const start = out.text.length;
          pushInline(h.tokens, {});
          endParagraph(start, {
            namedStyleType: HEADINGS[Math.min(h.depth, 6) - 1],
            ...base,
          });
          break;
        }
        case 'paragraph':
        case 'text': {
          const p = tok as Tokens.Paragraph;
          const start = out.text.length;
          pushInline(p.tokens, {});
          endParagraph(start, { namedStyleType: 'NORMAL_TEXT', ...base });
          break;
        }
        case 'code': {
          const c = tok as Tokens.Code;
          for (const line of c.text.split('\n')) {
            const start = out.text.length;
            pushText(line, {});
            endParagraph(start, {
              namedStyleType: 'NORMAL_TEXT',
              code: true,
              ...base,
            });
          }
          break;
        }
        case 'hr':
          endParagraph(out.text.length, {
            namedStyleType: 'NORMAL_TEXT',
            hr: true,
            ...base,
          });
          break;
        case 'html': {
          if (PAGE_BREAK.test(tok.raw.trim())) {
            endParagraph(out.text.length, {
              namedStyleType: 'NORMAL_TEXT',
              pageBreak: true,
            });
            break;
          }
          const start = out.text.length;
          pushText(tok.raw.replace(/\n+$/, ''), {});
          endParagraph(start, { namedStyleType: 'NORMAL_TEXT', ...base });
          break;
        }
        case 'blockquote':
          pushBlocks((tok as Tokens.Blockquote).tokens, {
            ...ctx,
            quote: ctx.quote + 1,
          });
          break;
        case 'table': {
          const t = tok as Tokens.Table;
          const cell = (c: Tokens.TableCell, header: boolean): MdCell => {
            const built: MdCell = { text: '', runs: [] };
            cur = built;
            pushInline(c.tokens, header ? { bold: true } : {});
            cur = out;
            return built;
          };
          const rows = [
            t.header.map((c) => cell(c, true)),
            ...t.rows.map((r) => r.map((c) => cell(c, false))),
          ];
          const columns = Math.max(...rows.map((r) => r.length));
          for (const r of rows) {
            while (r.length < columns) r.push({ text: '', runs: [] });
          }
          out.tables.push({ rows, columns });
          endParagraph(out.text.length, {
            namedStyleType: 'NORMAL_TEXT',
            table: out.tables.length - 1,
          });
          break;
        }
        case 'list': {
          const list = tok as Tokens.List;
          for (const item of list.items) {
            pushListItem(item, list.ordered, ctx);
          }
          break;
        }
        default:
          throw new UnsupportedMarkdownError(
            `Unsupported markdown block (${tok.type}). Supported: headings, paragraphs, bulleted/numbered lists, tables, code blocks, blockquotes, and inline bold/italic/strikethrough/code/links.`,
          );
      }
    }
  };

  const pushListItem = (
    item: Tokens.ListItem,
    ordered: boolean,
    ctx: { quote: number; listLevel: number },
  ) => {
    // A list item is one Docs paragraph: further paragraphs and code blocks
    // inside it are joined to it with line breaks (vertical tab), which keeps
    // them under the same bullet and keeps numbering continuous.
    let start = -1;
    let nestedSeen = false;
    const inItem = () => start >= 0;
    const open = () => {
      start = out.text.length;
      // createParagraphBullets reads nesting from leading tabs (and removes
      // them), so nested items start with one tab per level.
      out.text += '\t'.repeat(ctx.listLevel);
    };
    const close = () => {
      endParagraph(start, {
        namedStyleType: 'NORMAL_TEXT',
        bullet: {
          ordered,
          level: ctx.listLevel,
          ...(item.task ? { task: true } : {}),
        },
        ...(ctx.quote > 0 ? { quote: ctx.quote } : {}),
      });
      start = -1;
    };
    for (const child of item.tokens) {
      if (child.type === 'space' || child.type === 'checkbox') continue;
      if (child.type === 'list') {
        if (inItem()) close();
        nestedSeen = true;
        const nested = child as Tokens.List;
        for (const sub of nested.items) {
          pushListItem(sub, nested.ordered, {
            ...ctx,
            listLevel: ctx.listLevel + 1,
          });
        }
        continue;
      }
      if (
        child.type !== 'text' &&
        child.type !== 'paragraph' &&
        child.type !== 'code'
      ) {
        throw new UnsupportedMarkdownError(
          `Unsupported content inside a list item (${child.type}).`,
        );
      }
      if (nestedSeen) {
        throw new UnsupportedMarkdownError(
          "A list item can't continue with more text after a nested list; put the text before the nested list.",
        );
      }
      if (!inItem()) open();
      else pushText('\u000b', {});
      if (child.type === 'code') {
        const lines = (child as Tokens.Code).text.split('\n');
        lines.forEach((line, i) => {
          if (i > 0) pushText('\u000b', {});
          pushText(line, { code: true });
        });
      } else {
        pushInline((child as Tokens.Text).tokens, {});
      }
    }
    if (inItem()) close();
  };

  pushBlocks(marked.lexer(markdown, { gfm: true }), { quote: 0, listLevel: 0 });
  return out;
}

/**
 * True when the markdown is a single plain paragraph, so it can replace text
 * inside an existing paragraph without changing paragraph structure.
 */
export function isInline(doc: MdDoc): boolean {
  return (
    doc.paragraphs.length === 1 &&
    doc.paragraphs[0].namedStyleType === 'NORMAL_TEXT' &&
    !doc.paragraphs[0].bullet &&
    !doc.paragraphs[0].code &&
    !doc.paragraphs[0].quote &&
    doc.paragraphs[0].table === undefined &&
    !doc.paragraphs[0].hr &&
    !doc.paragraphs[0].pageBreak
  );
}

/** The plain text the markdown would produce, without the final newline. */
export function markdownToPlain(markdown: string): string {
  const md = markdownToDocs(markdown);
  // A table reads, in document order, as each cell's text plus its newline.
  let text = '';
  for (const p of md.paragraphs) {
    text +=
      p.table === undefined
        ? md.text.slice(p.start, p.end)
        : md.tables[p.table].rows
            .flat()
            .map((c) => c.text + '\n')
            .join('');
  }
  return text.replace(/\n$/, '').replace(/\t/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

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
  bullet?: { ordered: boolean; level: number };
  /** Code-block line: whole paragraph rendered in a monospace font. */
  code?: boolean;
  /** Blockquote nesting depth (rendered as indentation). */
  quote?: number;
  /**
   * Index into MdDoc.tables: this empty paragraph is a placeholder where
   * that table goes.
   */
  table?: number;
}

export interface MdRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
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

/** A footnote reference to create at `offset` in the body text. */
export interface MdFootnote {
  /** Offset in MdDoc.text where the reference goes (it has no text of its own). */
  offset: number;
  /** The footnote's own inline content. */
  text: string;
  runs: MdRun[];
}

export interface MdDoc {
  /** Every paragraph ends with '\n', so `text` does too (unless empty). */
  text: string;
  paragraphs: MdParagraph[];
  runs: MdRun[];
  tables: MdTable[];
  footnotes: MdFootnote[];
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

const READ_ONLY_MARKER =
  /^<!--\s*(table of contents|page break|column break|horizontal rule|end (header|footer))\b[^>]*-->$/i;

export class UnsupportedMarkdownError extends Error {}

const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/g;

/** Splits `[^label]: text` definitions (indented lines continue) from the rest. */
function extractFootnoteDefs(markdown: string): {
  rest: string;
  defs: Map<string, string>;
} {
  const defs = new Map<string, string>();
  const rest: string[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) {
      rest.push(lines[i]);
      continue;
    }
    const parts = [m[2]];
    while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) {
      parts.push(lines[++i].trim());
    }
    defs.set(m[1], parts.join(' ').trim());
  }
  return { rest: rest.join('\n'), defs };
}

export function markdownToDocs(markdown: string): MdDoc {
  const { rest, defs } = extractFootnoteDefs(markdown);
  const usedDefs = new Set<string>();
  const out: MdDoc = {
    text: '',
    paragraphs: [],
    runs: [],
    tables: [],
    footnotes: [],
  };
  // Inline content goes to the doc, or to a table cell while one is built.
  let cur: { text: string; runs: MdRun[] } = out;

  const pushInline = (tokens: Token[] | undefined, style: InlineStyle) => {
    for (const tok of tokens ?? []) {
      switch (tok.type) {
        case 'text': {
          const t = tok as Tokens.Text;
          if (t.tokens && t.tokens.length > 0) {
            pushInline(t.tokens, style);
          } else {
            pushTextWithRefs(decodeEntities(t.text), style);
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

  const pushTextWithRefs = (text: string, style: InlineStyle) => {
    let last = 0;
    for (const m of text.matchAll(FOOTNOTE_REF)) {
      pushText(text.slice(last, m.index), style);
      last = m.index! + m[0].length;
      const def = defs.get(m[1]);
      if (def === undefined) {
        throw new UnsupportedMarkdownError(
          `Footnote reference ${m[0]} has no definition; add a line "${m[0]}: footnote text". (To write the characters literally, escape the bracket.)`,
        );
      }
      if (cur !== out) {
        throw new UnsupportedMarkdownError(
          'Footnotes inside table cells are not supported by Google Docs.',
        );
      }
      usedDefs.add(m[1]);
      const note = markdownToDocs(def);
      if (!isInline(note) && note.text !== '') {
        throw new UnsupportedMarkdownError(
          `Footnote ${m[0]} must be a single paragraph of inline markdown.`,
        );
      }
      out.footnotes.push({
        offset: out.text.length,
        text: note.text.replace(/\n$/, ''),
        runs: note.runs,
      });
    }
    pushText(text.slice(last), style);
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
        case 'html': {
          // Read-only markers from readMarkdown carry no content to write.
          if (READ_ONLY_MARKER.test(tok.raw.trim())) break;
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
    let first = true;
    for (const child of item.tokens) {
      if (child.type === 'list') {
        const nested = child as Tokens.List;
        for (const sub of nested.items) {
          pushListItem(sub, nested.ordered, {
            ...ctx,
            listLevel: ctx.listLevel + 1,
          });
        }
        continue;
      }
      if (child.type === 'space') continue;
      if (child.type !== 'text' && child.type !== 'paragraph') {
        throw new UnsupportedMarkdownError(
          `Unsupported content inside a list item (${child.type}).`,
        );
      }
      if (!first) {
        throw new UnsupportedMarkdownError(
          'List items with more than one paragraph are not supported.',
        );
      }
      first = false;
      const start = out.text.length;
      // createParagraphBullets reads nesting from leading tabs (and removes
      // them), so nested items start with one tab per level.
      out.text += '\t'.repeat(ctx.listLevel);
      pushInline((child as Tokens.Text).tokens, {});
      endParagraph(start, {
        namedStyleType: 'NORMAL_TEXT',
        bullet: { ordered, level: ctx.listLevel },
        ...(ctx.quote > 0 ? { quote: ctx.quote } : {}),
      });
    }
  };

  pushBlocks(marked.lexer(rest, { gfm: true }), { quote: 0, listLevel: 0 });
  for (const label of defs.keys()) {
    if (!usedDefs.has(label)) {
      throw new UnsupportedMarkdownError(
        `Footnote definition [^${label}] has no reference [^${label}] in the text.`,
      );
    }
  }
  if (out.footnotes.length > 0 && out.tables.length > 0) {
    throw new UnsupportedMarkdownError(
      'Footnotes and tables in the same markdown are not supported; write them in separate calls.',
    );
  }
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
    doc.paragraphs[0].table === undefined
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

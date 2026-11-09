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

export interface MdDoc {
  /** Every paragraph ends with '\n', so `text` does too (unless empty). */
  text: string;
  paragraphs: MdParagraph[];
  runs: MdRun[];
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

export class UnsupportedMarkdownError extends Error {}

export function markdownToDocs(markdown: string): MdDoc {
  const out: MdDoc = { text: '', paragraphs: [], runs: [] };

  const pushInline = (tokens: Token[] | undefined, style: InlineStyle) => {
    for (const tok of tokens ?? []) {
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
    const start = out.text.length;
    out.text += text;
    if (Object.keys(style).length > 0) {
      out.runs.push({ start, end: out.text.length, ...style });
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
        case 'list': {
          const list = tok as Tokens.List;
          for (const item of list.items) {
            pushListItem(item, list.ordered, ctx);
          }
          break;
        }
        default:
          throw new UnsupportedMarkdownError(
            `Unsupported markdown block (${tok.type}). Supported: headings, paragraphs, bulleted/numbered lists, code blocks, blockquotes, and inline bold/italic/strikethrough/code/links.`,
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
    !doc.paragraphs[0].quote
  );
}

/** The plain text the markdown would produce, without the final newline. */
export function markdownToPlain(markdown: string): string {
  return markdownToDocs(markdown).text.replace(/\n$/, '').replace(/\t/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

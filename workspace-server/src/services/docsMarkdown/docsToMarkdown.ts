/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';

/**
 * Renders a document tab as markdown in the same dialect markdownToDocs
 * accepts, without escaping, so text quoted from it works as an anchor.
 */
export function docsToMarkdown(
  content: docs_v1.Schema$StructuralElement[] | undefined,
  lists: Record<string, docs_v1.Schema$List> | undefined,
  extras: MarkdownExtras = {},
): string {
  const blocks: string[] = [];
  const refs: { id: string; label: string }[] = [];
  const ctx: InlineContext = { footnoteIds: refs };
  let prevWasListItem = false;

  for (const el of content ?? []) {
    if (el.paragraph) {
      const p = el.paragraph;
      const line = renderInline(p.elements, ctx).replace(/\n$/, '');
      const style = p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';

      if (p.bullet) {
        const level = p.bullet.nestingLevel ?? 0;
        const glyph =
          lists?.[p.bullet.listId ?? '']?.listProperties?.nestingLevels?.[level]
            ?.glyphType;
        const ordered = !!glyph && glyph !== 'GLYPH_TYPE_UNSPECIFIED';
        const item = `${'  '.repeat(level)}${ordered ? '1.' : '-'} ${line}`;
        if (prevWasListItem) {
          blocks[blocks.length - 1] += '\n' + item;
        } else {
          blocks.push(item);
        }
        prevWasListItem = true;
        continue;
      }
      prevWasListItem = false;

      if (!line.trim()) continue;
      const heading = /^HEADING_(\d)$/.exec(style);
      if (heading) {
        blocks.push(`${'#'.repeat(Number(heading[1]))} ${line}`);
      } else if (style === 'TITLE') {
        blocks.push(`# ${line}`);
      } else if (style === 'SUBTITLE') {
        blocks.push(`## ${line}`);
      } else {
        blocks.push(line);
      }
    } else if (el.table) {
      prevWasListItem = false;
      blocks.push(renderTable(el.table, lists));
    } else if (el.tableOfContents) {
      prevWasListItem = false;
      blocks.push(TOC_MARKER);
    } else {
      prevWasListItem = false;
    }
  }
  // Definitions for the footnote references met above, by displayed number.
  for (const id of refs) {
    const fn = extras.footnotes?.[id.id];
    const text = fn
      ? docsToMarkdown(fn.content, lists)
          .trim()
          .replace(/^\s+/, '')
          .replace(/\n\n+/g, '\n    ')
      : '';
    blocks.push(`[^${id.label}]: ${text}`);
  }
  return blocks.join('\n\n') + '\n';
}

/** Parts of a tab outside its body content that the body refers to. */
export interface MarkdownExtras {
  footnotes?: Record<string, docs_v1.Schema$Footnote>;
}

export const TOC_MARKER =
  '<!-- table of contents (read-only: Docs generates it; the API cannot create or edit it) -->';

interface InlineContext {
  footnoteIds: { id: string; label: string }[];
}

const UNIT_KEYS = new Set([
  'startIndex',
  'endIndex',
  'textRun',
  'person',
  'richLink',
  'dateElement',
  'footnoteReference',
  'autoText',
  'pageBreak',
  'columnBreak',
  'horizontalRule',
  'equation',
  'inlineObjectElement',
]);

export type Segments = Record<string, docs_v1.Schema$Header>;

/**
 * Headers and footers as separately labeled blocks to follow the body. Each
 * is labeled with its role in the document style when that is known.
 */
export function renderHeadersFooters(
  kind: 'header' | 'footer',
  segments: Segments | undefined,
  roles: Record<string, string>,
  lists: Record<string, docs_v1.Schema$List> | undefined,
): string {
  const out: string[] = [];
  for (const [id, seg] of Object.entries(segments ?? {})) {
    const md = docsToMarkdown(seg.content, lists).trim();
    if (!md) continue;
    const role = roles[id] ? `${roles[id]} ` : '';
    out.push(`<!-- ${role}${kind} (${id}; edit with docs.set${kind === 'header' ? 'Header' : 'Footer'}) -->\n${md}\n<!-- end ${kind} -->`);
  }
  return out.join('\n\n');
}

function renderTable(
  table: docs_v1.Schema$Table,
  lists: Record<string, docs_v1.Schema$List> | undefined,
): string {
  const rows = (table.tableRows ?? []).map((row) =>
    (row.tableCells ?? []).map((cell) =>
      docsToMarkdown(cell.content, lists)
        .trim()
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|'),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [
    line(rows[0]),
    line(Array(width).fill('---')),
    ...rows.slice(1).map(line),
  ].join('\n');
}

function renderInline(
  elements: docs_v1.Schema$ParagraphElement[] | undefined,
  ctx: InlineContext,
): string {
  let out = '';
  for (const pe of elements ?? []) {
    if (pe.textRun?.content != null) {
      let run = styleRun(pe.textRun.content, pe.textRun.textStyle ?? {});
      // Pending suggestions as CriticMarkup; the trailing newline stays outside.
      const m = /^([\s\S]*?)(\n?)$/.exec(run)!;
      if (m[1] && pe.textRun.suggestedInsertionIds?.length) {
        run = `{++${m[1]}++}${m[2]}`;
      } else if (m[1] && pe.textRun.suggestedDeletionIds?.length) {
        run = `{--${m[1]}--}${m[2]}`;
      }
      out += run;
    } else if (pe.person?.personProperties) {
      const { name, email } = pe.person.personProperties;
      out += email ? `[${name || email}](mailto:${email})` : name || '';
    } else if (pe.richLink?.richLinkProperties) {
      const { title, uri } = pe.richLink.richLinkProperties;
      out += uri ? `[${title || uri}](${uri})` : title || '';
    } else if (pe.dateElement?.dateElementProperties) {
      const d = pe.dateElement.dateElementProperties;
      out += d.displayText || d.timestamp || '';
    } else if (pe.footnoteReference) {
      const id = pe.footnoteReference.footnoteId ?? '';
      const label =
        pe.footnoteReference.footnoteNumber || String(ctx.footnoteIds.length + 1);
      ctx.footnoteIds.push({ id, label });
      out += `[^${label}]`;
    } else if (pe.autoText) {
      out +=
        pe.autoText.type === 'PAGE_NUMBER'
          ? '{page number}'
          : pe.autoText.type === 'PAGE_COUNT'
            ? '{page count}'
            : '{auto text}';
    } else if (pe.pageBreak) {
      out += '<!-- page break -->';
    } else if (pe.columnBreak) {
      out += '<!-- column break -->';
    } else if (pe.horizontalRule) {
      out += '<!-- horizontal rule -->';
    } else if (pe.equation) {
      out += '{equation}';
    } else if (pe.inlineObjectElement) {
      // Images are rendered elsewhere when supported; never drop silently.
      out += '{image}';
    } else {
      // A chip or element type this server does not know (e.g. dropdown).
      const kinds = Object.keys(pe).filter((k) => !UNIT_KEYS.has(k));
      out += `{${kinds[0] ?? 'unknown element'}}`;
    }
  }
  return out.replace(/\u000b/g, '  \n');
}

/** Wraps a run's text in markdown markers, keeping edge whitespace outside. */
function styleRun(text: string, s: docs_v1.Schema$TextStyle): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  let core = m[2];
  if (!core) return text;
  const mono = /mono|courier|consolas/i.test(
    s.weightedFontFamily?.fontFamily ?? '',
  );
  if (mono) core = '`' + core + '`';
  if (s.strikethrough) core = `~~${core}~~`;
  if (s.italic) core = `*${core}*`;
  if (s.bold) core = `**${core}**`;
  if (s.link?.url) core = `[${core}](${s.link.url})`;
  return m[1] + core + m[3];
}

/**
 * A whole tab as markdown: the body (with footnote definitions after it),
 * then any non-empty headers and footers as separately labeled blocks.
 */
export function tabToMarkdown(tab: docs_v1.Schema$Tab): string {
  const dt = tab.documentTab;
  const lists = dt?.lists ?? undefined;
  const parts = [
    docsToMarkdown(dt?.body?.content, lists, {
      footnotes: dt?.footnotes ?? undefined,
    }).trimEnd(),
  ];
  const style = dt?.documentStyle;
  const headers = renderHeadersFooters(
    'header',
    dt?.headers ?? undefined,
    {
      ...(style?.defaultHeaderId ? { [style.defaultHeaderId]: '' } : {}),
      ...(style?.firstPageHeaderId
        ? { [style.firstPageHeaderId]: 'first-page' }
        : {}),
      ...(style?.evenPageHeaderId
        ? { [style.evenPageHeaderId]: 'even-page' }
        : {}),
    },
    lists,
  );
  const footers = renderHeadersFooters(
    'footer',
    (dt?.footers as Segments | undefined) ?? undefined,
    {
      ...(style?.firstPageFooterId
        ? { [style.firstPageFooterId]: 'first-page' }
        : {}),
      ...(style?.evenPageFooterId
        ? { [style.evenPageFooterId]: 'even-page' }
        : {}),
    },
    lists,
  );
  if (headers) parts.push(headers);
  if (footers) parts.push(footers);
  return parts.join('\n\n') + '\n';
}

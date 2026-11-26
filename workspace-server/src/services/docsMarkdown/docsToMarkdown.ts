/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { docs_v1 } from 'googleapis';

export interface RenderOptions {
  /**
   * Render images by their inline-object ID instead of a URL. For snapshots:
   * the API's content URIs are signed and expire (~30 min), so they change on
   * every fetch and would show up as edits in diffs.
   */
  stableImages?: boolean;
}

type InlineObjects = Record<string, docs_v1.Schema$InlineObject> | undefined;

/**
 * Renders a document tab as markdown in the same dialect markdownToDocs
 * accepts, without escaping, so text quoted from it works as an anchor.
 */
export function docsToMarkdown(
  content: docs_v1.Schema$StructuralElement[] | undefined,
  lists: Record<string, docs_v1.Schema$List> | undefined,
  inlineObjects?: InlineObjects,
  opts: RenderOptions = {},
): string {
  const blocks: string[] = [];
  let prevWasListItem = false;

  for (const el of content ?? []) {
    if (el.paragraph) {
      const p = el.paragraph;
      const line = renderInline(p.elements, inlineObjects, opts).replace(
        /\n$/,
        '',
      );
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
      blocks.push(renderTable(el.table, lists, inlineObjects, opts));
    } else {
      prevWasListItem = false;
    }
  }
  return blocks.join('\n\n') + '\n';
}

function renderTable(
  table: docs_v1.Schema$Table,
  lists: Record<string, docs_v1.Schema$List> | undefined,
  inlineObjects: InlineObjects,
  opts: RenderOptions,
): string {
  const rows = (table.tableRows ?? []).map((row) =>
    (row.tableCells ?? []).map((cell) =>
      docsToMarkdown(cell.content, lists, inlineObjects, opts)
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
  inlineObjects: InlineObjects,
  opts: RenderOptions,
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
    } else if (pe.inlineObjectElement) {
      out += renderImage(pe.inlineObjectElement, inlineObjects, opts);
    } else if (pe.person?.personProperties) {
      const { name, email } = pe.person.personProperties;
      out += email ? `[${name || email}](mailto:${email})` : name || '';
    } else if (pe.richLink?.richLinkProperties) {
      const { title, uri } = pe.richLink.richLinkProperties;
      out += uri ? `[${title || uri}](${uri})` : title || '';
    } else if (pe.dateElement?.dateElementProperties) {
      const d = pe.dateElement.dateElementProperties;
      out += d.displayText || d.timestamp || '';
    }
  }
  return out.replace(/\u000b/g, '  \n');
}

/**
 * ![alt](uri). Prefers the URL the image was inserted from (stable and
 * re-insertable), else the API's contentUri, which is for viewing only: it
 * expires after about 30 minutes. Alt is the object's description or title.
 */
function renderImage(
  el: docs_v1.Schema$InlineObjectElement,
  inlineObjects: InlineObjects,
  opts: RenderOptions,
): string {
  const id = el.inlineObjectId ?? '';
  const obj = inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject;
  // Drawings, charts and unknown objects have no image to show.
  const img = obj?.imageProperties;
  const alt = (obj?.description || obj?.title || '')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const uri = opts.stableImages
    ? img?.sourceUri || id
    : img?.sourceUri || img?.contentUri || id;
  return `![${alt}](${uri.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')})`;
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

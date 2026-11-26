/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for a Google Doc, just faithful enough to apply the
 * batchUpdate requests docsMarkdown/buildRequests.ts emits and to hand back a
 * docs_v1 Schema$Document that docsToMarkdown can read.
 *
 * Model: the document body is a flat array of tokens, one per Docs index
 * (UTF-16 code unit), so index arithmetic is exactly the real API's:
 *
 *   [sec] [ch]... ['\n' ch] [tbl] ([row] ([cell] [ch]... ['\n' ch])+ )+ [end] ...
 *
 * Paragraph properties live on the paragraph's terminating '\n' token (as in
 * the real API, where the newline carries the paragraph); text style lives on
 * every char token. Structure tokens (sec, tbl, row, cell, end) take one index
 * each, which reproduces the table offsets documented in buildRequests.ts
 * tableRequests: an empty R x C table is 2 + R * (1 + 2C) indices long and
 * cell (r, c) of a table at T holds its paragraph at T + 3 + r(1+2C) + 2c.
 *
 * Unknown request types, and unknown fields on the supported ones, THROW.
 * A new feature that emits a new request therefore fails the round-trip test
 * until someone teaches this file about it (see HARNESS.md).
 *
 * APPROXIMATIONS of real Docs (each marked APPROX below):
 *  - Table: the trailing `end` token models the extra index real Docs adds
 *    after a table; the offsets match tableRequests' live-verified formulas.
 *  - createParagraphBullets removes leading tabs and turns their count into
 *    the nesting level (as real Docs does); it adds no indentation styling.
 *  - Deleting a range that merges paragraphs gives the merged paragraph the
 *    FIRST paragraph's style (matches the comment in tableRequests); real
 *    Docs has more cases (e.g. mid-paragraph starts) we do not model.
 *  - Inserted text inherits the text style of the preceding character (real
 *    behavior, and why buildRequests resets styles), but link auto-styling
 *    (blue/underline) is not modeled; neither are suggestions, named-style
 *    inheritance, footnotes, headers, or multiple tabs.
 *  - Real Docs refuses some edits we also refuse (deleting the final newline,
 *    the newline directly before a table, a cell's final newline); other
 *    refusals real Docs makes may be missing here.
 */

import { docs_v1 } from 'googleapis';

type Request = docs_v1.Schema$Request;
type TextStyle = docs_v1.Schema$TextStyle;
type ParagraphStyle = docs_v1.Schema$ParagraphStyle;

export class FakeDocsError extends Error {}

interface ParaProps {
  style: ParagraphStyle;
  bullet?: { listId: string; nestingLevel: number };
}

interface Ch {
  k: 'ch';
  c: string;
  ts: TextStyle;
  para?: ParaProps;
  /** An inline image: one index, a char for paragraph purposes. */
  img?: { id: string; uri: string };
}
interface Struct {
  k: 'sec' | 'tbl' | 'row' | 'cell' | 'end';
}
type Tok = Ch | Struct;

const STRUCTURE = new Set(['sec', 'tbl', 'row', 'cell', 'end']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

const newline = (para?: ParaProps): Ch => ({
  k: 'ch',
  c: '\n',
  ts: {},
  para: para ? clone(para) : { style: { namedStyleType: 'NORMAL_TEXT' } },
});

const isNewline = (t: Tok | undefined): boolean =>
  !!t && t.k === 'ch' && t.c === '\n';

/** Applies a Docs field mask: listed fields are copied from `src` or cleared. */
function applyMask(
  target: Record<string, unknown>,
  src: Record<string, unknown>,
  fields: string | null | undefined,
  what: string,
) {
  if (!fields) throw new FakeDocsError(`${what}: missing fields mask`);
  if (fields === '*') {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, clone(src));
    return;
  }
  for (const field of fields.split(',')) {
    const path = field.trim().split('.');
    let t = target;
    let s: Record<string, unknown> | undefined = src;
    for (const seg of path.slice(0, -1)) {
      t = (t[seg] ??= {}) as Record<string, unknown>;
      s = s?.[seg] as Record<string, unknown> | undefined;
    }
    const last = path[path.length - 1];
    if (s && s[last] !== undefined) t[last] = clone(s[last]);
    else delete t[last];
  }
}

type Handler = (doc: FakeDoc, req: any) => void;

/**
 * One handler per supported request type. To support a new request, add an
 * entry here; FakeDoc.batchUpdate throws for any request type not listed.
 */
const HANDLERS: Record<string, Handler> = {
  insertText: (doc, r: docs_v1.Schema$InsertTextRequest) => {
    doc.rejectTab(r.location?.tabId ?? r.endOfSegmentLocation?.tabId);
    const index =
      r.location?.index ??
      (r.endOfSegmentLocation ? doc.length - 1 : undefined);
    if (index == null) throw new FakeDocsError('insertText: no location');
    doc.insertText(index, r.text ?? '');
  },
  insertTable: (doc, r: docs_v1.Schema$InsertTableRequest) => {
    doc.rejectTab(r.location?.tabId ?? r.endOfSegmentLocation?.tabId);
    const index =
      r.location?.index ??
      (r.endOfSegmentLocation ? doc.length - 1 : undefined);
    if (index == null) throw new FakeDocsError('insertTable: no location');
    doc.insertTable(index, r.rows ?? 0, r.columns ?? 0);
  },
  insertInlineImage: (doc, r: docs_v1.Schema$InsertInlineImageRequest) => {
    doc.rejectTab(r.location?.tabId ?? r.endOfSegmentLocation?.tabId);
    if (r.objectSize) throw new FakeDocsError('insertInlineImage: objectSize');
    if (r.location?.index == null) {
      throw new FakeDocsError('insertInlineImage: needs location.index');
    }
    if (!/^https?:\/\//.test(r.uri ?? '')) {
      throw new FakeDocsError('insertInlineImage: uri must be public http(s)');
    }
    doc.insertImage(r.location.index, r.uri!);
  },
  deleteContentRange: (doc, r: docs_v1.Schema$DeleteContentRangeRequest) => {
    doc.rejectTab(r.range?.tabId);
    doc.deleteRange(r.range?.startIndex ?? -1, r.range?.endIndex ?? -1);
  },
  updateTextStyle: (doc, r: docs_v1.Schema$UpdateTextStyleRequest) => {
    doc.rejectTab(r.range?.tabId);
    doc.updateTextStyle(
      r.range?.startIndex ?? -1,
      r.range?.endIndex ?? -1,
      r.textStyle ?? {},
      r.fields,
    );
  },
  updateParagraphStyle: (
    doc,
    r: docs_v1.Schema$UpdateParagraphStyleRequest,
  ) => {
    doc.rejectTab(r.range?.tabId);
    doc.updateParagraphStyle(
      r.range?.startIndex ?? -1,
      r.range?.endIndex ?? -1,
      r.paragraphStyle ?? {},
      r.fields,
    );
  },
  createParagraphBullets: (
    doc,
    r: docs_v1.Schema$CreateParagraphBulletsRequest,
  ) => {
    doc.rejectTab(r.range?.tabId);
    doc.createBullets(
      r.range?.startIndex ?? -1,
      r.range?.endIndex ?? -1,
      r.bulletPreset ?? '',
    );
  },
  deleteParagraphBullets: (
    doc,
    r: docs_v1.Schema$DeleteParagraphBulletsRequest,
  ) => {
    doc.rejectTab(r.range?.tabId);
    doc.deleteBullets(r.range?.startIndex ?? -1, r.range?.endIndex ?? -1);
  },
};

export class FakeDoc {
  private toks: Tok[] = [{ k: 'sec' }, newline()];
  private lists: Record<string, docs_v1.Schema$List> = {};
  private nextListId = 1;
  private nextImageId = 1;

  /** Number of indices in the body (the final newline is at length - 1). */
  get length(): number {
    return this.toks.length;
  }

  /** Applies requests in order, like documents.batchUpdate. */
  batchUpdate(requests: Request[]): void {
    requests.forEach((req, i) => {
      const keys = Object.keys(req).filter(
        (k) => (req as Record<string, unknown>)[k] !== undefined,
      );
      if (keys.length !== 1) {
        throw new FakeDocsError(
          `request #${i}: expected exactly one request type, got [${keys}]`,
        );
      }
      const handler = HANDLERS[keys[0]];
      if (!handler) {
        throw new FakeDocsError(
          `request #${i}: FakeDoc does not support "${keys[0]}". Teach it in fakeDocs.ts HANDLERS (see HARNESS.md). Request: ${JSON.stringify(req)}`,
        );
      }
      try {
        handler(this, (req as Record<string, unknown>)[keys[0]]);
        this.assertWellFormed();
      } catch (e) {
        if (e instanceof FakeDocsError) {
          e.message = `request #${i} (${keys[0]}): ${e.message}`;
        }
        throw e;
      }
    });
  }

  /** The document as the Docs API would return it (body + lists). */
  toDocument(): docs_v1.Schema$Document {
    const content = this.parseContainer(0, new Set()).content;
    const inlineObjects: Record<string, docs_v1.Schema$InlineObject> = {};
    for (const t of this.toks) {
      if (t.k === 'ch' && t.img) {
        inlineObjects[t.img.id] = {
          inlineObjectProperties: {
            embeddedObject: {
              imageProperties: {
                sourceUri: t.img.uri,
                contentUri: `https://lh3.fake/expiring/${t.img.id}`,
              },
            },
          },
        };
      }
    }
    return {
      documentId: 'fake-doc',
      body: { content },
      lists: clone(this.lists),
      inlineObjects,
    };
  }

  /** Visible text of the body, structure tokens shown as markers. For debugging. */
  dump(): string {
    return this.toks
      .map((t) => {
        if (t.k === 'ch') return t.c === '\n' ? '⏎' : t.c;
        return `<${t.k}>`;
      })
      .join('');
  }

  // ---- primitive edits (called by HANDLERS) ------------------------------

  rejectTab(tabId: string | null | undefined) {
    if (tabId) throw new FakeDocsError(`tabId "${tabId}": FakeDoc has one tab`);
  }

  insertText(index: number, text: string) {
    this.assertTextPosition(index, 'insertText');
    const before = this.toks[index - 1];
    const here = this.toks[index] as Ch;
    const inherit =
      before && before.k === 'ch' && before.c !== '\n' ? before.ts : here.ts;
    const terminator = this.paragraphTerminator(index);
    // One token per UTF-16 unit, as the API counts indices.
    const inserted: Tok[] = text.split('').map(
      (c): Tok =>
        c === '\n'
          ? { ...newline(terminator.para), ts: clone(inherit) }
          : { k: 'ch', c, ts: clone(inherit) },
    );
    this.toks.splice(index, 0, ...inserted);
  }

  /** APPROX: image fetch, sizing and alt text are not modeled. */
  insertImage(index: number, uri: string) {
    this.assertTextPosition(index, 'insertInlineImage');
    const before = this.toks[index - 1];
    const here = this.toks[index] as Ch;
    const inherit =
      before && before.k === 'ch' && before.c !== '\n' ? before.ts : here.ts;
    this.toks.splice(index, 0, {
      k: 'ch',
      c: '\uFFFC',
      ts: clone(inherit),
      img: { id: `kix.img${this.nextImageId++}`, uri },
    });
  }

  insertTable(index: number, rows: number, columns: number) {
    this.assertTextPosition(index, 'insertTable');
    if (rows < 1 || columns < 1) {
      throw new FakeDocsError(`insertTable: bad size ${rows}x${columns}`);
    }
    // Real Docs splits the paragraph at `index`: a new newline lands at
    // `index` and the table starts right after it (T = Q + 1).
    const terminator = this.paragraphTerminator(index);
    const table: Tok[] = [{ k: 'tbl' }];
    for (let r = 0; r < rows; r++) {
      table.push({ k: 'row' });
      for (let c = 0; c < columns; c++) {
        table.push({ k: 'cell' }, newline());
      }
    }
    table.push({ k: 'end' }); // APPROX: models real Docs' extra trailing index.
    this.toks.splice(index, 0, newline(terminator.para), ...table);
  }

  deleteRange(start: number, end: number) {
    if (!(start >= 1 && end > start && end <= this.toks.length - 1)) {
      throw new FakeDocsError(
        `deleteContentRange: bad range [${start}, ${end}) for body of length ${this.toks.length} (the final newline cannot be deleted)`,
      );
    }
    const gone = this.toks.slice(start, end);
    let depth = 0;
    for (const t of gone) {
      if (t.k === 'tbl') depth++;
      else if (t.k === 'end') depth--;
      else if ((t.k === 'row' || t.k === 'cell') && depth <= 0) depth = -99;
      if (depth < 0) {
        throw new FakeDocsError(
          `deleteContentRange: [${start}, ${end}) cuts through a table (it must cover whole tables or stay inside one cell)`,
        );
      }
    }
    if (depth !== 0) {
      throw new FakeDocsError(
        `deleteContentRange: [${start}, ${end}) splits a table`,
      );
    }
    for (let j = start; j < end; j++) {
      const next = this.toks[j + 1];
      // A paragraph newline directly before a structure token (table start,
      // or the end of a cell) cannot be deleted on its own.
      if (isNewline(this.toks[j]) && next && STRUCTURE.has(next.k) && j + 1 >= end) {
        throw new FakeDocsError(
          `deleteContentRange: cannot delete the newline at ${j}; it is followed by ${next.k}`,
        );
      }
    }
    const wholeParagraphs =
      this.paragraphStart(start) === start && isNewline(gone[gone.length - 1]);
    const firstPara = this.tryTerminator(start)?.para;
    const merges =
      !!firstPara && gone.some((t) => isNewline(t)) && !wholeParagraphs;
    const saved = clone(firstPara);
    this.toks.splice(start, end - start);
    if (merges) {
      // APPROX: the merged paragraph keeps the first paragraph's style.
      const survivor = this.tryTerminator(start);
      if (survivor) survivor.para = saved;
    }
  }

  updateTextStyle(
    start: number,
    end: number,
    style: TextStyle,
    fields: string | null | undefined,
  ) {
    this.assertRange(start, end, 'updateTextStyle');
    for (let i = start; i < end; i++) {
      const t = this.toks[i];
      if (t.k === 'ch') {
        applyMask(t.ts as Record<string, unknown>, style as Record<string, unknown>, fields, 'updateTextStyle');
      }
    }
  }

  updateParagraphStyle(
    start: number,
    end: number,
    style: ParagraphStyle,
    fields: string | null | undefined,
  ) {
    this.assertRange(start, end, 'updateParagraphStyle');
    for (const j of this.paragraphsIn(start, end)) {
      const p = (this.toks[j] as Ch).para!;
      applyMask(p.style as Record<string, unknown>, style as Record<string, unknown>, fields, 'updateParagraphStyle');
    }
  }

  createBullets(start: number, end: number, preset: string) {
    this.assertRange(start, end, 'createParagraphBullets');
    const ordered = /^NUMBERED_/.test(preset);
    if (!ordered && !/^BULLET_/.test(preset)) {
      throw new FakeDocsError(`createParagraphBullets: unknown preset "${preset}"`);
    }
    const listId = `kix.fake${this.nextListId++}`;
    const glyphs = ['DECIMAL', 'ALPHA', 'ROMAN'];
    this.lists[listId] = {
      listProperties: {
        nestingLevels: Array.from({ length: 9 }, (_, level) =>
          ordered
            ? { glyphType: glyphs[level % 3], glyphFormat: `%${level}.` }
            : { glyphSymbol: ['●', '○', '■'][level % 3] },
        ),
      },
    };
    // Back to front: removing a paragraph's leading tabs shifts later indices.
    for (const j of this.paragraphsIn(start, end).reverse()) {
      const from = this.paragraphStart(j);
      let tabs = 0;
      while (this.toks[from + tabs] && (this.toks[from + tabs] as any).c === '\t') {
        tabs++;
      }
      this.toks.splice(from, tabs);
      const term = this.toks[j - tabs] as Ch;
      term.para!.bullet = { listId, nestingLevel: tabs };
    }
  }

  deleteBullets(start: number, end: number) {
    this.assertRange(start, end, 'deleteParagraphBullets');
    for (const j of this.paragraphsIn(start, end)) {
      delete (this.toks[j] as Ch).para!.bullet;
    }
  }

  // ---- helpers -------------------------------------------------------------

  private assertRange(start: number, end: number, what: string) {
    if (!(start >= 1 && end > start && end <= this.toks.length)) {
      throw new FakeDocsError(
        `${what}: bad range [${start}, ${end}) for body of length ${this.toks.length}`,
      );
    }
  }

  private assertTextPosition(index: number, what: string) {
    const t = this.toks[index];
    if (!t || t.k !== 'ch') {
      throw new FakeDocsError(
        `${what}: index ${index} is not inside a paragraph (found ${t ? t.k : 'end of body'}); body is ${this.dump()}`,
      );
    }
  }

  /** Index of the first token of the paragraph containing token i. */
  private paragraphStart(i: number): number {
    let s = i;
    while (s > 0) {
      const prev = this.toks[s - 1];
      if (prev.k !== 'ch' || prev.c === '\n') break;
      s--;
    }
    return s;
  }

  private tryTerminator(i: number): Ch | undefined {
    for (let j = i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.k !== 'ch') break;
      if (t.c === '\n') return t;
    }
    return undefined;
  }

  private paragraphTerminator(i: number): Ch {
    const t = this.tryTerminator(i);
    if (!t) throw new FakeDocsError(`no paragraph terminator after index ${i}`);
    return t;
  }

  /** Terminator indices of paragraphs overlapping [start, end). */
  private paragraphsIn(start: number, end: number): number[] {
    const out: number[] = [];
    let ps = 0;
    this.toks.forEach((t, j) => {
      if (t.k !== 'ch') {
        ps = j + 1;
      } else if (t.c === '\n') {
        // APPROX: a paragraph counts when the range touches its text or its
        // newline, except a range that ends exactly at its first character.
        if (ps < end && j >= start) out.push(j);
        ps = j + 1;
      }
    });
    return out;
  }

  /** Every request must leave a structurally valid body. */
  private assertWellFormed() {
    const t = this.toks;
    const fail = (m: string) => {
      throw new FakeDocsError(`malformed document (${m}): ${this.dump()}`);
    };
    if (t[0]?.k !== 'sec') fail('first token is not the section break');
    if (!isNewline(t[t.length - 1])) fail('body must end with a paragraph');
    let depth = 0;
    t.forEach((tok, i) => {
      const next = t[i + 1];
      if (tok.k === 'tbl') {
        depth++;
        if (next?.k !== 'row') fail('table without rows');
      } else if (tok.k === 'end') {
        depth--;
        if (depth < 0) fail('unmatched table end');
      } else if (tok.k === 'row' && next?.k !== 'cell') {
        fail('row without cells');
      } else if (tok.k === 'cell' && !(next?.k === 'ch')) {
        fail('cell without a paragraph');
      } else if (isNewline(tok) && next?.k === 'sec') {
        fail('stray section break');
      } else if (tok.k === 'ch' && tok.c !== '\n') {
        // A paragraph's text must end in a newline before any structure token.
        if (next && next.k !== 'ch') fail('paragraph not terminated');
      }
    });
    if (depth !== 0) fail('unclosed table');
  }

  // ---- serialization -----------------------------------------------------

  /** Parses elements from token `from` until a token that closes the container. */
  private parseContainer(
    from: number,
    _stop: Set<string>,
  ): { content: docs_v1.Schema$StructuralElement[]; next: number } {
    const content: docs_v1.Schema$StructuralElement[] = [];
    let i = from;
    while (i < this.toks.length) {
      const t = this.toks[i];
      if (t.k === 'sec') {
        content.push({ startIndex: i, endIndex: i + 1, sectionBreak: {} });
        i++;
      } else if (t.k === 'ch') {
        i = this.parseParagraph(i, content);
      } else if (t.k === 'tbl') {
        i = this.parseTable(i, content);
      } else {
        break; // cell / row / end close the enclosing container
      }
    }
    return { content, next: i };
  }

  private parseParagraph(
    from: number,
    out: docs_v1.Schema$StructuralElement[],
  ): number {
    const elements: docs_v1.Schema$ParagraphElement[] = [];
    let i = from;
    let runStart = i;
    let text = '';
    let style: TextStyle | undefined;
    const flush = () => {
      if (!text) return;
      elements.push({
        startIndex: runStart,
        endIndex: runStart + text.length,
        textRun: { content: text, textStyle: clone(style) },
      });
      text = '';
    };
    for (;; i++) {
      const tok = this.toks[i] as Ch;
      if (!tok || tok.k !== 'ch') throw new FakeDocsError('unterminated paragraph');
      if (tok.img) {
        flush();
        elements.push({
          startIndex: i,
          endIndex: i + 1,
          inlineObjectElement: {
            inlineObjectId: tok.img.id,
            textStyle: clone(tok.ts),
          },
        });
        continue;
      }
      if (text && JSON.stringify(tok.ts) !== JSON.stringify(style)) flush();
      if (!text) {
        runStart = i;
        style = tok.ts;
      }
      text += tok.c;
      if (tok.c === '\n') {
        flush();
        const para: docs_v1.Schema$Paragraph = {
          elements,
          paragraphStyle: clone(tok.para!.style),
        };
        if (tok.para!.bullet) para.bullet = clone(tok.para!.bullet);
        out.push({ startIndex: from, endIndex: i + 1, paragraph: para });
        return i + 1;
      }
    }
  }

  private parseTable(
    from: number,
    out: docs_v1.Schema$StructuralElement[],
  ): number {
    const rows: docs_v1.Schema$TableRow[] = [];
    let i = from + 1;
    while (this.toks[i]?.k === 'row') {
      const rowStart = i++;
      const cells: docs_v1.Schema$TableCell[] = [];
      while (this.toks[i]?.k === 'cell') {
        const cellStart = i++;
        const inner = this.parseContainer(i, new Set());
        i = inner.next;
        cells.push({
          startIndex: cellStart,
          endIndex: i,
          content: inner.content,
        });
      }
      rows.push({ startIndex: rowStart, endIndex: i, tableCells: cells });
    }
    if (this.toks[i]?.k !== 'end') throw new FakeDocsError('unterminated table');
    i++;
    out.push({
      startIndex: from,
      endIndex: i,
      table: {
        rows: rows.length,
        columns: rows[0]?.tableCells?.length ?? 0,
        tableRows: rows,
      },
    });
    return i;
  }
}

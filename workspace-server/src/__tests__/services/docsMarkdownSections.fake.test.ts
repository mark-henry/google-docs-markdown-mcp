/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from '@jest/globals';
import { markdownToDocs } from '../../services/docsMarkdown/markdownToDocs';
import { flatten } from '../../services/docsMarkdown/docIndex';
import { docsToMarkdown } from '../../services/docsMarkdown/docsToMarkdown';
import {
  findSection,
  replaceSectionBody,
  replaceWholeSection,
  insertInSection,
  moveSection,
  elementsIn,
  copyLosses,
  MoveTarget,
} from '../../services/docsMarkdown/sections';
import { planReplaceAll } from '../../services/docsMarkdown/replaceAll';
import { FakeDoc } from './docsMarkdownHarness/fakeDocs';
import {
  insertMarkdownAtEnd,
  readMarkdown,
} from './docsMarkdownHarness/roundTrip';

const SRC = `# Intro

hello world

## Pricing

price **bold** text

| a | b |
| --- | --- |
| 1 | 2 |

after table

### Plans

- one
- two

## Terms

terms here

# End

bye
`;

function fresh(markdown = SRC) {
  const doc = new FakeDoc();
  insertMarkdownAtEnd(doc, markdown);
  return doc;
}

const read = (d: FakeDoc) => readMarkdown(d.toDocument());
const flatOf = (d: FakeDoc) => flatten(d.toDocument().body?.content);

function applyMove(
  d: FakeDoc,
  name: string,
  target: (f: ReturnType<typeof flatOf>) => MoveTarget,
) {
  const body = d.toDocument().body?.content;
  const flat = flatten(body);
  const src = findSection(flat, name);
  const content = elementsIn(body, src.start, src.end);
  const md = markdownToDocs(
    docsToMarkdown(content, d.toDocument().lists ?? undefined),
  );
  expect(copyLosses(flat, src, content, md)).toEqual([]);
  d.batchUpdate(moveSection(md, src, target(flat), flat).requests);
}

describe('sections against the fake doc', () => {
  it('starts from the expected markdown', () => {
    expect(read(fresh())).toContain('## Pricing');
  });

  it('replaces a section body, keeping the heading and dropping the table', () => {
    const d = fresh();
    const flat = flatOf(d);
    d.batchUpdate(
      replaceSectionBody(
        markdownToDocs('new body'),
        findSection(flat, 'Pricing'),
        flat,
      ).requests,
    );
    const out = read(d);
    expect(out).toContain('## Pricing\n\nnew body\n\n## Terms');
    expect(out).not.toContain('| a |');
    expect(out).toContain('# Intro\n\nhello world');
  });

  it('replaces a middle section with markdown containing a table', () => {
    const d = fresh();
    const flat = flatOf(d);
    d.batchUpdate(
      replaceSectionBody(
        markdownToDocs('| x | y |\n| --- | --- |\n| 1 | 2 |'),
        findSection(flat, 'Terms'),
        flat,
      ).requests,
    );
    expect(read(d)).toContain('## Terms\n\n| **x** | **y** |');
    expect(read(d)).toContain('# End\n\nbye');
  });

  it('deletes a middle section including subsections', () => {
    const d = fresh();
    const flat = flatOf(d);
    d.batchUpdate(
      replaceWholeSection(
        markdownToDocs(''),
        findSection(flat, 'Pricing'),
        flat,
      ).requests,
    );
    const out = read(d);
    expect(out).not.toContain('Pricing');
    expect(out).not.toContain('Plans');
    expect(out).toContain('hello world\n\n## Terms');
  });

  it('deletes the last section of the doc', () => {
    const d = fresh();
    const flat = flatOf(d);
    d.batchUpdate(
      replaceWholeSection(markdownToDocs(''), findSection(flat, 'End'), flat)
        .requests,
    );
    const out = read(d);
    expect(out).not.toContain('bye');
    expect(out).toMatch(/terms here\n$/);
  });

  it('clears the body of the last section', () => {
    const d = fresh();
    const flat = flatOf(d);
    d.batchUpdate(
      replaceSectionBody(markdownToDocs(''), findSection(flat, 'End'), flat)
        .requests,
    );
    expect(read(d)).toMatch(/# End\n$/);
  });

  it('inserts at the start and end of a section', () => {
    const d = fresh();
    let flat = flatOf(d);
    d.batchUpdate(
      insertInSection(
        markdownToDocs('first'),
        findSection(flat, 'Terms'),
        'beginning',
        flat,
      ).requests,
    );
    flat = flatOf(d);
    d.batchUpdate(
      insertInSection(
        markdownToDocs('last'),
        findSection(flat, 'Terms'),
        'end',
        flat,
      ).requests,
    );
    expect(read(d)).toContain(
      '## Terms\n\nfirst\n\nterms here\n\nlast\n\n# End',
    );
  });

  it('moves a section containing a table and a subsection forward', () => {
    const d = fresh();
    applyMove(d, 'Pricing', (f) => ({ before: findSection(f, 'End') }));
    const out = read(d);
    expect(out.indexOf('## Terms')).toBeLessThan(out.indexOf('## Pricing'));
    expect(out.indexOf('## Pricing')).toBeLessThan(out.indexOf('# End'));
    expect(out).toContain('| **a** | **b** |');
    expect(out).toContain('after table');
    expect(out).toContain('### Plans\n\n- one\n- two');
    expect(out).toContain('price **bold** text');
  });

  it('moves a section backward to the beginning', () => {
    const d = fresh();
    applyMove(d, 'End', () => ({ at: 'beginning' }));
    const out = read(d);
    expect(out.startsWith('# End\n\nbye\n\n# Intro')).toBe(true);
    expect(out.trimEnd().endsWith('terms here')).toBe(true);
  });

  it('moves a section to the end', () => {
    const d = fresh();
    applyMove(d, 'Pricing', () => ({ at: 'end' }));
    const out = read(d);
    expect(out.indexOf('# End')).toBeLessThan(out.indexOf('## Pricing'));
    expect(out).toContain('| **a** | **b** |');
    expect(out.indexOf('## Pricing')).toBeLessThan(out.indexOf('### Plans'));
  });

  it('moves a section next to a subsection of another', () => {
    const d = fresh();
    applyMove(d, 'Terms', (f) => ({ before: findSection(f, 'Plans') }));
    const out = read(d);
    expect(out.indexOf('after table')).toBeLessThan(out.indexOf('## Terms'));
    expect(out.indexOf('## Terms')).toBeLessThan(out.indexOf('### Plans'));
    expect(out).toContain('terms here\n\n### Plans');
  });

  it('refuses a move to where the section already is', () => {
    const d = fresh();
    const flat = flatOf(d);
    const src = findSection(flat, 'End');
    expect(() =>
      moveSection(
        markdownToDocs('# End\n\nbye'),
        src,
        { after: findSection(flat, 'Intro') },
        flat,
      ),
    ).toThrow(/nothing to move/);
  });
});

describe('replaceAll against the fake doc', () => {
  it('replaces across paragraphs, table cells and a heading', () => {
    const d = fresh(
      '# Cat\n\ncat one\n\n| cat | dog |\n| --- | --- |\n| cat | x |\n\nend cat\n',
    );
    const plan = planReplaceAll(flatOf(d), 'cat', 'bird');
    expect(plan.count).toBe(4);
    d.batchUpdate(plan.requests);
    const out = read(d);
    expect(out).toContain('# Cat');
    expect(out).toContain('bird one');
    expect(out).toContain('| **bird** | **dog** |');
    expect(out).toContain('| bird | x |');
    expect(out).toContain('end bird');
  });

  it('keeps the match style and handles deletion', () => {
    const d = fresh('a **foo** b foo\n');
    d.batchUpdate(planReplaceAll(flatOf(d), 'foo', 'bar').requests);
    expect(read(d)).toBe('a **bar** b bar\n');
    d.batchUpdate(planReplaceAll(flatOf(d), ' b bar', '').requests);
    expect(read(d)).toBe('a **bar**\n');
  });

  it('can be limited to a section', () => {
    const d = fresh();
    const flat = flatOf(d);
    const s = findSection(flat, 'Terms');
    const plan = planReplaceAll(flat, 'here', 'there', {
      within: { start: s.start, end: s.end },
    });
    expect(plan.count).toBe(1);
    d.batchUpdate(plan.requests);
    expect(read(d)).toContain('terms there');
  });
});

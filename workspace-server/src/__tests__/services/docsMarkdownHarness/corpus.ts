/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Round-trip corpus. Write fixtures in the dialect docsToMarkdown emits
 * (canonical form: `-` bullets, `1.` for every numbered item, two-space list
 * indent, blank line between blocks), so a clean round trip is byte-equal.
 * Markdown that cannot survive goes in EXPECTED_DIFFERENCES below.
 */
export interface Fixture {
  /** Unique, kebab-case; EXPECTED_DIFFERENCES refers to it. */
  name: string;
  markdown: string;
}

/** A fixture whose read-back is known to differ from what was written. */
export interface ExpectedDifference {
  fixture: string;
  /** Exact (normalized) markdown readMarkdown returns today. */
  actual: string;
  /** Why it differs, and whether that is by design or a bug to fix. */
  reason: string;
}

const f = (name: string, markdown: string): Fixture => ({ name, markdown });

export const CORPUS: Fixture[] = [
  // ---- paragraphs and headings
  f('paragraph', 'Just a paragraph.\n'),
  f('two-paragraphs', 'First paragraph.\n\nSecond paragraph.\n'),
  f('headings-1-to-6', '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n'),
  f('heading-then-text', '# Title\n\nBody under the title.\n\n## Section\n\nMore body.\n'),
  f('hard-break', 'line one  \nline two\n'),
  f('unicode-and-emoji', 'Café ☕ 日本語 😀 done\n'),
  f('emoji-styled', 'before **😀 bold** after\n'),

  // ---- inline styles
  f('bold', 'a **bold** word\n'),
  f('italic', 'an *italic* word\n'),
  f('strikethrough', 'a ~~struck~~ word\n'),
  f('inline-code', 'run `npm test` now\n'),
  f('bold-italic', 'very ***loud*** text\n'),
  f('bold-strike', 'a **~~both~~** word\n'),
  f('bold-code', 'a **`code`** word\n'),
  f('adjacent-styles', '**bold***italic*~~strike~~`code`\n'),
  f('styled-heading', '## A **bold** heading with `code`\n'),
  f('whole-paragraph-bold', '**All bold.**\n'),

  // ---- links
  f('link', 'See [the docs](https://example.com/docs) for more.\n'),
  f('link-styled', 'A [**bold link**](https://example.com) and [*it*](https://e.org/x?a=1&b=2).\n'),
  f('link-in-heading', '### Read [this](https://example.com)\n'),

  // ---- lists
  f('bullets', '- one\n- two\n- three\n'),
  f('numbered', '1. one\n1. two\n1. three\n'),
  f('nested-bullets', '- a\n  - b\n    - c\n  - d\n- e\n'),
  f('nested-numbered-3-space', '1. a\n   1. b\n      1. c\n   1. d\n1. e\n'),
  f('bullets-inline-styles', '- **bold** item\n- item with `code`\n- [link](https://example.com) item\n'),
  f('list-between-paragraphs', 'Before.\n\n- one\n- two\n\nAfter.\n'),
  f('list-after-heading', '## Todo\n\n- one\n  - sub\n- two\n'),
  f('two-bullet-lists', '- a\n- b\n\nBreak.\n\n- c\n- d\n'),
  f('bullet-with-nested-numbered', '- a\n  1. b\n  1. c\n- d\n'),
  f('numbered-with-nested-bullets', '1. a\n   - b\n   - c\n1. d\n'),
  f('deep-nesting-skips-nothing', '- l0\n  - l1\n    - l2\n      - l3\n- back\n'),
  f('adjacent-bullet-and-numbered', '- a\n- b\n\n1. c\n1. d\n'),
  f('numbered-with-explicit-numbers', '1. a\n2. b\n3. c\n'),

  // ---- task lists
  f('task-list', '- [ ] one\n- [ ] two\n'),
  f('task-list-nested', '- [ ] a\n  - [ ] b\n- [ ] c\n'),
  f('task-list-checked', '- [x] done\n- [ ] todo\n'),
  f('task-then-bullets', '- [ ] a\n\n- b\n\n- [ ] c\n'),
  f('task-after-numbered', '1. a\n1. b\n\n- [ ] c\n'),

  // ---- list items with several paragraphs
  f('list-item-line-break', '1. a  \n   more\n1. b\n'),
  f('list-item-two-paragraphs', '- a\n\n  more\n- b\n'),
  f('list-item-code-block', '- a\n\n  ```\n  x\n  y\n  ```\n- b\n'),
  f('nested-item-continuation', '- a\n  - b  \n    more\n'),
  f('numbered-nested-continuation', '1. a\n   1. b  \n      more\n'),

  // ---- underline, superscript, subscript
  f('superscript', 'x<sup>2</sup> done\n'),
  f('subscript', 'H<sub>2</sub>O\n'),
  f('underline', 'an <u>underlined</u> word\n'),
  f('underline-bold', 'a **<u>bold underline</u>** word\n'),
  f('sup-in-list', '- m<sup>2</sup>\n- H<sub>2</sub>O\n'),
  f('unclosed-tag', 'a <u>never closed\n'),

  // ---- horizontal rule and page break
  f('rule', 'Before.\n\n---\n\nAfter.\n'),
  f('rule-at-end', 'Before.\n\n---\n'),
  f('rule-at-start', '---\n\nAfter.\n'),
  f('two-rules', 'a\n\n---\n\n---\n\nb\n'),
  f('page-break', 'Before.\n\n<!-- pagebreak -->\n\nAfter.\n'),
  f('page-break-at-end', 'Before.\n\n<!-- pagebreak -->\n'),
  f('page-break-at-start', '<!-- pagebreak -->\n\nAfter.\n'),
  f('page-break-before-table', 'a\n\n<!-- pagebreak -->\n\n| **x** |\n| --- |\n| 1 |\n'),
  f('page-break-after-list', '- a\n- b\n\n<!-- pagebreak -->\n\nc\n'),
  f('rule-and-break', 'a\n\n---\n\n<!-- pagebreak -->\n\nb\n'),

  // ---- code
  f('fenced-code', '```\nconst a = 1;\nconst b = 2;\n```\n'),
  f('fenced-code-with-lang', '```ts\nlet x: number = 1;\n```\n'),
  f('fenced-code-blank-line', '```\nfirst\n\nthird\n```\n'),
  f('code-between-paragraphs', 'Run this:\n\n```\nnpm test\n```\n\nThen relax.\n'),

  // ---- blockquotes
  f('blockquote', '> quoted\n'),
  f('blockquote-multiline', '> line one\n>\n> line two\n'),
  f('blockquote-nested', '> outer\n>\n> > inner\n'),
  f('blockquote-with-list', '> - a\n> - b\n'),

  // ---- tables
  f('table', '| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n'),
  f('table-header-only', '| **a** | **b** |\n| --- | --- |\n'),
  f('table-inline-styles', '| **h1** | **h2** |\n| --- | --- |\n| *it* | `code` |\n| ~~s~~ | [l](https://e.com) |\n'),
  f('table-empty-cell', '| **a** | **b** |\n| --- | --- |\n|  | 2 |\n| 3 |  |\n'),
  f('table-single-column', '| **only** |\n| --- |\n| x |\n| y |\n'),
  f('table-between-paragraphs', 'Before.\n\n| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n'),
  f('table-at-start', '| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n'),
  f('table-at-end', 'Before.\n\n| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n'),
  f('table-only', '| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n'),
  f('two-tables', '| **a** |\n| --- |\n| 1 |\n\nBetween.\n\n| **b** |\n| --- |\n| 2 |\n'),
  f('adjacent-tables', '| **a** |\n| --- |\n| 1 |\n\n| **b** |\n| --- |\n| 2 |\n'),
  f('table-after-list', '- a\n- b\n\n| **x** |\n| --- |\n| 1 |\n'),
  f('list-after-table', '| **x** |\n| --- |\n| 1 |\n\n- a\n- b\n'),
  f('table-after-nested-list', '- a\n  - b\n\n| **x** |\n| --- |\n| 1 |\n'),
  f('table-plain-header', '| a | b |\n| --- | --- |\n| 1 | 2 |\n'),
  f('table-escaped-pipe', '| **a** | **b** |\n| --- | --- |\n| x \\| y | 2 |\n'),
  f('table-after-heading', '## Data\n\n| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n'),

  // ---- escaping, html
  f('escaped-asterisks', 'not \\*italic\\* here\n'),
  f('literal-html', 'a <b>tag</b> here\n'),
  f('html-entities', 'fish &amp; chips &lt;3\n'),
];

/**
 * Known read/write drifts, pinned exactly. The test fails if a listed
 * fixture's read-back changes in ANY way (including being fixed), so the
 * entry must then be updated or removed. Do not add an entry just to make a
 * new feature's test pass: a new drift is a bug to fix, or a deliberate
 * design limit worth a clear reason.
 */
export const EXPECTED_DIFFERENCES: ExpectedDifference[] = [
  {
    fixture: "bullet-with-nested-numbered",
    actual: "- a\n  - b\n  - c\n- d\n",
    reason:
      "API LIMIT: Docs has no per-level glyph control and a nested item of the other kind cannot safely get its own createParagraphBullets call (the nesting depends on the leading tabs of one call), so nested items take the top-level item's preset: numbered items under a bullet read as bullets.",
  },
  {
    fixture: "numbered-with-nested-bullets",
    actual: "1. a\n   1. b\n   1. c\n1. d\n",
    reason:
      "API LIMIT: same as bullet-with-nested-numbered; bullets nested under a numbered item take the numbered preset (NUMBERED_DECIMAL_NESTED, shown as 1.1.). Indentation now reads back correctly.",
  },
  {
    fixture: "task-list-checked",
    actual: "- [ ] done\n- [ ] todo\n",
    reason:
      "API LIMIT: the Docs API cannot set or read a checkbox's checked state, so `[x]` is written (and read back) as unchecked.",
  },
  {
    fixture: "list-item-two-paragraphs",
    actual: "- a  \n  more\n- b\n",
    reason:
      "By design: a second paragraph in a list item is stored as a line break inside the item's one paragraph (keeps the bullet and numbering), so it reads back as a hard break.",
  },
  {
    fixture: "list-item-code-block",
    actual: "- a  \n  `x`  \n  `y`\n- b\n",
    reason:
      "By design plus the known read-side gap: a code block in a list item becomes line-broken monospace lines, which read back as inline `code` per line (fenced blocks are not read back, see fenced-code).",
  },
  {
    fixture: "numbered-with-explicit-numbers",
    actual: "1. a\n1. b\n1. c\n",
    reason:
      "By design: docsToMarkdown writes every numbered item as `1.`; the doc's own numbering is automatic, so explicit numbers are not kept.",
  },
  {
    fixture: "fenced-code",
    actual: "`const a = 1;`\n\n`const b = 2;`\n",
    reason:
      "Read side not implemented: code blocks are stored as monospace paragraphs, and docsToMarkdown renders each line as inline `code` instead of a fenced block.",
  },
  {
    fixture: "fenced-code-with-lang",
    actual: "`let x: number = 1;`\n",
    reason:
      "Read side not implemented (fenced block becomes inline code), and the info string (language) is dropped on write: the doc has no place to store it.",
  },
  {
    fixture: "fenced-code-blank-line",
    actual: "`first`\n\n`third`\n",
    reason:
      "Read side not implemented (inline code per line), and blank lines inside the block are dropped because empty paragraphs are skipped on read.",
  },
  {
    fixture: "code-between-paragraphs",
    actual: "Run this:\n\n`npm test`\n\nThen relax.\n",
    reason:
      "Read side not implemented: the fenced block reads back as one inline `code` span.",
  },
  {
    fixture: "blockquote",
    actual: "quoted\n",
    reason:
      "Read side not implemented: quotes are stored only as paragraph indentation (indentStart) and docsToMarkdown ignores indentation, so the `>` marker is lost.",
  },
  {
    fixture: "blockquote-multiline",
    actual: "line one\n\nline two\n",
    reason:
      "Read side not implemented (indent ignored); the empty quote line also reads as a plain blank line, so both paragraphs lose the quote.",
  },
  {
    fixture: "blockquote-nested",
    actual: "outer\n\ninner\n",
    reason:
      "Read side not implemented: quote depth is stored only as indentation, which docsToMarkdown ignores.",
  },
  {
    fixture: "blockquote-with-list",
    actual: "- a\n- b\n",
    reason:
      "Read side not implemented: the quote marker on list items is lost (indentation ignored).",
  },
  {
    fixture: "table-plain-header",
    actual: "| **a** | **b** |\n| --- | --- |\n| 1 | 2 |\n",
    reason:
      "By design: the writer bolds table header cells, and docsToMarkdown renders bold as `**`, so a plain header reads back bold. Fixtures with bold headers round-trip.",
  },
  {
    fixture: "escaped-asterisks",
    actual: "not *italic* here\n",
    reason:
      "By design (documented in docsToMarkdown): output is not escaped so quoted text works as an anchor, so literal `*` reads back as markdown emphasis.",
  },
  {
    fixture: "html-entities",
    actual: "fish & chips <3\n",
    reason:
      "Write decodes entities (&amp; -> &) and read does not re-encode; harmless for text, lossy for the literal string `&amp;`.",
  },
];

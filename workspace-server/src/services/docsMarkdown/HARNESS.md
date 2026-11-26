# Round-trip harness for the markdown Docs tools

Checks that `markdown -> markdownToDocs -> buildRequests -> doc -> docsToMarkdown` gives back equivalent markdown, so a new format feature can be checked for read/write drift. The real Docs API is replaced by an in-memory fake that applies the batchUpdate requests `buildRequests.ts` emits.

Files (all under `workspace-server/src/__tests__/services/`):

- `docsMarkdownHarness/fakeDocs.ts`: `FakeDoc`, the fake document. `batchUpdate(requests)`, `toDocument()` (a docs_v1 `Schema$Document`), `dump()` for debugging.
- `docsMarkdownHarness/roundTrip.ts`: `roundTrip(md)`, `roundTripDetailed(md)`, `normalize(md)`, `readMarkdown(doc)`, `insertMarkdownAtEnd(doc, md)`.
- `docsMarkdownHarness/corpus.ts`: `CORPUS` (fixtures) and `EXPECTED_DIFFERENCES` (pinned drifts, each with a reason).
- `docsMarkdownRoundTrip.test.ts`: the jest test.
- `docsMarkdownHarness/live.ts` + `docsMarkdownRoundTrip.live.test.ts`: opt-in live-mode skeleton (see the end).

Run it (targeted only; never the whole suite, never watch):

    npx jest workspace-server/src/__tests__/services/docsMarkdownRoundTrip.test.ts

The first run is slow (ts-jest compiles googleapis types); expect minutes on this laptop.

## Add a fixture

1. Add `f('your-name', 'markdown\n')` to `CORPUS` in `corpus.ts`. Names are unique kebab-case.
2. Write it in the dialect `docsToMarkdown` emits, so a clean round trip is byte-equal: `-` bullets, `1.` for every numbered item, two-space nesting for bullets (three for children of a numbered item, as CommonMark needs), a blank line between blocks, bold table header cells (`| **a** |`).
3. Run the test. If the fixture fails, the output shows the diff. Either fix the read or write code, or, if the difference is deliberate or a known limit, record it:
   `GWM_PRINT_DRIFTS=/tmp/drifts.json npx jest <test path> -t "prints drifts"` writes every differing fixture as JSON to that file; copy the entry into `EXPECTED_DIFFERENCES` with `fixture`, the exact `actual` read-back, and a `reason` that says whether it is by design or a bug.

The only normalization is CRLF -> LF and one trailing newline. A listed drift is pinned exactly: the test fails if its read-back changes in any way, including becoming identical to the input (delete the entry then). Do not add an entry just to make a new feature pass.

`roundTrip` starts from an empty doc and appends with `insertAfter`, the same path as `docs_insertMarkdown` into a new doc. To test replace or inline paths, build a `FakeDoc`, call `batchUpdate` with the requests from `replaceParagraphs`, `replaceInline` and so on, then `readMarkdown(doc.toDocument())`.

## Teach the fake a new request type

`FakeDoc.batchUpdate` throws on any request type or field it does not know, so a feature that emits something new fails loudly until the fake learns it.

1. Add a handler to `HANDLERS` in `fakeDocs.ts`, keyed by the request name (`replaceAllText`, `createNamedRange`, ...). Handlers get the request body and call a primitive on `FakeDoc` (add one if needed).
2. The model is one token per document index: a char (with its text style; a paragraph's `\n` carries the paragraph style and bullet) or a structure marker (`sec`, `tbl`, `row`, `cell`, `end`). Edit by splicing `toks`, so indices stay exactly the real API's. `assertWellFormed()` runs after every request and rejects malformed bodies.
3. Style requests go through `applyMask`, which applies a Docs field mask generically, so new style fields need no code unless they live somewhere new in the output.
4. If a new element must be read back (images, chips, footnotes), extend the token types and `parseParagraph`/`parseTable` so `toDocument()` emits what `docsToMarkdown` reads.
5. Mark anything that only approximates real Docs with an `APPROX:` comment, and match offsets to the live-verified ones documented in `buildRequests.ts` (`tableRequests`). Where unsure, throw rather than guess.

Known approximations are listed at the top of `fakeDocs.ts`: the extra index after a table, bullets removing nesting tabs without adding indentation, paragraph-merge style on delete, no link auto-styling, one tab only. The fake was written from the code comments, not captured from the live API, so a pass here does not replace a live check for offset-sensitive changes.

## Live mode (opt-in skeleton)

`docsMarkdownRoundTrip.live.test.ts` runs the same corpus against a real doc only when `GWM_LIVE_ROUNDTRIP=1` is set; otherwise it is skipped. `makeLiveClient()` in `live.ts` deliberately throws: implement it with a `LiveDocsClient` (create, get, batchUpdate, delete a scratch doc) backed by credentials for a throwaway account. Nothing in the default path touches the network or credentials.

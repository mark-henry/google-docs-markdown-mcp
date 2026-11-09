# Changelog

## 0.2.0 (2026-11-09)

### Added

- `docs.listComments`: comment threads with their quoted text, every post's author and time, and open/resolved state; plus pending suggestions with author and summary.
- `docs.replyToComment`: reply to a thread by ID, and/or resolve or reopen it.
- `docs.changesSince`: what other people changed since your last read, as a markdown diff plus new comments and suggestions. Edits made through this server are left out. Snapshots live in `~/.local/state/google-docs-markdown-mcp/<account>/` (or `WORKSPACE_STATE_DIR`).
- `docs.readMarkdown` headers now show the revision ID and how many open comments and pending suggestions the doc has.

## 0.1.0 (2026-11-09)

First release of the fork.

### Added

- `docs.readMarkdown`: read a document tab as markdown, including tables and pending suggestions (CriticMarkup).
- `docs.insertMarkdown`: insert formatted markdown at the beginning or end, or before or after quoted text.
- `docs.replaceMarkdown`: replace quoted text with inline or block markdown; empty markdown deletes.
- `docs.comment`: comment on quoted text.
- `mode: "suggest"` on write tools, to record edits as suggestions.
- Revision-pinned, atomic edits (`requiredRevisionId`).
- Multiple Google accounts via `WORKSPACE_ACCOUNT`, with `WORKSPACE_LOGIN_HINT` to preselect the account.
- `scripts/mcp-call.mjs` for calling a tool on the built server from the shell.

### Fixed

- `docs.writeText` with the default `position` failed with "No insertion location set" ([upstream #452](https://github.com/gemini-cli-extensions/workspace/issues/452)).

Based on [gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace) at `089927e`.

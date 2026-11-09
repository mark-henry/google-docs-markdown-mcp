# Google Docs Markdown MCP Server

[![CI](https://github.com/mark-henry/google-docs-markdown-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mark-henry/google-docs-markdown-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-6E56CF.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)

**Let AI agents read and edit Google Docs in markdown.** An MCP server for Claude Code, Claude Desktop, Cursor, Gemini CLI and any other [Model Context Protocol](https://modelcontextprotocol.io) client. Agents read a doc as markdown, write markdown back as real Google Docs formatting, and point at places by quoting text, not by counting characters.

```text
docs.replaceMarkdown(
  documentId: "1b0e8U…",
  find:       "## Next steps\n\nTBD",
  markdown:   "## Next steps\n\n1. Ship the **beta**\n2. Write the [launch post](https://example.com)\n   - draft by Friday",
  mode:       "suggest"
)
→ Replaced (whole paragraphs containing the match) as suggestions in "Q4 plan".
```

The heading, numbered list, nested bullet, bold and link land as native Docs formatting, and in `suggest` mode they show up as tracked suggestions the doc owner can accept or reject.

## Why

The Google Docs API speaks in character indices: insert at 1,482, bold 1,490–1,497, and recompute everything after each edit. Agents are bad at that and good at markdown. This server does the index arithmetic against the document's real structure (tables, smart chips and all), so agents never see an index:

- **Markdown in, markdown out.** `readMarkdown` renders headings, nested lists, bold/italic/strikethrough/code, links, tables and pending suggestions. `insertMarkdown` and `replaceMarkdown` accept the same dialect.
- **Quote text to say where.** `after: "the paragraph about pricing"`. The quote must match exactly once; if it's ambiguous, the error lists every match with context so the agent can quote more.
- **Safe by construction.** Every edit is one atomic `batchUpdate` pinned to the revision it read. If a person edits the doc in between, the call fails and changes nothing.
- **Suggest mode.** `mode: "suggest"` records edits as Google Docs suggestions, so a human approves what the agent wrote.
- **Comments.** `docs.comment` anchors a comment to quoted text.
- **Multiple Google accounts.** Run one instance per account, each with its own sign-in.
- **Works with personal Gmail.** Google's official Docs MCP server is a developer preview limited to Workspace-domain accounts; this works with any Google account.

It also includes the full upstream toolset: about 60 tools across Docs, Drive, Gmail, Calendar, Sheets, Slides, Chat, Tasks and People.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/mark-henry/google-docs-markdown-mcp.git
cd google-docs-markdown-mcp
npm ci
npm run build
```

The first tool call opens a browser window for Google sign-in. Tokens are stored in your OS keychain (or an encrypted file where no keychain is available).

> [!IMPORTANT]
> **Out of the box, sign-in goes through the upstream project's Google OAuth app.** Google's consent screen will name the Gemini CLI Workspace extension, not this project, and that app's hosted token exchange (`google-workspace-extension.geminicli.com`) is run by the upstream project. If it is restricted or shut down, sign-in stops working. To depend on nobody, [run your own OAuth app](#use-your-own-oauth-app), a one-time setup with `gcloud`.

### Claude Code

```bash
claude mcp add --scope user google-docs -- node "$PWD/workspace-server/dist/index.js"
```

### Claude Desktop, Cursor, Windsurf and other MCP clients

Add to the client's MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "google-docs": {
      "command": "node",
      "args": [
        "/absolute/path/to/google-docs-markdown-mcp/workspace-server/dist/index.js"
      ]
    }
  }
}
```

### Gemini CLI

```bash
gemini extensions install https://github.com/mark-henry/google-docs-markdown-mcp
```

## Multiple Google accounts

Each server instance keeps its own sign-in under `WORKSPACE_ACCOUNT`. Register one instance per account; the agent picks an account by which server's tools it calls.

```bash
claude mcp add --scope user gdocs-work \
  -e WORKSPACE_ACCOUNT=work -e WORKSPACE_LOGIN_HINT=me@company.com \
  -- node "$PWD/workspace-server/dist/index.js"

claude mcp add --scope user gdocs-personal \
  -e WORKSPACE_ACCOUNT=personal -e WORKSPACE_LOGIN_HINT=me@gmail.com \
  -- node "$PWD/workspace-server/dist/index.js"
```

`WORKSPACE_LOGIN_HINT` preselects the account on Google's sign-in page. Without `WORKSPACE_ACCOUNT`, the server uses a single default sign-in, compatible with the upstream extension.

## Markdown tools

| Tool                   | What it does                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs.readMarkdown`    | Reads a tab as markdown. Text quoted from this output works as an anchor in the other tools.                                                                                         |
| `docs.insertMarkdown`  | Inserts formatted paragraphs `at: "beginning" \| "end"`, or `after` / `before` the paragraph containing quoted text.                                                                 |
| `docs.replaceMarkdown` | Replaces quoted text. Inline markdown replaces just the quote, so a heading stays a heading; block markdown replaces every paragraph the quote touches. Empty markdown deletes them. |
| `docs.comment`         | Adds a comment anchored to quoted text.                                                                                                                                              |

All write tools take `tabId` (default: first tab) and `mode: "edit" | "suggest"`.

### Supported markdown

| Markdown                                     | Becomes                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `#` … `######`                               | Heading 1–6                                                                 |
| `**bold**`, `*italic*`, `~~strike~~`         | Text styles                                                                 |
| `` `code` ``, fenced code blocks             | Courier New                                                                 |
| `[text](url)`                                | Link                                                                        |
| `- item`, `1. item`, nested with indentation | Native Docs bulleted and numbered lists                                     |
| `> quote`                                    | Indented paragraph                                                          |
| Pending suggestions (read only)              | `{++inserted++}` `{--deleted--}` ([CriticMarkup](https://criticmarkup.com)) |
| Tables                                       | Read only for now; writing one returns a clear error                        |

Known limits: nested items under a numbered list use Google's numbered preset, so they show as a., b., c.; list items with more than one paragraph aren't supported; images aren't written.

### How anchoring works

1. Fetch the document structure and flatten the tab into text, recording each character's real document index (table cells, chips and inline objects included).
2. Find the quote. If it doesn't match verbatim, retry with markdown markers and CriticMarkup stripped, so text copied from `readMarkdown` output works.
3. Convert the markdown to plain text plus paragraph and text styles, and build one request list: insert, reset inherited styles, apply styles, then create bullets last (back to front, because bullet creation removes the tabs that encode nesting).
4. Send it as a single `batchUpdate` with `requiredRevisionId`.

## Configuration

| Variable                                              | Purpose                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WORKSPACE_ACCOUNT`                                   | Name of the stored sign-in to use (one per Google account).                                         |
| `WORKSPACE_LOGIN_HINT`                                | Email address to preselect on the Google sign-in page.                                              |
| `WORKSPACE_CLIENT_ID`, `WORKSPACE_CLOUD_FUNCTION_URL` | Your own OAuth client and token-exchange endpoint (see below).                                      |
| `WORKSPACE_FEATURE_OVERRIDES`                         | Enable or disable tool groups (see [docs/feature-configuration.md](docs/feature-configuration.md)). |

## Privacy and authentication

Sign-in is standard Google OAuth with offline access. Because the server is a desktop app that can't keep a client secret, the authorization code is exchanged for tokens by a small hosted function that holds the secret. Tokens then live on your machine in the OS keychain; document content goes only between your machine and Google's APIs.

### Use your own OAuth app

By default, the OAuth client and the token-exchange function belong to the upstream [Gemini CLI Workspace extension](https://github.com/gemini-cli-extensions/workspace). To run your own instead:

1. Follow [docs/GCP-RECREATION.md](docs/GCP-RECREATION.md). Its script creates a Google Cloud project, configures the consent screen, stores the client secret in Secret Manager and deploys the exchange function from [`cloud_function/`](cloud_function).
2. Set `WORKSPACE_CLIENT_ID` and `WORKSPACE_CLOUD_FUNCTION_URL` in your MCP config's `env`.

A personal-use consent screen in "Testing" mode needs no Google verification; add your own accounts as test users. Testing-mode refresh tokens expire after 7 days, so you'll sign in again weekly unless you publish the app.

## Development

```bash
npm ci
npm run build
npm test -- -w 2          # cap Jest workers on low-memory machines
npm run lint && npm run format:check
node scripts/mcp-call.mjs list
node scripts/mcp-call.mjs call docs_readMarkdown '{"documentId":"<id>"}'
```

`scripts/mcp-call.mjs` starts the built server over stdio and calls one tool, which is handy for checking a change against a real document.

## FAQ

**Can Claude edit Google Docs?** Yes, with this server: Claude Code and Claude Desktop can read, insert, replace and comment in Google Docs. The built-in Google Drive connector creates docs but doesn't edit existing ones.

**How is this different from the official Google Docs MCP server?** Google's server (`docsmcp.googleapis.com`) is a developer preview available only to Google Workspace-domain accounts, and its write tool takes raw index-based `batchUpdate` requests. This server works with any Google account and takes markdown plus quoted anchors.

**Will it overwrite my document?** No. Edits are targeted, never a whole-document replace. Each edit is atomic and refuses to apply if the document changed since it was read. Use `mode: "suggest"` to review every change first.

**Does it work with document tabs?** Yes. Every tool takes an optional `tabId`.

## Credits and license

A fork of [gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace) (Apache-2.0, © Google LLC), which provides authentication and the general Workspace tools. The markdown layer, multi-account support and fixes are by Mark Henry, with AI assistance from Claude. An independent project, not affiliated with or endorsed by Google. Licensed under [Apache 2.0](LICENSE).

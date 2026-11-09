# Contributing

Issues and pull requests are welcome.

- **Bugs:** open an issue with the tool call (arguments), the error or wrong result, and if possible a minimal document that reproduces it. Don't paste private document content.
- **Pull requests:** keep them focused, and include a test. For a bug fix, add a failing test first. Run `npm run lint`, `npm run format:check` and `npm test -- -w 2` before pushing; CI runs the same checks on Linux, macOS and Windows.
- **Live checks:** `node scripts/mcp-call.mjs call <tool> '<json>'` runs one tool against a real document using your local sign-in. Use a scratch doc.

Changes that also make sense upstream (general Workspace tools, auth) are best proposed to [gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace) too.

By contributing you agree your contribution is licensed under the project's [Apache 2.0 license](LICENSE).

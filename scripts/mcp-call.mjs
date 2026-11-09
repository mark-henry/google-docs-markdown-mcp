#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

// Talk to the built server over stdio, for manual testing.
//   node scripts/mcp-call.mjs list
//   node scripts/mcp-call.mjs call docs_readMarkdown '{"documentId":"..."}'
// Prints only the tool's text result (or the tool list) on stdout.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(root, 'workspace-server/dist/index.js')],
  cwd: root,
  env: { ...process.env },
  stderr: 'ignore',
});
const client = new Client({ name: 'mcp-call', version: '0' });
await client.connect(transport);

const [cmd, tool, args] = process.argv.slice(2);
if (cmd === 'list') {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name);
} else if (cmd === 'call') {
  const result = await client.callTool(
    { name: tool, arguments: JSON.parse(args || '{}') },
    undefined,
    { timeout: 300000 },
  );
  for (const c of result.content) console.log(c.text);
  if (result.isError) process.exitCode = 1;
} else {
  console.error('usage: mcp-call.mjs list | call <tool> <json>');
  process.exitCode = 2;
}
await client.close();

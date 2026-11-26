/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skeleton for running the corpus against the REAL Google Docs API. Opt-in:
 * docsMarkdownRoundTrip.live.test.ts only runs it when GWM_LIVE_ROUNDTRIP=1.
 * Nothing here is wired to credentials; whoever turns it on supplies a client.
 */

import { docs_v1 } from 'googleapis';
import { markdownToDocs } from '../../../services/docsMarkdown/markdownToDocs';
import { flatten } from '../../../services/docsMarkdown/docIndex';
import { insertAfter } from '../../../services/docsMarkdown/buildRequests';
import { readMarkdown } from './roundTrip';

/** The few Docs operations the live round trip needs. */
export interface LiveDocsClient {
  /** Creates an empty throwaway doc and returns its id. */
  createDoc(title: string): Promise<string>;
  getDoc(documentId: string): Promise<docs_v1.Schema$Document>;
  batchUpdate(
    documentId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<void>;
  /** Trashes the throwaway doc. */
  deleteDoc(documentId: string): Promise<void>;
}

/**
 * TODO(whoever enables live mode): return a LiveDocsClient backed by an
 * authenticated googleapis client for a scratch account. Deliberately
 * unimplemented so the default build has no path to the network.
 */
export function makeLiveClient(): LiveDocsClient {
  throw new Error(
    'Live mode is a skeleton: implement makeLiveClient() in live.ts with your own credentials.',
  );
}

/** Same contract as roundTrip(), against a real doc that is trashed afterward. */
export async function liveRoundTrip(
  client: LiveDocsClient,
  markdown: string,
): Promise<string> {
  const id = await client.createDoc('gwm round-trip harness');
  try {
    const before = await client.getDoc(id);
    const flat = flatten(before.body?.content);
    const bodyParas = flat.paragraphs.filter((p) => p.container === 'body');
    const edit = insertAfter(
      markdownToDocs(markdown),
      bodyParas[bodyParas.length - 1],
    );
    await client.batchUpdate(id, edit.requests);
    return readMarkdown(await client.getDoc(id));
  } finally {
    await client.deleteDoc(id);
  }
}

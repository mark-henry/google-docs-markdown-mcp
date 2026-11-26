/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

// OPT-IN. Skipped unless GWM_LIVE_ROUNDTRIP=1, and even then it needs
// makeLiveClient() implemented (it throws by default). Never runs in CI or
// in a plain `npx jest`.
import { describe, it, expect } from '@jest/globals';
import { CORPUS, EXPECTED_DIFFERENCES } from './docsMarkdownHarness/corpus';
import { normalize } from './docsMarkdownHarness/roundTrip';
import { liveRoundTrip, makeLiveClient } from './docsMarkdownHarness/live';

const live = process.env.GWM_LIVE_ROUNDTRIP === '1' ? describe : describe.skip;

live('docsMarkdown round trip against the real Docs API', () => {
  const expected = new Map(EXPECTED_DIFFERENCES.map((d) => [d.fixture, d]));
  it.each(CORPUS.map((f) => [f.name, f.markdown]))(
    '%s',
    async (name, markdown) => {
      const out = normalize(await liveRoundTrip(makeLiveClient(), markdown));
      // Live drifts may differ from the fake's; compare with the input only
      // and treat a fixture listed as drifting as informational.
      if (expected.has(name)) return;
      expect(out).toBe(normalize(markdown));
    },
    60000,
  );
});

/**
 * @license
 * Copyright 2026 Mark Henry
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { describe, it, expect } from '@jest/globals';
import { CORPUS, EXPECTED_DIFFERENCES } from './docsMarkdownHarness/corpus';
import {
  normalize,
  roundTripDetailed,
} from './docsMarkdownHarness/roundTrip';

// GWM_PRINT_DRIFTS=<file> writes every fixture whose read-back differs, as
// EXPECTED_DIFFERENCES-ready JSON, to help record or update drift entries
// (jest's setup silences console, so it goes to a file).
const PRINT = !!process.env.GWM_PRINT_DRIFTS;
const PRINT_FILE = process.env.GWM_PRINT_DRIFTS ?? '';

describe('docsMarkdown round trip (fake Docs)', () => {
  const expected = new Map(EXPECTED_DIFFERENCES.map((d) => [d.fixture, d]));

  it('has unique fixture names and no dangling expected differences', () => {
    const names = CORPUS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of EXPECTED_DIFFERENCES) {
      expect(names).toContain(d.fixture);
      expect(d.reason.length).toBeGreaterThan(10);
    }
    expect(expected.size).toBe(EXPECTED_DIFFERENCES.length);
  });

  if (PRINT) {
    it('prints drifts', () => {
      const rows = CORPUS.flatMap((f) => {
        const out = normalize(roundTripDetailed(f.markdown).markdown);
        return out === normalize(f.markdown)
          ? []
          : [{ fixture: f.name, actual: out }];
      });
      fs.writeFileSync(PRINT_FILE, JSON.stringify(rows, null, 2));
    });
  }

  it('reports an inserted range that matches the doc', () => {
    const bad: string[] = [];
    for (const f of CORPUS) {
      const { doc, edit } = roundTripDetailed(f.markdown);
      const content = doc.toDocument().body!.content!;
      const docEnd = content[content.length - 1].endIndex!;
      if (edit.inserted.startIndex !== 1 || edit.inserted.endIndex !== docEnd) {
        bad.push(
          `${f.name}: inserted ${JSON.stringify(edit.inserted)}, doc ends at ${docEnd}`,
        );
      }
    }
    expect(bad).toEqual([]);
  });

  describe.each(CORPUS.map((f) => [f.name, f.markdown]))('%s', (name, markdown) => {
    const drift = expected.get(name);
    const input = normalize(markdown);

    if (drift) {
      it(`drifts exactly as recorded (${drift.reason.slice(0, 60)})`, () => {
        const { markdown: out } = roundTripDetailed(markdown);
        // If this fails because the output now equals the input, the drift
        // was fixed: delete the entry in corpus.ts.
        expect(normalize(out)).not.toBe(input);
        expect(normalize(out)).toBe(drift.actual);
      });
    } else {
      it('round-trips unchanged', () => {
        const { markdown: out } = roundTripDetailed(markdown);
        expect(normalize(out)).toBe(input);
      });
    }
  });
});

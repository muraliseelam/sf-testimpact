/**
 * Parsing `sf apex test run -r human` output.
 *
 * This is the format public CI actually emits. apex-recipes runs
 * `sf apex test run -c -r human -d ./tests/apex -w 20`, and the machine-readable files it
 * writes to `./tests/apex` are never uploaded as an artifact — the only surviving record of
 * per-test outcomes is the human table in the GitHub Actions log. Being able to parse it is
 * what makes that history usable as ground truth (see docs/CORRECTNESS-PLAN.md).
 *
 * The fixture is a verbatim excerpt of a real apex-recipes CI log, run 30013068817, with the
 * Actions timestamp prefix stripped and the middle of the table elided.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAdapter, sfHumanAdapter, adapterById } from '../../src/bench/adapters.js';

const fixture = readFileSync(
  join(import.meta.dirname, '../fixtures/test-results/sf-apex-human.txt'),
  'utf8',
);

describe('sfHumanAdapter against a real CI log', () => {
  const parsed = sfHumanAdapter.parse(fixture);

  it('is selected by detection', () => {
    expect(detectAdapter(fixture)?.id).toBe('sf-human');
    expect(adapterById('sf-human')).toBe(sfHumanAdapter);
  });

  it('reads every test row and nothing else', () => {
    // 12 data rows in the fixture. The header, the box-drawing rule, the blank lines and
    // the whole `=== Test Summary` block must all be excluded.
    expect(parsed.results).toHaveLength(12);
  });

  it('splits Class.method correctly', () => {
    expect(parsed.results[0]).toEqual({
      className: 'PlatformCacheBuilderRecipes_Tests',
      methodName: 'testPlatformCacheBuilderRecipesPositiveColdCache',
      outcome: 'Pass',
      durationMs: 550,
    });
  });

  it('does not mistake the summary table for test rows', () => {
    // The summary contains rows like "Outcome  Passed" and "Pass Rate  100%". None of them
    // is a test, and a parser that let them through would invent a class called "Outcome".
    const names = parsed.results.map((r) => r.className);
    expect(names).not.toContain('Outcome');
    expect(names).not.toContain('Pass');
    expect(names).not.toContain('NAME');
    expect(names.every((n) => n.endsWith('_Tests'))).toBe(true);
  });

  it('records no commit, because the format carries none', () => {
    // Guessing one from the surrounding log would be a fabricated association between a
    // result and a revision, which is the one thing this harness must never do.
    expect(parsed.commit).toBeNull();
  });
});

describe('outcomes other than Pass', () => {
  // The real log is 100% passing — public repositories keep their default branch green,
  // which is precisely the sampling problem documented in docs/CORRECTNESS-PLAN.md. Failure
  // and skip rows are therefore exercised against a synthetic table in the same layout.
  const table = [
    'TEST NAME                                          OUTCOME  MESSAGE                    RUNTIME (MS)',
    '─────────────────────────────────────────────────  ───────  ─────────────────────────  ────────────',
    'AccountServiceTest.testInsertPositive              Pass                                42          ',
    'AccountServiceTest.testInsertNegative              Fail     System.AssertException: x  17          ',
    'LegacyTest.testSkipped                             Skip                                            ',
    '',
    '=== Test Summary',
    'NAME                 VALUE',
    'Outcome              Failed',
    'Tests Ran            3',
  ].join('\n');

  const parsed = sfHumanAdapter.parse(table);

  it('reads all three outcome kinds', () => {
    expect(parsed.results.map((r) => r.outcome)).toEqual(['Pass', 'Fail', 'Skip']);
  });

  it('keeps a failure message out of the class name and the duration', () => {
    const failure = parsed.results[1];
    expect(failure?.className).toBe('AccountServiceTest');
    expect(failure?.methodName).toBe('testInsertNegative');
    expect(failure?.durationMs).toBe(17);
  });

  it('reports a missing duration as null rather than zero', () => {
    // Zero would be a measurement this format never made.
    expect(parsed.results[2]?.durationMs).toBeNull();
  });
});

describe('detection does not misfire on the other formats', () => {
  it('rejects sf JSON', () => {
    const json = '{"result":{"tests":[{"FullName":"A.b","Outcome":"Pass"}]}}';
    expect(sfHumanAdapter.detect(json)).toBe(false);
  });

  it('rejects JUnit XML', () => {
    expect(sfHumanAdapter.detect('<testsuites><testsuite name="x"/></testsuites>')).toBe(false);
  });

  it('rejects an empty document', () => {
    expect(sfHumanAdapter.detect('')).toBe(false);
    expect(sfHumanAdapter.parse('').results).toEqual([]);
  });
});

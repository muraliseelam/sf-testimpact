/**
 * Historical test-result ingest (DESIGN.md 11.1).
 *
 * Adapters are registered in a map, not switched on inline, so a team with a bespoke CI
 * format adds one file and changes no core code.
 *
 * `durationMs: null` is load-bearing. A format without timings must propagate that fact so
 * the harness reports test *counts* only, rather than silently multiplying by an invented
 * average and presenting the result as measured minutes saved.
 */

import { XMLParser } from 'fast-xml-parser';

export type TestOutcomeStatus = 'Pass' | 'Fail' | 'Skip';

export interface TestOutcome {
  readonly className: string;
  readonly methodName: string;
  readonly outcome: TestOutcomeStatus;
  /** Null when the source format carries no timing. Never defaulted to a number. */
  readonly durationMs: number | null;
}

export interface TestRunResult {
  /** Commit the run belongs to, when the format records it. */
  readonly commit: string | null;
  readonly results: readonly TestOutcome[];
}

export interface TestResultAdapter {
  readonly id: string;
  /** Cheap sniff: does this text look like our format? */
  detect(contents: string): boolean;
  parse(contents: string): TestRunResult;
}

// ---------------------------------------------------------------------------------------
// sf apex run test --json
// ---------------------------------------------------------------------------------------

interface SfJsonTest {
  readonly ApexClass?: { readonly Name?: string };
  readonly MethodName?: string;
  readonly Outcome?: string;
  readonly RunTime?: number;
  readonly FullName?: string;
}

interface SfJsonDoc {
  readonly result?: { readonly tests?: SfJsonTest[] };
  readonly tests?: SfJsonTest[];
}

function normaliseOutcome(raw: string | undefined): TestOutcomeStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'pass':
    case 'passed':
      return 'Pass';
    case 'fail':
    case 'failed':
    case 'compilefail':
      return 'Fail';
    default:
      return 'Skip';
  }
}

export const sfJsonAdapter: TestResultAdapter = {
  id: 'sf-json',

  detect(contents) {
    const trimmed = contents.trimStart();
    if (!trimmed.startsWith('{')) return false;
    return trimmed.includes('"tests"') && (trimmed.includes('"Outcome"') || trimmed.includes('"ApexClass"'));
  },

  parse(contents) {
    const doc = JSON.parse(contents) as SfJsonDoc;
    const tests = doc.result?.tests ?? doc.tests ?? [];
    const results: TestOutcome[] = [];

    for (const test of tests) {
      // `FullName` is `Class.method`; ApexClass.Name plus MethodName is the richer form.
      const fromFullName = (test.FullName ?? '').split('.');
      const className = test.ApexClass?.Name ?? fromFullName[0] ?? '';
      const methodName = test.MethodName ?? fromFullName[1] ?? '';
      if (className === '') continue;

      results.push({
        className,
        methodName,
        outcome: normaliseOutcome(test.Outcome),
        // `RunTime` is milliseconds. Absent means absent, not zero.
        durationMs: typeof test.RunTime === 'number' ? test.RunTime : null,
      });
    }
    return { commit: null, results };
  },
};

// ---------------------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------------------

const junitParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function attr(node: unknown, name: string): string | null {
  if (!isRecord(node)) return null;
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value : null;
}

export const junitXmlAdapter: TestResultAdapter = {
  id: 'junit-xml',

  detect(contents) {
    return /<testsuites?[\s>]/i.test(contents);
  },

  parse(contents) {
    const doc: unknown = junitParser.parse(contents);
    const results: TestOutcome[] = [];

    const suites = isRecord(doc)
      ? [...asArray(isRecord(doc['testsuites']) ? doc['testsuites']['testsuite'] : undefined), ...asArray(doc['testsuite'])]
      : [];

    for (const suite of suites) {
      const suiteName = attr(suite, 'name') ?? '';
      for (const testCase of asArray(isRecord(suite) ? suite['testcase'] : undefined)) {
        if (!isRecord(testCase)) continue;
        // JUnit's `classname` is the class; `name` is the method.
        const className = attr(testCase, 'classname') ?? suiteName;
        const methodName = attr(testCase, 'name') ?? '';
        if (className === '') continue;

        const failed = 'failure' in testCase || 'error' in testCase;
        const skipped = 'skipped' in testCase;
        const time = attr(testCase, 'time');
        const seconds = time === null ? null : Number.parseFloat(time);

        results.push({
          className,
          methodName,
          outcome: failed ? 'Fail' : skipped ? 'Skip' : 'Pass',
          durationMs: seconds === null || Number.isNaN(seconds) ? null : Math.round(seconds * 1000),
        });
      }
    }
    return { commit: null, results };
  },
};

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

export const ADAPTERS: ReadonlyMap<string, TestResultAdapter> = new Map([
  [sfJsonAdapter.id, sfJsonAdapter],
  [junitXmlAdapter.id, junitXmlAdapter],
]);

export function adapterById(id: string): TestResultAdapter | undefined {
  return ADAPTERS.get(id);
}

/** The first adapter that recognises this content, or null. */
export function detectAdapter(contents: string): TestResultAdapter | null {
  for (const adapter of ADAPTERS.values()) {
    if (adapter.detect(contents)) return adapter;
  }
  return null;
}

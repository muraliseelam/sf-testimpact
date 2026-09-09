/**
 * The org execution driver, exercised entirely with fakes.
 *
 * Every dependency that touches an org or the working tree is injected, so none of these
 * tests needs credentials. That is the design's point: stage 3 is the only part of the
 * harness that cannot run offline, and it is written so its *logic* can.
 *
 * The cases that matter are the unhappy ones. A deploy failure recorded as a clean pass, or a
 * flaky re-run overwriting a real failure, would each produce a plausible number that is
 * wrong in the direction that flatters the tool.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  executeWindow,
  makeCliTestRunner,
  redactSecrets,
  type ExecuteDeps,
} from '../../src/bench/execute.js';
import {
  openStore,
  type AppendOnlyFileSystem,
  type WindowIdentity,
} from '../../src/bench/observationStore.js';
import type { TestOutcome } from '../../src/bench/adapters.js';

const WINDOW: WindowIdentity = {
  repo: 'example/repo',
  baseSha: 'base',
  headSha: 'head',
  commitCount: 3,
};
const PATH = 'store.ndjson';

function memoryFs() {
  const files = new Map<string, string>();
  const fs: AppendOnlyFileSystem = {
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    appendFile: (p, c) => files.set(p, (files.get(p) ?? '') + c),
    exists: (p) => files.has(p),
    mkdirp: () => undefined,
  };
  return fs;
}

const pass = (cls: string, m: string): TestOutcome => ({ className: cls, methodName: m, outcome: 'Pass', durationMs: 5 });
const fail = (cls: string, m: string): TestOutcome => ({ className: cls, methodName: m, outcome: 'Fail', durationMs: 5 });

/** A deps object where everything succeeds; individual tests override one piece. */
function deps(overrides: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    deploy: () => ({ ok: true }),
    runTests: () => ({ ok: true, results: [pass('AccountTest', 'a'), pass('OrderTest', 'b')] }),
    select: () => ({ selected: ['AccountTest'], fellBack: false, totalTests: 2 }),
    ...overrides,
  };
}

const newStore = () => openStore(memoryFs(), PATH, WINDOW).store;

describe('a clean commit', () => {
  it('deploys, runs and records', () => {
    const store = newStore();
    const report = executeWindow(deps(), store, ['c1']);

    expect(report.recorded).toBe(1);
    expect(report.excluded).toEqual([]);
    expect(store.all()[0]).toMatchObject({
      commit: 'c1',
      selected: ['AccountTest'],
      fellBack: false,
      totalTests: 2,
    });
  });

  it('runs the FULL suite, not the selection', () => {
    // The metric is defined over tests the selector skipped. Running only the selection
    // would make a false negative impossible to observe, so the driver must never pass the
    // selected list to the first run.
    const runTests = vi.fn(() => ({ ok: true, results: [pass('AccountTest', 'a')] }));
    executeWindow(deps({ runTests }), newStore(), ['c1']);

    expect(runTests).toHaveBeenCalledTimes(1);
    expect(runTests.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('records every reported outcome, including tests it did not select', () => {
    const store = newStore();
    executeWindow(deps(), store, ['c1']);
    expect(store.all()[0]?.results.map((r) => r.className)).toEqual(['AccountTest', 'OrderTest']);
  });
});

describe('a commit with failures', () => {
  it('keeps the failure when the re-run reproduces it', () => {
    const runTests = vi
      .fn()
      .mockReturnValueOnce({ ok: true, results: [pass('AccountTest', 'a'), fail('OrderTest', 'b')] })
      .mockReturnValueOnce({ ok: true, results: [fail('OrderTest', 'b')] });

    const store = newStore();
    const report = executeWindow(deps({ runTests }), store, ['c1']);

    expect(report.flakyObserved).toEqual([]);
    expect(store.all()[0]?.results.find((r) => r.className === 'OrderTest')?.outcome).toBe('Fail');
    expect(store.all()[0]?.flakyHere).toBeUndefined();
  });

  it('re-runs only the failing tests', () => {
    const runTests = vi
      .fn()
      .mockReturnValueOnce({ ok: true, results: [pass('AccountTest', 'a'), fail('OrderTest', 'b')] })
      .mockReturnValueOnce({ ok: true, results: [fail('OrderTest', 'b')] });

    executeWindow(deps({ runTests }), newStore(), ['c1']);
    expect(runTests.mock.calls[1]?.[1]).toEqual(['OrderTest.b']);
  });

  it('does not re-run anything when nothing failed', () => {
    const runTests = vi.fn(() => ({ ok: true, results: [pass('AccountTest', 'a')] }));
    executeWindow(deps({ runTests }), newStore(), ['c1']);
    expect(runTests).toHaveBeenCalledTimes(1);
  });
});

describe('flaky tests', () => {
  it('marks a test flaky when it fails then passes at the same commit', () => {
    const runTests = vi
      .fn()
      .mockReturnValueOnce({ ok: true, results: [fail('OrderTest', 'b')] })
      .mockReturnValueOnce({ ok: true, results: [pass('OrderTest', 'b')] });

    const store = newStore();
    const report = executeWindow(deps({ runTests }), store, ['c1']);

    expect(report.flakyObserved).toEqual([{ commit: 'c1', test: 'OrderTest.b' }]);
    expect(store.all()[0]?.flakyHere).toEqual(['OrderTest.b']);
  });

  it('does NOT overwrite the recorded failure with the re-run pass', () => {
    // The first run is the observation; the re-run only answers "was that reproducible".
    // Replacing Fail with the retry's Pass would erase the very failure the metric counts.
    const runTests = vi
      .fn()
      .mockReturnValueOnce({ ok: true, results: [fail('OrderTest', 'b')] })
      .mockReturnValueOnce({ ok: true, results: [pass('OrderTest', 'b')] });

    const store = newStore();
    executeWindow(deps({ runTests }), store, ['c1']);
    expect(store.all()[0]?.results[0]?.outcome).toBe('Fail');
  });

  it('leaves flakiness unrecorded when the re-check itself fails', () => {
    // "The re-check did not run" is not the same as "not flaky", and must not be recorded
    // as the latter.
    const runTests = vi
      .fn()
      .mockReturnValueOnce({ ok: true, results: [fail('OrderTest', 'b')] })
      .mockReturnValueOnce({ ok: false, results: [], reason: 'org timeout' });

    const store = newStore();
    const report = executeWindow(deps({ runTests }), store, ['c1']);

    expect(report.flakyObserved).toEqual([]);
    expect(store.all()[0]?.flakyHere).toBeUndefined();
    expect(store.all()[0]?.results[0]?.outcome).toBe('Fail');
  });

  it('can be turned off', () => {
    const runTests = vi.fn(() => ({ ok: true, results: [fail('OrderTest', 'b')] }));
    executeWindow(deps({ runTests }), newStore(), ['c1'], { recheckFailures: false });
    expect(runTests).toHaveBeenCalledTimes(1);
  });
});

describe('commits that cannot be measured', () => {
  it('records a deploy failure as excluded, with the reason, and continues', () => {
    const deploy = vi.fn((commit: string) =>
      commit === 'c2' ? { ok: false, reason: 'Component Failures [2]' } : { ok: true },
    );

    const store = newStore();
    const report = executeWindow(deps({ deploy }), store, ['c1', 'c2', 'c3']);

    expect(report.recorded).toBe(2);
    expect(report.excluded).toEqual([
      { commit: 'c2', reason: 'deploy failed: Component Failures [2]' },
    ]);
    expect(store.all().map((c) => c.commit)).toEqual(['c1', 'c2', 'c3']);
    expect(store.toObservations().map((o) => o.commit)).toEqual(['c1', 'c3']);
  });

  it('records a test-run failure as excluded', () => {
    const runTests = vi.fn(() => ({ ok: false, results: [], reason: 'scratch org limit reached' }));
    const store = newStore();
    const report = executeWindow(deps({ runTests }), store, ['c1']);

    expect(report.excluded).toEqual([
      { commit: 'c1', reason: 'test run failed: scratch org limit reached' },
    ]);
    expect(store.toObservations()).toEqual([]);
  });

  it('excludes a run that succeeds but reports no outcomes', () => {
    // Recording this as a clean commit would be a fabricated pass: we do not have the
    // outcomes, we merely failed to receive any.
    const runTests = vi.fn(() => ({ ok: true, results: [] }));
    const store = newStore();
    const report = executeWindow(deps({ runTests }), store, ['c1']);

    expect(report.excluded).toEqual([{ commit: 'c1', reason: 'test run reported no outcomes' }]);
    expect(report.recorded).toBe(0);
  });

  it('does not run tests when the deploy failed', () => {
    const runTests = vi.fn(() => ({ ok: true, results: [pass('A', 'a')] }));
    executeWindow(
      deps({ deploy: () => ({ ok: false, reason: 'bad metadata' }), runTests }),
      newStore(),
      ['c1'],
    );
    expect(runTests).not.toHaveBeenCalled();
  });

  it('reports no reason as such rather than inventing one', () => {
    const store = newStore();
    const report = executeWindow(deps({ deploy: () => ({ ok: false }) }), store, ['c1']);
    expect(report.excluded[0]?.reason).toBe('deploy failed: no reason reported');
  });
});

describe('resume', () => {
  it('skips commits already in the store and does not redeploy them', () => {
    const fs = memoryFs();
    const first = openStore(fs, PATH, WINDOW).store;
    executeWindow(deps(), first, ['c1', 'c2']);

    const deploy = vi.fn(() => ({ ok: true }));
    const resumed = openStore(fs, PATH, WINDOW).store;
    const report = executeWindow(deps({ deploy }), resumed, ['c1', 'c2', 'c3']);

    expect(report.skippedAlreadyRecorded).toBe(2);
    expect(report.recorded).toBe(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith('c3');
    expect(resumed.recordedCommits()).toEqual(['c1', 'c2', 'c3']);
  });

  it('does not retry a commit that was excluded on the previous run', () => {
    // An excluded commit is recorded, so resume treats it as done. Retrying it would make
    // the run non-terminating on a commit that simply cannot be deployed.
    const fs = memoryFs();
    const one = openStore(fs, PATH, WINDOW).store;
    executeWindow(deps({ deploy: () => ({ ok: false, reason: 'bad metadata' }) }), one, ['c1']);

    const deploy = vi.fn(() => ({ ok: true }));
    const two = openStore(fs, PATH, WINDOW).store;
    const report = executeWindow(deps({ deploy }), two, ['c1']);

    expect(report.skippedAlreadyRecorded).toBe(1);
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe('baseline commit', () => {
  it('records outcomes but no selection for the first commit when asked', () => {
    // The first commit has no predecessor, so there is no selection to score against it -
    // but its outcomes are still the baseline the second commit is compared to.
    const select = vi.fn(() => ({ selected: ['AccountTest'], fellBack: false, totalTests: 2 }));
    const store = newStore();
    executeWindow(deps({ select }), store, ['c1', 'c2'], { firstCommitIsBaseline: true });

    expect(store.all()[0]).toMatchObject({ commit: 'c1', baselineOnly: true, selected: [], totalTests: 0 });
    expect(store.all()[0]?.results).toHaveLength(2);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith('c2');
  });

  it('scores every commit when the option is off', () => {
    const store = newStore();
    executeWindow(deps(), store, ['c1', 'c2']);
    expect(store.all().every((c) => c.baselineOnly === undefined)).toBe(true);
  });
});

describe('progress reporting', () => {
  it('logs each commit and each exclusion', () => {
    const lines: string[] = [];
    executeWindow(
      deps({ deploy: () => ({ ok: false, reason: 'nope' }), log: (m) => lines.push(m) }),
      newStore(),
      ['c1'],
    );
    expect(lines.some((l) => l.includes('[1/1] c1'))).toBe(true);
    expect(lines.some((l) => l.includes('excluded: deploy failed: nope'))).toBe(true);
  });

  it('is silent by default', () => {
    expect(() => executeWindow(deps(), newStore(), ['c1'])).not.toThrow();
  });
});

describe('an empty window', () => {
  it('does nothing and reports nothing', () => {
    const report = executeWindow(deps(), newStore(), []);
    expect(report).toEqual({
      attempted: 0,
      recorded: 0,
      skippedAlreadyRecorded: 0,
      excluded: [],
      flakyObserved: [],
    });
  });
});

describe('credential hygiene', () => {
  it.each([
    ['access token', 'INVALID_SESSION_ID: 00D5f000005abcD!AQEAQAbCdEf.gHiJkLmNoPqRsTuVwXyZ012345', '[redacted-access-token]'],
    ['refresh token', 'refresh 5Aep861ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', '[redacted-refresh-token]'],
    ['instance url', 'at https://my-dev-ed.my.salesforce.com/services/data/v62.0', '[redacted-instance-url]'],
    ['sfdx auth url', 'sfdxAuthUrl:force://PlatformCLI::5Aep@my.salesforce.com', '[redacted-auth-url]'],
  ])('redacts %s from text bound for an artifact', (_label, text, marker) => {
    const redacted = redactSecrets(text);
    expect(redacted).toContain(marker);
    expect(redacted).not.toContain('5Aep861ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(redacted).not.toMatch(/00D5f000005abcD!AQ/);
  });

  it('leaves ordinary failure text alone', () => {
    const text = 'deploy failed: Component Failures [2] FlexiPage Experience_Record_Page';
    expect(redactSecrets(text)).toBe(text);
  });

  it('redacts a token that arrives in a deploy failure reason', () => {
    // The reason is captured from CLI stderr, which is exactly where a token appears when
    // authentication goes wrong, and it is written straight into the store.
    const store = newStore();
    executeWindow(
      deps({
        deploy: () => ({
          ok: false,
          reason: 'INVALID_SESSION_ID 00D5f000005abcD!AQEAQAbCdEf.gHiJkLmNoPqRsTuVwXyZ012345',
        }),
      }),
      store,
      ['c1'],
    );
    const written = store.all()[0]?.excluded ?? '';
    expect(written).toContain('[redacted-access-token]');
    expect(written).not.toContain('AQEAQAbCdEf');
  });
});

describe('makeCliTestRunner', () => {
  const SF_JSON = JSON.stringify({
    result: {
      tests: [
        { FullName: 'AccountTest.testOne', Outcome: 'Pass', RunTime: 12 },
        { FullName: 'OrderTest.testTwo', Outcome: 'Fail', RunTime: 8 },
      ],
    },
  });

  it('runs the whole local suite when no subset is given', () => {
    const run = vi.fn(() => SF_JSON);
    const runner = makeCliTestRunner(run);
    const result = runner('c1');

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.className)).toEqual(['AccountTest', 'OrderTest']);
    expect(run.mock.calls[0]?.[0]).toContain('RunLocalTests');
  });

  it('repeats --tests per test when re-running a subset', () => {
    // A comma-separated list is rejected by `sf project deploy start` and by `sf apex run
    // test`; repeating the flag is the documented form.
    const run = vi.fn(() => SF_JSON);
    makeCliTestRunner(run)('c1', ['A.a', 'B.b']);
    const argv = run.mock.calls[0]?.[0] ?? [];
    expect(argv).toContain('RunSpecifiedTests');
    expect(argv.filter((a) => a === '--tests')).toHaveLength(2);
    expect(argv.join(' ')).not.toContain('A.a,B.b');
  });

  it('reports a command failure rather than throwing', () => {
    const runner = makeCliTestRunner(() => {
      throw new Error('sf exited 1');
    });
    const result = runner('c1');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sf exited 1');
  });

  it('redacts credentials out of a command failure', () => {
    const runner = makeCliTestRunner(() => {
      throw new Error('auth failed for https://my-dev-ed.my.salesforce.com/services/oauth2/token');
    });
    expect(runner('c1').reason).toContain('[redacted-instance-url]');
  });

  it('reports unparseable output rather than pretending the suite passed', () => {
    const result = makeCliTestRunner(() => 'not json at all')('c1');
    expect(result.ok).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.reason).toContain('could not parse test output');
  });
});

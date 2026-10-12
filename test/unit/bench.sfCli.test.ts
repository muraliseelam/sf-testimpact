/**
 * The `sf` CLI seam, tested with recorded process outcomes and no org.
 *
 * The cases that matter are the ones where the obvious reading of a process result is wrong
 * in the direction that flatters the tool: a failing test run mistaken for a broken one
 * (which would exclude every commit with a regression), and a deploy failure recorded with a
 * credential in its reason.
 */

import { describe, expect, it } from 'vitest';
import { makeCliTestRunner } from '../../src/bench/execute.js';
import {
  deployResultFromProcess,
  parseRevList,
  parseSfJson,
  testRunStdoutFromProcess,
  toSelection,
  windowFor,
  type ProcessOutcome,
} from '../../src/bench/sfCli.js';
import type { AnalysisResult } from '../../src/query/analyze.js';

const proc = (status: number | null, stdout = '', stderr = '', error?: string): ProcessOutcome => ({
  status,
  stdout,
  stderr,
  ...(error === undefined ? {} : { error }),
});

const TESTS_JSON = JSON.stringify({
  status: 100,
  result: {
    summary: { outcome: 'Failed', testsRan: 2, passing: 1, failing: 1 },
    tests: [
      { FullName: 'AccountTest.a', Outcome: 'Pass', RunTime: 12 },
      { FullName: 'OrderTest.b', Outcome: 'Fail', RunTime: 8 },
    ],
  },
});

describe('parseSfJson', () => {
  it('parses a clean envelope', () => {
    expect(parseSfJson('{"status":0,"result":{"success":true}}')).toEqual({ status: 0, result: { success: true } });
  });

  it('tolerates a notice printed before the JSON', () => {
    expect(parseSfJson('Warning: a newer version is available\n{"status":0}')).toEqual({ status: 0 });
  });

  it('returns null for non-JSON and for a JSON array', () => {
    expect(parseSfJson('not json')).toBeNull();
    expect(parseSfJson('{"broken":')).toBeNull();
    expect(parseSfJson('[1,2]')).toBeNull();
    expect(parseSfJson('')).toBeNull();
  });
});

describe('deployResultFromProcess', () => {
  it('treats exit 0 as success whatever the payload looks like', () => {
    // A tracked deploy with nothing to deploy exits 0 with no `success` field.
    expect(deployResultFromProcess(proc(0, '{"status":0,"result":{"status":"Nothing to deploy"}}'))).toEqual({ ok: true });
    expect(deployResultFromProcess(proc(0, ''))).toEqual({ ok: true });
  });

  it('treats a non-zero exit with success:true in the payload as success', () => {
    expect(deployResultFromProcess(proc(1, '{"status":1,"result":{"success":true}}'))).toEqual({ ok: true });
  });

  it('names the component failures', () => {
    const stdout = JSON.stringify({
      status: 1,
      result: {
        success: false,
        details: {
          componentFailures: [
            { componentType: 'ApexClass', fullName: 'Foo', problem: 'Variable does not exist: bar' },
            { componentType: 'Flow', fullName: 'PersonalizedSchedule', problem: 'Invalid flow' },
          ],
        },
      },
    });
    const result = deployResultFromProcess(proc(1, stdout));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2 component failure(s)');
    expect(result.reason).toContain('ApexClass Foo: Variable does not exist: bar');
    expect(result.reason).toContain('Flow PersonalizedSchedule: Invalid flow');
  });

  it('accepts a single component failure that is not wrapped in an array', () => {
    const stdout = JSON.stringify({
      status: 1,
      result: { success: false, details: { componentFailures: { componentType: 'ApexClass', fullName: 'Foo', problem: 'x' } } },
    });
    expect(deployResultFromProcess(proc(1, stdout)).reason).toContain('1 component failure(s): ApexClass Foo: x');
  });

  it('summarises beyond five failures instead of listing all of them', () => {
    const failures = Array.from({ length: 8 }, (_, i) => ({ componentType: 'ApexClass', fullName: `C${i}`, problem: 'p' }));
    const stdout = JSON.stringify({ status: 1, result: { success: false, details: { componentFailures: failures } } });
    const reason = deployResultFromProcess(proc(1, stdout)).reason ?? '';
    expect(reason).toContain('8 component failure(s)');
    expect(reason).toContain('(and 3 more)');
    expect(reason).not.toContain('C7');
  });

  it('falls back to the CLI message, then stderr, then the exit status', () => {
    expect(deployResultFromProcess(proc(1, '{"status":1,"name":"NoOrgFound","message":"No default environment found."}')).reason).toBe(
      'NoOrgFound: No default environment found.',
    );
    expect(deployResultFromProcess(proc(1, 'garbage', 'Error: boom')).reason).toBe('Error: boom');
    expect(deployResultFromProcess(proc(7, '', '')).reason).toBe('sf exited with status 7 and no output');
    expect(deployResultFromProcess(proc(null, '', '')).reason).toBe('sf exited with status unknown and no output');
  });

  it('reports a process that never ran', () => {
    const result = deployResultFromProcess(proc(null, '', '', 'spawnSync sf ENOENT'));
    expect(result).toEqual({ ok: false, reason: 'sf did not run: spawnSync sf ENOENT' });
  });

  it('redacts credentials out of every reason path', () => {
    const url = 'https://my-dev-ed.my.salesforce.com/services/oauth2/token';
    const viaMessage = deployResultFromProcess(proc(1, JSON.stringify({ status: 1, message: `auth failed at ${url}` })));
    const viaStderr = deployResultFromProcess(proc(1, '', `refresh 5Aep861ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij failed`));
    const viaFailure = deployResultFromProcess(
      proc(1, JSON.stringify({ status: 1, result: { success: false, details: { componentFailures: [{ problem: `see ${url}` }] } } })),
    );
    for (const r of [viaMessage, viaStderr, viaFailure]) {
      expect(r.reason).not.toContain('my-dev-ed');
      expect(r.reason).not.toContain('5Aep861ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    }
    expect(viaMessage.reason).toContain('[redacted-instance-url]');
    expect(viaStderr.reason).toContain('[redacted-refresh-token]');
  });

  it('clips a very long reason so the store stays readable', () => {
    const reason = deployResultFromProcess(proc(1, '', 'x'.repeat(5000))).reason ?? '';
    expect(reason.length).toBeLessThan(700);
    expect(reason.endsWith('…')).toBe(true);
  });
});

describe('testRunStdoutFromProcess', () => {
  it('returns the output of a run that completed with failures, despite the non-zero exit', () => {
    // This is the case that matters. `sf apex run test` exits 100 when a test fails; treating
    // that as a broken run would exclude every commit the metric is built from.
    expect(testRunStdoutFromProcess(proc(100, TESTS_JSON, 'Test run failed'))).toBe(TESTS_JSON);
  });

  it('returns stdout on exit 0 even when it is not recognisable', () => {
    expect(testRunStdoutFromProcess(proc(0, 'odd output'))).toBe('odd output');
  });

  it('accepts the bare --result-format json shape too', () => {
    const bare = JSON.stringify({ summary: {}, tests: [{ FullName: 'A.a', Outcome: 'Pass' }] });
    expect(testRunStdoutFromProcess(proc(100, bare))).toBe(bare);
  });

  it('throws, naming the CLI message, when a non-zero run carried no results', () => {
    const stdout = JSON.stringify({ status: 1, name: 'NoOrgFound', message: 'No default environment found.' });
    expect(() => testRunStdoutFromProcess(proc(1, stdout))).toThrow(/status 1: No default environment found\./);
  });

  it('throws with stderr when there is no JSON at all', () => {
    expect(() => testRunStdoutFromProcess(proc(1, '', 'ECONNRESET'))).toThrow(/status 1: ECONNRESET/);
    expect(() => testRunStdoutFromProcess(proc(1, 'plain text', ''))).toThrow(/status 1: plain text/);
    expect(() => testRunStdoutFromProcess(proc(1, '', ''))).toThrow(/status 1: no output/);
  });

  it('throws when the process never ran', () => {
    expect(() => testRunStdoutFromProcess(proc(null, '', '', 'ENOENT'))).toThrow('sf did not run: ENOENT');
  });

  it('redacts credentials from the thrown message', () => {
    let message = '';
    try {
      testRunStdoutFromProcess(proc(1, '', 'INVALID_SESSION_ID 00D5f000005abcD!AQEAQAbCdEf.gHiJkLmNoPqRsTuVwXyZ012345'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('[redacted-access-token]');
    expect(message).not.toContain('AQEAQAbCdEf');
  });

  it('composes with makeCliTestRunner into a runner that records failures instead of excluding them', () => {
    const runner = makeCliTestRunner(() => testRunStdoutFromProcess(proc(100, TESTS_JSON)), { waitMinutes: 90 });
    const result = runner('c1');
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => `${r.className}.${r.methodName}=${r.outcome}`)).toEqual([
      'AccountTest.a=Pass',
      'OrderTest.b=Fail',
    ]);
  });

  it('a broken run reaches the driver as an exclusion reason, not an exception', () => {
    const runner = makeCliTestRunner(() => testRunStdoutFromProcess(proc(1, '', 'org limit reached')));
    const result = runner('c1');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('org limit reached');
  });
});

describe('makeCliTestRunner wait budget', () => {
  it('defaults to 60 minutes and honours an override', () => {
    const seen: string[][] = [];
    const run = (argv: readonly string[]): string => {
      seen.push([...argv]);
      return TESTS_JSON;
    };
    makeCliTestRunner(run)('c1');
    makeCliTestRunner(run, { waitMinutes: 180 })('c1');
    expect(seen[0]?.slice(seen[0].indexOf('--wait'), seen[0].indexOf('--wait') + 2)).toEqual(['--wait', '60']);
    expect(seen[1]?.slice(seen[1].indexOf('--wait'), seen[1].indexOf('--wait') + 2)).toEqual(['--wait', '180']);
  });
});

describe('toSelection', () => {
  const base = {
    totalTests: 10,
    reductionPercent: 0,
    testLevel: 'RunLocalTests',
    decisions: [],
    activatedDomains: [],
    impacted: new Set(),
    seeds: [],
    coverageGaps: [],
  } as unknown as Omit<AnalysisResult, 'outcome' | 'tests'>;

  it('records the selected names and a selected outcome', () => {
    const analysis = { ...base, outcome: 'selected', tests: [{ name: 'BTest' }, { name: 'ATest' }] } as unknown as AnalysisResult;
    expect(toSelection(analysis)).toEqual({ selected: ['BTest', 'ATest'], fellBack: false, totalTests: 10 });
  });

  it('records a fallback as fellBack with no selection', () => {
    const analysis = { ...base, outcome: 'full', tests: [] } as unknown as AnalysisResult;
    expect(toSelection(analysis)).toEqual({ selected: [], fellBack: true, totalTests: 10 });
  });
});

describe('parseRevList', () => {
  it('reads SHAs oldest first, ignoring blank lines and CRLF', () => {
    expect(parseRevList('aaaaaaa\r\n\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n')).toEqual([
      'aaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(parseRevList('')).toEqual([]);
  });

  it('refuses anything that is not a SHA rather than skipping it', () => {
    expect(() => parseRevList('aaaaaaa\nfatal: bad revision\n')).toThrow(/line 2 is not a commit SHA/);
    expect(() => parseRevList('ABCDEF0')).toThrow(/not a commit SHA/);
  });
});

describe('windowFor', () => {
  it('executes the base as a baseline and counts it in the identity', () => {
    const { identity, commits } = windowFor('org/repo', 'base000', 'head000', ['c1aaaaa', 'head000']);
    expect(commits).toEqual(['base000', 'c1aaaaa', 'head000']);
    expect(identity).toEqual({ repo: 'org/repo', baseSha: 'base000', headSha: 'head000', commitCount: 3 });
  });

  it('does not duplicate the base if rev-list already included it', () => {
    expect(windowFor('r', 'base000', 'head000', ['base000', 'head000']).commits).toEqual(['base000', 'head000']);
  });
});

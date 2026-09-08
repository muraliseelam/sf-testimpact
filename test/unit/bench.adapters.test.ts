import { describe, expect, it } from 'vitest';
import {
  adapterById,
  detectAdapter,
  junitXmlAdapter,
  sfJsonAdapter,
  ADAPTERS,
} from '../../src/bench/adapters.js';

const SF_JSON = JSON.stringify({
  status: 0,
  result: {
    summary: { outcome: 'Failed' },
    tests: [
      { ApexClass: { Name: 'AlphaTest' }, MethodName: 'passes', Outcome: 'Pass', RunTime: 120 },
      { ApexClass: { Name: 'BetaTest' }, MethodName: 'breaks', Outcome: 'Fail', RunTime: 45 },
      { ApexClass: { Name: 'GammaTest' }, MethodName: 'skipped', Outcome: 'Skip' },
    ],
  },
});

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="ApexTests" tests="3">
    <testcase classname="AlphaTest" name="passes" time="0.12"/>
    <testcase classname="BetaTest" name="breaks" time="0.045"><failure message="boom">stack</failure></testcase>
    <testcase classname="GammaTest" name="skipped"><skipped/></testcase>
  </testsuite>
</testsuites>`;

describe('adapter registry', () => {
  it('registers both adapters by id', () => {
    expect([...ADAPTERS.keys()].sort()).toEqual(['junit-xml', 'sf-json']);
    expect(adapterById('sf-json')).toBe(sfJsonAdapter);
    expect(adapterById('nope')).toBeUndefined();
  });

  it('detects each format from its content', () => {
    expect(detectAdapter(SF_JSON)?.id).toBe('sf-json');
    expect(detectAdapter(JUNIT)?.id).toBe('junit-xml');
    expect(detectAdapter('hello world')).toBeNull();
  });
});

describe('sf apex run test --json adapter', () => {
  const parsed = sfJsonAdapter.parse(SF_JSON);

  it('reads class, method and outcome', () => {
    expect(parsed.results).toEqual([
      { className: 'AlphaTest', methodName: 'passes', outcome: 'Pass', durationMs: 120 },
      { className: 'BetaTest', methodName: 'breaks', outcome: 'Fail', durationMs: 45 },
      { className: 'GammaTest', methodName: 'skipped', outcome: 'Skip', durationMs: null },
    ]);
  });

  it('reports a missing duration as null, never as zero', () => {
    // Zero would be indistinguishable from an instant test and would silently corrupt the
    // minutes-saved figure.
    expect(parsed.results[2]?.durationMs).toBeNull();
  });

  it('falls back to FullName when ApexClass is absent', () => {
    const result = sfJsonAdapter.parse(
      JSON.stringify({ tests: [{ FullName: 'DeltaTest.method', Outcome: 'Passed' }] }),
    );
    expect(result.results).toEqual([
      { className: 'DeltaTest', methodName: 'method', outcome: 'Pass', durationMs: null },
    ]);
  });

  it('normalises outcome spellings', () => {
    const result = sfJsonAdapter.parse(
      JSON.stringify({ tests: [{ FullName: 'A.b', Outcome: 'CompileFail' }] }),
    );
    expect(result.results[0]?.outcome).toBe('Fail');
  });

  it('reads a top-level tests array as well as result.tests', () => {
    expect(sfJsonAdapter.parse(JSON.stringify({ tests: [] })).results).toEqual([]);
  });
});

describe('JUnit XML adapter', () => {
  const parsed = junitXmlAdapter.parse(JUNIT);

  it('reads classname, name and outcome', () => {
    expect(parsed.results).toEqual([
      { className: 'AlphaTest', methodName: 'passes', outcome: 'Pass', durationMs: 120 },
      { className: 'BetaTest', methodName: 'breaks', outcome: 'Fail', durationMs: 45 },
      { className: 'GammaTest', methodName: 'skipped', outcome: 'Skip', durationMs: null },
    ]);
  });

  it('converts seconds to milliseconds', () => {
    expect(parsed.results[0]?.durationMs).toBe(120);
  });

  it('treats an error element as a failure', () => {
    const result = junitXmlAdapter.parse(
      '<testsuite name="s"><testcase classname="A" name="b"><error/></testcase></testsuite>',
    );
    expect(result.results[0]?.outcome).toBe('Fail');
  });

  it('handles a bare testsuite root as well as testsuites', () => {
    const result = junitXmlAdapter.parse(
      '<testsuite name="s"><testcase classname="A" name="b" time="1"/></testsuite>',
    );
    expect(result.results).toHaveLength(1);
  });

  it('falls back to the suite name when classname is absent', () => {
    const result = junitXmlAdapter.parse('<testsuite name="SuiteA"><testcase name="b"/></testsuite>');
    expect(result.results[0]?.className).toBe('SuiteA');
  });

  it('reports a missing time as null', () => {
    const result = junitXmlAdapter.parse('<testsuite name="s"><testcase classname="A" name="b"/></testsuite>');
    expect(result.results[0]?.durationMs).toBeNull();
  });
});

describe('both adapters agree on the same run', () => {
  it('produces identical outcomes from equivalent documents', () => {
    // The adapter interface exists so the metric does not depend on which CI format a team
    // happens to have. If the two disagree, the benchmark is measuring the format.
    const fromJson = sfJsonAdapter.parse(SF_JSON).results;
    const fromXml = junitXmlAdapter.parse(JUNIT).results;
    expect(fromXml).toEqual(fromJson);
  });
});

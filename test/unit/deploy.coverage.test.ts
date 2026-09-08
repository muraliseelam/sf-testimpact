/**
 * The production coverage constraint (DESIGN.md 9).
 *
 * `RunSpecifiedTests` requires every class in the payload to reach 75% **individually**,
 * from executed tests only. The property that makes selection safe is not "we picked a
 * covering test" but that the closure is *complete*: it selects every test reaching the
 * class, so per-class coverage is identical to `RunLocalTests`. Both halves are tested here.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  COVERAGE_FLOOR_PERCENT,
  coveragePercent,
  findCoverageRegressions,
  payloadClasses,
  verifyCoverage,
  type CoverageClient,
  type CoverageRow,
} from '../../src/deploy/coverage.js';
import { buildDeployPlan } from '../../src/deploy/plan.js';
import { createToolingCoverageClient } from '../../src/deploy/toolingClient.js';
import { analyze } from '../../src/query/analyze.js';
import { allTestClasses, coveringTests } from '../../src/query/selection.js';
import { CLASS_DIR, apexKey, cls, configWith, graphOf, testNames } from '../helpers/buildGraph.js';

const FIXTURE = graphOf([
  cls('Core', 'public class Core { public static void run() {} }'),
  cls('Mid', 'public class Mid { public static void go() { Core.run(); } }'),
  cls('Untouched', 'public class Untouched { public static void go() {} }'),
  cls('DirectTest', '@IsTest private class DirectTest { @IsTest static void t() { Core.run(); } }'),
  cls('DeepTest', '@IsTest private class DeepTest { @IsTest static void t() { Mid.go(); } }'),
  cls('OtherTest', '@IsTest private class OtherTest { @IsTest static void t() { Untouched.go(); } }'),
]);

const changed = [{ path: `${CLASS_DIR}/Core.cls`, kind: 'modified' as const }];
const config = configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 });

describe('the correctness property: selection cannot reduce per-class coverage', () => {
  it('selects every test that reaches the changed class', () => {
    const result = analyze(FIXTURE.graph, changed, config);
    const covering = coveringTests(FIXTURE.graph, apexKey('Core')).map((t) => t.name).sort();
    expect(covering).toEqual(['DeepTest', 'DirectTest']);
    expect(testNames(result.tests)).toEqual(expect.arrayContaining(covering));
  });

  it('reports no coverage regression, which is the property holding', () => {
    // findCoverageRegressions computes the property rather than assuming it: any test that
    // covers a payload class but was not selected would appear here.
    const result = analyze(FIXTURE.graph, changed, config);
    expect(
      findCoverageRegressions(FIXTURE.graph, result.seeds, result.tests.map((t) => t.name)),
    ).toEqual([]);
  });

  it('detects a regression when a covering test is missing from the selection', () => {
    // The guard must be able to fail, or it proves nothing. Here the selection is truncated
    // by hand to simulate a closure that lost an edge.
    const regressions = findCoverageRegressions(FIXTURE.graph, [apexKey('Core')], ['DirectTest']);
    expect(regressions).toEqual([{ className: 'Core', missingTests: ['DeepTest'] }]);
  });

  it('excludes tests that do not reach the class, so the property is not vacuous', () => {
    const result = analyze(FIXTURE.graph, changed, config);
    expect(testNames(result.tests)).not.toContain('OtherTest');
  });

  it('holds for a transitively changed class too', () => {
    const result = analyze(
      FIXTURE.graph,
      [{ path: `${CLASS_DIR}/Mid.cls`, kind: 'modified' }],
      config,
    );
    expect(
      findCoverageRegressions(FIXTURE.graph, result.seeds, result.tests.map((t) => t.name)),
    ).toEqual([]);
  });
});

describe('payloadClasses', () => {
  it('lists Apex classes and triggers from the change set', () => {
    expect(payloadClasses(FIXTURE.graph, [apexKey('Core'), apexKey('Mid')])).toEqual(['Core', 'Mid']);
  });

  it('ignores nodes that are not deployable Apex', () => {
    const withField = graphOf([cls('A', 'public class A { void m() { List<Account> x = [SELECT Id FROM Account]; } }')]);
    const sobjectNode = withField.graph.nodes.find((n) => n.kind === 'sobject');
    expect(payloadClasses(withField.graph, sobjectNode === undefined ? [] : [sobjectNode.key])).toEqual([]);
  });
});

describe('coveragePercent', () => {
  it.each([
    [{ name: 'A', linesCovered: 75, linesUncovered: 25 }, 75],
    [{ name: 'B', linesCovered: 0, linesUncovered: 10 }, 0],
    [{ name: 'C', linesCovered: 10, linesUncovered: 0 }, 100],
  ])('computes %o as %i%%', (row: CoverageRow, expected) => {
    expect(coveragePercent(row)).toBe(expected);
  });

  it('treats a class with no lines as zero rather than dividing by zero', () => {
    expect(coveragePercent({ name: 'D', linesCovered: 0, linesUncovered: 0 })).toBe(0);
  });
});

describe('verifyCoverage', () => {
  const client = (rows: CoverageRow[], orgTests: string[] = []): CoverageClient => ({
    aggregateCoverage: vi.fn().mockResolvedValue(rows),
    orgTestClasses: vi.fn().mockResolvedValue(orgTests),
  });

  it('passes when every payload class is at or above the floor', async () => {
    const result = await verifyCoverage(
      client([
        { name: 'Core', linesCovered: 80, linesUncovered: 20 },
        { name: 'Mid', linesCovered: 75, linesUncovered: 25 },
      ]),
      ['Core', 'Mid'],
      [],
    );
    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('blocks a class below the floor, reporting its actual percentage', () => {
    return expect(
      verifyCoverage(client([{ name: 'Core', linesCovered: 20, linesUncovered: 80 }]), ['Core'], []),
    ).resolves.toMatchObject({
      blockers: [{ className: 'Core', percent: 20, reason: 'below-floor' }],
    });
  });

  it('blocks a class the org has no coverage data for', async () => {
    // No row means no test has ever touched it in this org: it deploys at 0%, so treating a
    // missing row as "fine" would let exactly the failing case through.
    const result = await verifyCoverage(client([]), ['Ghost'], []);
    expect(result.blockers).toEqual([{ className: 'Ghost', percent: 0, reason: 'no-coverage-data' }]);
  });

  it('matches class names case-insensitively, as Apex does', async () => {
    const result = await verifyCoverage(
      client([{ name: 'CORE', linesCovered: 90, linesUncovered: 10 }]),
      ['Core'],
      [],
    );
    expect(result.blockers).toEqual([]);
  });

  it('reports org test classes the repository does not have', async () => {
    // DESIGN.md 9.2: their existence falsifies the completeness premise for this org.
    const result = await verifyCoverage(
      client([{ name: 'Core', linesCovered: 90, linesUncovered: 10 }], ['DirectTest', 'GhostTest']),
      ['Core'],
      ['DirectTest'],
    );
    expect(result.orgOnlyTests).toEqual(['GhostTest']);
  });

  it('does not query the org for an empty payload', async () => {
    const aggregateCoverage = vi.fn<CoverageClient['aggregateCoverage']>().mockResolvedValue([]);
    const orgTestClasses = vi.fn<CoverageClient['orgTestClasses']>().mockResolvedValue([]);
    await verifyCoverage({ aggregateCoverage, orgTestClasses }, [], []);
    expect(aggregateCoverage).not.toHaveBeenCalled();
  });

  it('uses the documented 75% floor', () => {
    expect(COVERAGE_FLOOR_PERCENT).toBe(75);
  });
});

describe('tooling client', () => {
  it('queries ApexCodeCoverageAggregate and maps the rows', async () => {
    const query = vi.fn().mockResolvedValue({
      records: [
        { ApexClassOrTrigger: { Name: 'Core' }, NumLinesCovered: 8, NumLinesUncovered: 2 },
        { ApexClassOrTrigger: {}, NumLinesCovered: 1, NumLinesUncovered: 1 },
      ],
    });
    const rows = await createToolingCoverageClient({ tooling: { query } }).aggregateCoverage(['Core']);
    expect(rows).toEqual([{ name: 'Core', linesCovered: 8, linesUncovered: 2 }]);
    expect(String(query.mock.calls[0]?.[0])).toContain('ApexCodeCoverageAggregate');
  });

  it('chunks long payloads so the SOQL statement stays within limits', async () => {
    const query = vi.fn().mockResolvedValue({ records: [] });
    const names = Array.from({ length: 120 }, (_, i) => `Class${i}`);
    await createToolingCoverageClient({ tooling: { query } }).aggregateCoverage(names);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('escapes quotes in class names rather than building broken SOQL', async () => {
    const query = vi.fn().mockResolvedValue({ records: [] });
    await createToolingCoverageClient({ tooling: { query } }).aggregateCoverage(["O'Brien"]);
    expect(String(query.mock.calls[0]?.[0])).toContain("O\\'Brien");
  });

  it('lists org test classes', async () => {
    const query = vi.fn().mockResolvedValue({ records: [{ Name: 'AlphaTest' }, { notName: 1 }] });
    const names = await createToolingCoverageClient({ tooling: { query } }).orgTestClasses();
    expect(names).toEqual(['AlphaTest']);
  });
});

describe('buildDeployPlan', () => {
  it('passes the selected tests with RunSpecifiedTests', () => {
    const result = analyze(FIXTURE.graph, changed, config);
    const plan = buildDeployPlan(result, config);
    expect(plan.testLevel).toBe('RunSpecifiedTests');
    expect(plan.args).toContain('--tests');
    // This assertion previously required the comma-joined form `DeepTest,DirectTest`, which
    // encoded a real defect: `sf project deploy start` rejects a comma-separated test list
    // ("We've changed how you specify multiple tests"), so every multi-test deploy failed.
    // The dry-run printed the same string and looked fine, which is why it survived. The
    // expectation is now the full argument vector rather than a substring, so the shape is
    // pinned exactly, and the old form is asserted absent as a control.
    expect(plan.args).toEqual([
      '--test-level',
      'RunSpecifiedTests',
      '--tests',
      'DeepTest',
      '--tests',
      'DirectTest',
    ]);
    expect(plan.args.join(' ')).not.toContain('DeepTest,DirectTest');
  });

  it('uses the configured full test level on a fallback, naming the rule', () => {
    const broken = graphOf([cls('Broken', 'public class Broken { void m( { } }')]);
    const result = analyze(broken.graph, [{ path: `${CLASS_DIR}/Broken.cls`, kind: 'modified' }], configWith());
    const plan = buildDeployPlan(result, configWith());
    expect(plan.testLevel).toBe('RunLocalTests');
    expect(plan.tests).toEqual([]);
    expect(plan.rationale).toContain('changed-file-parse-failed');
  });

  it('uses NoTestRun rather than an empty RunSpecifiedTests, which the platform rejects', () => {
    const result = analyze(
      FIXTURE.graph,
      [{ path: 'docs/readme.md', kind: 'modified' }],
      configWith({ excludeFromImpact: ['**/*.md'], maxReductionPercent: 100 }),
    );
    const plan = buildDeployPlan(result, configWith());
    expect(plan.testLevel).toBe('NoTestRun');
    expect(plan.rationale).toContain('No test is affected');
  });

  it('appends passthrough flags', () => {
    const result = analyze(FIXTURE.graph, changed, config);
    expect(buildDeployPlan(result, config, ['--wait', '30']).args).toEqual(
      expect.arrayContaining(['--wait', '30']),
    );
  });
});

describe('offline guarantee', () => {
  it('the analyze path never references jsforce or @salesforce/core', async () => {
    // The safety property is structural: index and analyze must not be able to open a
    // connection. jsforce enters only through deploy's dynamic import.
    const analyzeSource = await import('node:fs').then((fs) =>
      fs.readFileSync('src/commands/testimpact/analyze.ts', 'utf8'),
    );
    expect(analyzeSource).not.toContain('jsforce');
    expect(analyzeSource).not.toContain('@salesforce/core');
  });

  it('the index path never references jsforce or @salesforce/core', async () => {
    const indexSource = await import('node:fs').then((fs) =>
      fs.readFileSync('src/commands/testimpact/index.ts', 'utf8'),
    );
    expect(indexSource).not.toContain('jsforce');
    expect(indexSource).not.toContain('@salesforce/core');
  });

  it('deploy reaches an org only through a dynamic import', async () => {
    const deploySource = await import('node:fs').then((fs) =>
      fs.readFileSync('src/commands/testimpact/deploy.ts', 'utf8'),
    );
    // No static import of the org SDK anywhere in the file...
    expect(deploySource).not.toMatch(/^import .*'@salesforce\/core'/m);
    // ...and exactly one dynamic one, inside the verify-coverage path.
    expect(deploySource).toContain("import('@salesforce/core')");
    expect(deploySource.match(/import\('@salesforce\/core'\)/g)).toHaveLength(1);
  });

  it('the test classes it compares against come from the graph, not from an org', () => {
    expect(allTestClasses(FIXTURE.graph).map((n) => n.name).sort()).toEqual([
      'DeepTest',
      'DirectTest',
      'OtherTest',
    ]);
  });
});

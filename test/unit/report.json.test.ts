/**
 * The `analyze --json` contract.
 *
 * This shape is a public API that CI pipelines gate deployments on, so these tests pin the
 * field names and types rather than merely checking that something was produced.
 */

import { describe, expect, it } from 'vitest';
import { ANALYZE_SCHEMA_VERSION, toAnalyzeJson } from '../../src/report/json.js';
import { analyze } from '../../src/query/analyze.js';
import { CLASS_DIR, cls, configWith, graphOf } from '../helpers/buildGraph.js';

const FIXTURE = graphOf([
  cls('Service', 'public class Service { public static void run() {} }'),
  cls('ServiceTest', '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }'),
  cls('IdleTest', '@IsTest private class IdleTest { @IsTest static void t() { System.assertEquals(1,1); } }'),
]);

const jsonFor = (changed: Array<{ path: string; kind: 'modified' | 'added' | 'deleted' }>, config = configWith()) => {
  const result = analyze(FIXTURE.graph, changed, config);
  return toAnalyzeJson({ result, graph: FIXTURE.graph, base: 'main', head: 'HEAD', changedFiles: changed.length });
};

describe('analyze --json shape', () => {
  const json = jsonFor([{ path: `${CLASS_DIR}/Service.cls`, kind: 'modified' }]);

  it('declares a schema version consumers can branch on', () => {
    expect(json.schemaVersion).toBe(ANALYZE_SCHEMA_VERSION);
    expect(typeof json.schemaVersion).toBe('number');
  });

  it('has exactly the documented top-level keys', () => {
    // Pinned deliberately: adding a key within a version is allowed, removing or renaming
    // one is a breaking change for every CI pipeline that reads it.
    expect(Object.keys(json).sort()).toEqual([
      'activatedTaintDomains',
      'changedFiles',
      // Added within schemaVersion 1, which this module's contract explicitly permits: it is
      // always present, and `null` whenever there is no alternative policy worth offering,
      // so a consumer reading it never has to test for the key's existence.
      'counterfactual',
      'coverageGaps',
      'decisions',
      'fellBack',
      'graph',
      'outcome',
      'range',
      'reductionPercent',
      'schemaVersion',
      'selectedCount',
      'testLevel',
      'tests',
      'toolVersion',
      'totalTests',
    ]);
  });

  it('reports the selection with per-test reasons', () => {
    expect(json.outcome).toBe('selected');
    expect(json.testLevel).toBe('RunSpecifiedTests');
    expect(json.tests).toEqual([{ name: 'ServiceTest', reason: 'impacted' }]);
    expect(json.selectedCount).toBe(1);
    expect(json.totalTests).toBe(2);
  });

  it('rounds reductionPercent to two places, so CI diffs stay stable', () => {
    expect(json.reductionPercent).toBe(50);
    expect(Number.isFinite(json.reductionPercent)).toBe(true);
  });

  it('reports the range and the graph it used', () => {
    expect(json.range).toEqual({ base: 'main', head: 'HEAD' });
    expect(json.graph.nodes).toBeGreaterThan(0);
    expect(json.graph.indexedFiles).toBe(3);
    expect(typeof json.graph.createdAt).toBe('string');
  });

  it('is JSON-serialisable with no undefined values', () => {
    const round = JSON.parse(JSON.stringify(json)) as typeof json;
    expect(round).toEqual(json);
  });

  it('renders an absent hint as null rather than omitting the key', () => {
    // A consumer reading `decisions[i].hint` must not have to distinguish "absent" from
    // "no hint"; the key is always present.
    const withDecisions = jsonFor([{ path: `${CLASS_DIR}/New.cls`, kind: 'added' }]);
    expect(withDecisions.decisions.length).toBeGreaterThan(0);
    for (const decision of withDecisions.decisions) {
      expect(Object.keys(decision).sort()).toEqual(['hint', 'level', 'message', 'rule', 'subject']);
      expect(decision.hint === null || typeof decision.hint === 'string').toBe(true);
    }
  });
});

describe('analyze --json on a fallback', () => {
  const json = jsonFor([{ path: `${CLASS_DIR}/Unknown.cls`, kind: 'added' }]);

  it('sets fellBack, the single field CI should branch on', () => {
    expect(json.fellBack).toBe(true);
    expect(json.outcome).toBe('full');
  });

  it('empties the test list and names the full test level', () => {
    // A CI job that ignored `fellBack` and ran the empty list would run no tests at all, so
    // the level must carry the answer too.
    expect(json.tests).toEqual([]);
    expect(json.testLevel).toBe('RunLocalTests');
    expect(json.reductionPercent).toBe(0);
  });

  it('explains why, with a machine-readable rule id', () => {
    expect(json.decisions.some((d) => d.rule === 'changed-file-not-in-index')).toBe(true);
    expect(json.decisions.every((d) => typeof d.rule === 'string' && d.rule.length > 0)).toBe(true);
  });
});

describe('analyze --json reports taint and coverage gaps', () => {
  it('lists activated taint domains', () => {
    const dynamic = graphOf([
      cls('Widget', 'public class Widget {}'),
      cls('Dyn', "public class Dyn { void m() { Type t = Type.forName('Widget'); } }"),
      cls('DynTest', '@IsTest private class DynTest { @IsTest static void t() { new Dyn(); } }'),
    ]);
    const result = analyze(dynamic.graph, [{ path: `${CLASS_DIR}/Widget.cls`, kind: 'modified' }], configWith());
    const json = toAnalyzeJson({ result, graph: dynamic.graph, base: 'a', head: 'b', changedFiles: 1 });
    expect(json.activatedTaintDomains).toContain('apexType');
  });

  it('lists changed classes no test reaches', () => {
    const orphan = graphOf([
      cls('Orphan', 'public class Orphan {}'),
      cls('IdleTest', '@IsTest private class IdleTest { @IsTest static void t() { System.assertEquals(1,1); } }'),
    ]);
    const result = analyze(
      orphan.graph,
      [{ path: `${CLASS_DIR}/Orphan.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    const json = toAnalyzeJson({ result, graph: orphan.graph, base: 'a', head: 'b', changedFiles: 1 });
    expect(json.coverageGaps).toEqual(['Orphan']);
  });
});

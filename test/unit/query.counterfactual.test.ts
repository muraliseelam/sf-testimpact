/**
 * The policy counterfactual reported on an entry-point fallback.
 *
 * Shipped defaults produce a full run on most change sets. That is deliberate, but it left a
 * user with no way to judge the alternative: "try `entryPointPolicy: widen`" is advice you
 * cannot evaluate without numbers from your own repository. `analyze` now computes what
 * `widen` would have selected, at the moment it falls back.
 *
 * The behaviour that matters is the *narrowness* of the offer. It must appear only when
 * changing the policy would genuinely change the answer, because pointing someone at a
 * setting that cannot help them is worse than saying nothing.
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { buildGraph, currentGenerator } from '../../src/graph/store.js';
import { analyze } from '../../src/query/analyze.js';
import { configWith } from '../helpers/buildGraph.js';
import type { FileFacts } from '../../src/types.js';

const DIR = 'force-app/main/default/classes';

const cls = (name: string, body: string) => extractApex(`${DIR}/${name}.cls`, body);

/** An @AuraEnabled entry point, a helper it calls, and tests that reach each. */
const facts: FileFacts[] = [
  cls('Helper', 'public class Helper { public static Integer value() { return 1; } }'),
  cls(
    'AuraCtrl',
    'public with sharing class AuraCtrl { @AuraEnabled public static Integer fetch() { return Helper.value(); } }',
  ),
  cls('AuraCtrlTest', '@IsTest private class AuraCtrlTest { @IsTest static void t() { AuraCtrl.fetch(); } }'),
  cls('Unrelated', 'public class Unrelated { public static void go() { Integer x = 1; } }'),
  cls('UnrelatedTest', '@IsTest private class UnrelatedTest { @IsTest static void t() { Unrelated.go(); } }'),
];

const graph = buildGraph(
  facts.map((f) => ({ path: f.path, hash: 'h', parsedOk: true, extractor: f.extractor })),
  facts,
  { root: '.', sourcePaths: ['force-app'], namespace: 'c' },
  currentGenerator(),
  'x',
);

const changed = [{ path: `${DIR}/Helper.cls`, kind: 'modified' as const }];

describe('the counterfactual appears when the policy is the only blocker', () => {
  const result = analyze(graph, changed, configWith({ maxReductionPercent: 100 }));

  it('falls back on the shipped default, as before', () => {
    // The safety behaviour is unchanged. This is the control: the fix must not have
    // quietly turned the default into `widen`.
    expect(result.outcome).toBe('full');
    expect(result.tests).toEqual([]);
    expect(result.decisions.some((d) => d.rule === 'entry-point-policy-full')).toBe(true);
  });

  it('reports what widen would have selected', () => {
    expect(result.counterfactual).toBeDefined();
    expect(result.counterfactual?.policy).toBe('widen');
    expect(result.counterfactual?.wouldSelect).toBeGreaterThan(0);
    expect(result.counterfactual?.wouldSelect).toBeLessThan(result.totalTests);
  });

  it('the reported number matches an actual widen run', () => {
    // Not a recomputation of the same arithmetic: run the real thing and compare.
    const actual = analyze(
      graph,
      changed,
      configWith({ entryPointPolicy: 'widen', maxReductionPercent: 100 }),
    );
    expect(actual.outcome).toBe('selected');
    expect(result.counterfactual?.wouldSelect).toBe(actual.tests.length);
    expect(result.counterfactual?.reductionPercent).toBeCloseTo(actual.reductionPercent, 6);
  });

  it('names the entry points whose external callers the user would be ruling out', () => {
    expect(result.counterfactual?.assumesNoExternalCallerOf).toContain('AuraCtrl');
  });
});

describe('the counterfactual is withheld when the policy would not help', () => {
  it('is absent when another rule also forced the full run', () => {
    // An unmodelled file type inside sourcePaths forces a full run on its own. Switching
    // entryPointPolicy would change nothing, so offering it would be misleading.
    const result = analyze(
      graph,
      [
        ...changed,
        { path: 'force-app/main/default/layouts/A-Layout.layout-meta.xml', kind: 'modified' as const },
      ],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(result.outcome).toBe('full');
    expect(result.decisions.some((d) => d.rule === 'unmodelled-file-type')).toBe(true);
    expect(result.counterfactual).toBeUndefined();
  });

  it('is absent when there was no fallback at all', () => {
    const result = analyze(
      graph,
      [{ path: `${DIR}/Unrelated.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(result.outcome).toBe('selected');
    expect(result.counterfactual).toBeUndefined();
  });

  it('is absent when the user already set widen', () => {
    const result = analyze(
      graph,
      changed,
      configWith({ entryPointPolicy: 'widen', maxReductionPercent: 100 }),
    );
    expect(result.counterfactual).toBeUndefined();
  });

  it('is absent under strict', () => {
    const result = analyze(
      graph,
      changed,
      configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
    );
    expect(result.counterfactual).toBeUndefined();
  });
});

describe('the entry-point fallback names every impacted entry point', () => {
  it('lists them all, not just the first', () => {
    const many: FileFacts[] = [
      cls('Shared', 'public class Shared { public static Integer v() { return 1; } }'),
      cls('A', 'public class A { @AuraEnabled public static Integer f() { return Shared.v(); } }'),
      cls('B', 'public class B { @InvocableMethod public static void g() { Shared.v(); } }'),
      cls('AT', '@IsTest private class AT { @IsTest static void t() { A.f(); } }'),
    ];
    const g = buildGraph(
      many.map((f) => ({ path: f.path, hash: 'h', parsedOk: true, extractor: f.extractor })),
      many,
      { root: '.', sourcePaths: ['force-app'], namespace: 'c' },
      currentGenerator(),
      'x',
    );
    const r = analyze(g, [{ path: `${DIR}/Shared.cls`, kind: 'modified' }], configWith());
    const decision = r.decisions.find((d) => d.rule === 'entry-point-policy-full');
    expect(decision?.subjects).toBeDefined();
    expect(decision?.subjects).toEqual(expect.arrayContaining(['A', 'B']));
    // `subject` still holds the first, so existing consumers keep working.
    expect(decision?.subjects).toContain(decision?.subject);
  });
});

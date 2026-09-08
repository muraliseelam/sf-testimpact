/**
 * The coverage correctness argument from DESIGN.md 9.1, as an executable test.
 *
 * > **Claim.** For every class `C` in the deployment payload, coverage of `C` under the
 * > selected test set is identical to its coverage under `RunLocalTests`.
 * >
 * > **Argument.** A test `t` contributes coverage to `C` only by executing lines of `C`,
 * > which requires a call path `t -> ... -> C`. Every such path is a forward path in the
 * > graph. `C` is in the payload, so `C` changed, so `C` is a seed of the reverse closure.
 * > The reverse closure from a seed yields *every* node with a forward path to that seed —
 * > it is not pruned or minimised. Hence `selected` is a superset of `{ t : t covers C }`.
 *
 * The executable form of that claim: for a changed class `C`, the selected test set
 * contains every test with a path to `C`. `coveringTests` computes the ground truth
 * independently of the selection, so this is a real cross-check rather than a restatement.
 *
 * `RunSpecifiedTests` requires **every** class in the payload to reach 75% individually,
 * computed only from executed tests, so "we included one covering test" would be worthless.
 * The property that matters is that the closure is *complete*, not minimal.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/query/analyze.js';
import { type ChangedFile } from '../../src/query/changeSet.js';
import { computeReachable } from '../../src/query/closure.js';
import { allTestClasses, coveringTests } from '../../src/query/selection.js';
import { type ImpactGraph } from '../../src/graph/model.js';
import { type NodeKey } from '../../src/types.js';
import { CLASS_DIR, apexKey, cls, configWith, graphOf, sobject, field, testNames } from '../helpers/buildGraph.js';

/**
 * A layered fixture: several tests reach `Core` by different route lengths, one reaches it
 * only through an interface, one only dynamically, and two do not reach it at all.
 */
const FIXTURE = graphOf(
  [
    cls('Core', 'public class Core { public static Decimal rate() { List<Account> a = [SELECT Rating__c FROM Account]; return 1; } }'),
    cls('Middle', 'public class Middle { public static Decimal go() { return Core.rate(); } }'),
    cls('Outer', 'public class Outer { public static Decimal go() { return Middle.go(); } }'),

    cls('IRunner', 'public interface IRunner { void run(); }'),
    cls('CoreRunner', 'public class CoreRunner implements IRunner { public void run() { Core.rate(); } }'),
    cls('RunnerHost', 'public class RunnerHost { public static void host(IRunner r) { r.run(); } }'),

    cls('Reflector', "public class Reflector { public static Object make() { return Type.forName('Core').newInstance(); } }"),

    cls('Unrelated', 'public class Unrelated { public static void go() {} }'),

    // Tests that reach Core, at varying depths and via varying mechanisms.
    cls('DirectTest', '@IsTest private class DirectTest { @IsTest static void t() { Core.rate(); } }'),
    cls('MiddleTest', '@IsTest private class MiddleTest { @IsTest static void t() { Middle.go(); } }'),
    cls('OuterTest', '@IsTest private class OuterTest { @IsTest static void t() { Outer.go(); } }'),
    cls('InterfaceTest', '@IsTest private class InterfaceTest { @IsTest static void t() { RunnerHost.host(null); } }'),
    cls('ReflectorTest', '@IsTest private class ReflectorTest { @IsTest static void t() { Reflector.make(); } }'),

    // Tests that do not reach Core at all.
    cls('UnrelatedTest', '@IsTest private class UnrelatedTest { @IsTest static void t() { Unrelated.go(); } }'),
    cls('EmptyTest', '@IsTest private class EmptyTest { @IsTest static void t() { System.assertEquals(1, 1); } }'),
  ],
  { extraFacts: [sobject('Account'), field('Account', 'Rating__c')] },
);

const changedFile = (name: string): ChangedFile => ({ path: `${CLASS_DIR}/${name}.cls`, kind: 'modified' });

/**
 * Ground truth computed the other way round: every test whose *forward* reachability
 * contains the target. Independent of both the closure and `coveringTests`.
 */
function testsReaching(graph: ImpactGraph, target: NodeKey): string[] {
  return allTestClasses(graph)
    .filter((t) => computeReachable(graph, t.key).has(target))
    .map((t) => t.name)
    .sort();
}

describe('coverage argument — selection contains every test that reaches the changed class', () => {
  it.each(['Core', 'Middle', 'Outer', 'CoreRunner', 'Unrelated'])(
    'for a change to %s, no test with a path to it is skipped',
    (className) => {
      const target = apexKey(className);
      const result = analyze(
        FIXTURE.graph,
        [changedFile(className)],
        configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
      );
      expect(result.outcome).toBe('selected');

      const selected = new Set(testNames(result.tests));
      for (const covering of testsReaching(FIXTURE.graph, target)) {
        expect(selected.has(covering), `${covering} covers ${className} but was not selected`).toBe(true);
      }
    },
  );

  it('the two independent notions of "covering test" agree', () => {
    // `coveringTests` walks the reverse graph; `testsReaching` walks it forwards. If these
    // ever disagree, one of the two traversals is wrong and the argument above rests on it.
    for (const className of ['Core', 'Middle', 'CoreRunner']) {
      const target = apexKey(className);
      const reverse = coveringTests(FIXTURE.graph, target).map((t) => t.name).sort();
      expect(reverse).toEqual(testsReaching(FIXTURE.graph, target));
    }
  });

  it('finds a non-trivial number of covering tests, so the property is not vacuous', () => {
    // A claim about "every covering test" proves nothing if there are none, or if every
    // test covers everything.
    const covering = testsReaching(FIXTURE.graph, apexKey('Core'));
    expect(covering.length).toBeGreaterThanOrEqual(4);
    expect(covering.length).toBeLessThan(allTestClasses(FIXTURE.graph).length);
  });

  it('includes the test that reaches the class only through an interface', () => {
    // Coverage under RunSpecifiedTests counts lines executed at runtime, so a test that
    // reaches Core through IRunner genuinely contributes to Core's percentage.
    expect(testsReaching(FIXTURE.graph, apexKey('Core'))).toContain('InterfaceTest');
  });

  it('includes the test that reaches the class only dynamically', () => {
    const result = analyze(
      FIXTURE.graph,
      [changedFile('Core')],
      configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
    );
    expect(testNames(result.tests)).toContain('ReflectorTest');
  });

  it('excludes tests with no path to the changed class', () => {
    // The other half of the claim: selection must be complete, not universal. A selector
    // that returns every test satisfies the coverage property trivially and saves nothing.
    const result = analyze(
      FIXTURE.graph,
      [changedFile('Unrelated')],
      configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
    );
    expect(testNames(result.tests)).not.toContain('DirectTest');
    expect(testNames(result.tests)).not.toContain('OuterTest');
  });

  it('holds when the change is a field rather than a class', () => {
    // Core reads Account.Rating__c, so a field change must still pull in everything that
    // covers Core — the full chain the taint fixpoint exists to preserve.
    const result = analyze(
      FIXTURE.graph,
      [
        {
          path: 'force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml',
          kind: 'modified',
        },
      ],
      configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
    );
    const selected = new Set(testNames(result.tests));
    for (const covering of testsReaching(FIXTURE.graph, apexKey('Core'))) {
      expect(selected.has(covering), `${covering} covers Core but was not selected`).toBe(true);
    }
  });
});

describe('coverage gaps', () => {
  it('reports a changed class that no test reaches', () => {
    const orphan = graphOf([
      cls('Orphan', 'public class Orphan { public static void go() {} }'),
      cls('SomethingTest', '@IsTest private class SomethingTest { @IsTest static void t() { System.assertEquals(1,1); } }'),
    ]);
    const result = analyze(
      orphan.graph,
      [changedFile('Orphan')],
      configWith({ maxReductionPercent: 100 }),
    );
    // Under RunSpecifiedTests this class cannot reach 75% however we choose tests, so the
    // deploy would fail on coverage regardless of the selection.
    expect(result.coverageGaps).toContain('Orphan');
  });

  it('reports nothing for a class its tests reach', () => {
    const result = analyze(
      FIXTURE.graph,
      [changedFile('Core')],
      configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
    );
    expect(result.coverageGaps).toEqual([]);
  });
});

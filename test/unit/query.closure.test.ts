/**
 * The taint fixpoint (DESIGN.md 7.2).
 *
 * This is the algorithm that decides whether a test gets skipped, so the tests here are
 * written to prove properties rather than to observe outputs.
 */

import { describe, expect, it } from 'vitest';
import { domainsOf, type ImpactGraph } from '../../src/graph/model.js';
import { computeImpacted } from '../../src/query/closure.js';
import { NodeFlags, hasFlag, type NodeKey, type TaintDomain } from '../../src/types.js';
import { apexKey, cls, field, fieldKey, graphOf, sobject } from '../helpers/buildGraph.js';

/**
 * The §7.2 worked example, as source.
 *
 * `Rating__c` changes -> `PricingService` reads it -> `Dispatcher` reaches `PricingService`
 * only through `Type.forName`. Nothing statically connects the field to the dispatcher.
 */
const WORKED_EXAMPLE = graphOf(
  [
    cls(
      'PricingService',
      `public class PricingService {
         public static Decimal rate(Account a) {
           List<Account> rows = [SELECT Rating__c FROM Account];
           return rows.isEmpty() ? 0 : 1;
         }
       }`,
    ),
    cls(
      'Dispatcher',
      `public class Dispatcher {
         public static Object run(String name) {
           Type t = Type.forName(name);
           return t.newInstance();
         }
       }`,
    ),
    cls(
      'DispatcherTest',
      `@IsTest private class DispatcherTest {
         @IsTest static void dispatches() { Dispatcher.run('PricingService'); }
       }`,
    ),
    cls(
      'UnrelatedTest',
      `@IsTest private class UnrelatedTest {
         @IsTest static void unrelated() { System.assertEquals(1, 1); }
       }`,
    ),
  ],
  { extraFacts: [sobject('Account'), field('Account', 'Rating__c')] },
);

/**
 * The **incorrect** algorithm, encoded here as a control.
 *
 * It activates taint domains from the *seed* set once, up front, instead of from the
 * impacted set as nodes are reached. This is the natural reading of "a change of kind K
 * activates domain K", and it is what the tool must not do. Keeping it in the test file
 * means the correct implementation is measured against the specific mistake it avoids,
 * rather than merely against a hard-coded expected answer that would keep passing if the
 * ordering silently regressed.
 */
function computeImpactedWithSeedTimeTaint(
  graph: ImpactGraph,
  seeds: readonly NodeKey[],
): ReadonlySet<NodeKey> {
  const impacted = new Set<NodeKey>();
  const frontier: number[] = [];

  const push = (key: NodeKey): void => {
    if (impacted.has(key)) return;
    const index = graph.indexOf(key);
    if (index === undefined) return;
    impacted.add(key);
    frontier.push(index);
  };

  // The mistake: domains are decided from the seeds alone, before any walking.
  const activated = new Set<TaintDomain>();
  for (const seed of seeds) {
    const node = graph.nodeByKey(seed);
    if (node === undefined) continue;
    for (const domain of domainsOf(node.kind)) activated.add(domain);
  }
  for (const seed of seeds) push(seed);
  for (const domain of activated) {
    for (const tainted of graph.taintedIn(domain)) push(tainted);
  }

  while (frontier.length > 0) {
    const index = frontier.pop();
    if (index === undefined) break;
    for (const dependent of graph.dependentsOf(index)) {
      const node = graph.nodeAt(dependent);
      if (node !== undefined) push(node.key);
    }
  }
  return impacted;
}

const testsIn = (graph: ImpactGraph, impacted: ReadonlySet<NodeKey>): string[] =>
  [...impacted]
    .map((k) => graph.nodeByKey(k))
    .filter((n) => n !== undefined && hasFlag(n.flags, NodeFlags.IS_TEST))
    .map((n) => n?.name ?? '')
    .sort();

describe('taint fixpoint — the DESIGN.md 7.2 worked example', () => {
  const { graph } = WORKED_EXAMPLE;
  const seeds = [fieldKey('Account', 'Rating__c')];

  it('reaches PricingService from the changed field', () => {
    const { impacted } = computeImpacted(graph, seeds);
    expect(impacted.has(apexKey('PricingService'))).toBe(true);
  });

  it('selects DispatcherTest, which reaches the change only through Type.forName', () => {
    // Dispatcher has no static edge to PricingService. It is reachable only because
    // PricingService entering the impacted set activates the apexType domain.
    const { impacted } = computeImpacted(graph, seeds);
    expect(impacted.has(apexKey('Dispatcher'))).toBe(true);
    expect(testsIn(graph, impacted)).toContain('DispatcherTest');
  });

  it('activates apexType from PricingService, not from the changed field', () => {
    const { activated } = computeImpacted(graph, seeds);
    expect(activated.get('apexType')).toBe(apexKey('PricingService'));
  });

  it('CONTROL: seed-time taint activation misses DispatcherTest entirely', () => {
    // This is the proof that the ordering is load-bearing. The seed set holds only a field,
    // so a seed-time check of the apexType domain never fires and the dispatcher is never
    // reached. If this control ever starts finding DispatcherTest, the two algorithms have
    // converged and this test no longer proves anything — which is itself worth failing on.
    const wrong = computeImpactedWithSeedTimeTaint(graph, seeds);
    expect(wrong.has(apexKey('Dispatcher'))).toBe(false);
    expect(testsIn(graph, wrong)).not.toContain('DispatcherTest');
  });

  it('CONTROL: the two algorithms genuinely disagree on this fixture', () => {
    const { impacted } = computeImpacted(graph, seeds);
    const wrong = computeImpactedWithSeedTimeTaint(graph, seeds);
    expect(testsIn(graph, impacted)).not.toEqual(testsIn(graph, wrong));
  });

  it('does not select a test unrelated to the change', () => {
    // A fixpoint that selects everything would pass every test above while being useless.
    const { impacted } = computeImpacted(graph, seeds);
    expect(testsIn(graph, impacted)).not.toContain('UnrelatedTest');
  });
});

describe('taint fixpoint — termination', () => {
  it('terminates on a cycle with a tainted node inside it', () => {
    // A -> B -> A, with B dynamically dispatching. Reaching either activates apexType,
    // which pushes B back onto the frontier; without the monotone impacted set this loops
    // forever. Valid Apex cannot express this cycle, but a malformed index can.
    const { graph } = graphOf([
      cls('A', 'public class A { void m() { B.go(); } }'),
      cls('B', "public class B { public static void go() { A.x(); Type t = Type.forName('A'); } }"),
      cls('ATest', '@IsTest private class ATest { @IsTest static void t() { A.m2(); } }'),
    ]);

    const result = computeImpacted(graph, [apexKey('A')]);
    expect(result.impacted.has(apexKey('A'))).toBe(true);
    expect(result.impacted.has(apexKey('B'))).toBe(true);
    expect(result.activated.has('apexType')).toBe(true);
  });

  it('activates each domain at most once', () => {
    const { graph } = graphOf([
      cls('D1', "public class D1 { void m() { Type t = Type.forName('x'); } }"),
      cls('D2', "public class D2 { void m() { Type t = Type.forName('y'); } }"),
      cls('Seed', 'public class Seed {}'),
    ]);
    const { activated } = computeImpacted(graph, [apexKey('Seed')]);
    // A Map cannot hold a domain twice, so this asserts the shape rather than the count;
    // the meaningful guarantee is that the walk below finished at all.
    expect([...activated.keys()]).toEqual(['apexType']);
  });

  it('handles a seed that is not in the graph without throwing', () => {
    const { graph } = graphOf([cls('Only', 'public class Only {}')]);
    const { impacted } = computeImpacted(graph, ['apex:c.nonexistent' as NodeKey]);
    expect(impacted.size).toBe(0);
  });

  it('returns the seeds themselves as impacted', () => {
    const { graph } = graphOf([cls('Only', 'public class Only {}')]);
    const { impacted } = computeImpacted(graph, [apexKey('Only')]);
    expect(impacted.has(apexKey('Only'))).toBe(true);
  });
});

describe('taint fixpoint — a test reachable only dynamically', () => {
  /**
   * The false-negative case that matters most: `ReflectiveTest` never names `Widget`
   * statically. If taint fails, this test is silently skipped and a regression in `Widget`
   * ships.
   */
  const { graph } = graphOf([
    cls('Widget', 'public class Widget { public static Integer size() { return 1; } }'),
    cls(
      'ReflectiveTest',
      `@IsTest private class ReflectiveTest {
         @IsTest static void buildsByName() {
           Type t = Type.forName('Widget');
           System.assertNotEquals(null, t.newInstance());
         }
       }`,
    ),
    cls('StaticTest', '@IsTest private class StaticTest { @IsTest static void t() { Widget.size(); } }'),
  ]);

  it('has no static edge from the reflective test to the class it exercises', () => {
    // Establishes the premise: without taint there is genuinely nothing to walk.
    const staticEdges = graph.edges.filter(
      (e) => e.from === apexKey('ReflectiveTest') && e.to === apexKey('Widget'),
    );
    expect(staticEdges).toEqual([]);
  });

  it('selects the reflective test anyway, via the apexType domain', () => {
    const { impacted } = computeImpacted(graph, [apexKey('Widget')]);
    expect(testsIn(graph, impacted)).toEqual(['ReflectiveTest', 'StaticTest']);
  });

  it('selects the reflective test when a field it never names changes', () => {
    // The full chain: field -> class -> domain activation -> dynamic caller.
    const withField = graphOf(
      [
        cls('Widget', 'public class Widget { void m() { List<Account> a = [SELECT Rating__c FROM Account]; } }'),
        cls(
          'ReflectiveTest',
          "@IsTest private class ReflectiveTest { @IsTest static void t() { Type x = Type.forName('Widget'); } }",
        ),
      ],
      { extraFacts: [sobject('Account'), field('Account', 'Rating__c')] },
    );
    const { impacted } = computeImpacted(withField.graph, [fieldKey('Account', 'Rating__c')]);
    expect(testsIn(withField.graph, impacted)).toContain('ReflectiveTest');
  });
});

describe('domainsOf', () => {
  it('maps Apex kinds to apexType', () => {
    expect(domainsOf('apex')).toEqual(['apexType']);
    expect(domainsOf('trigger')).toEqual(['apexType']);
  });

  it('maps objects and fields to both data domains', () => {
    // Dynamic SOQL reads fields and dynamic field access happens on objects, so a change to
    // either can affect a class tainted in either domain.
    expect(domainsOf('sobject')).toEqual(['sobjectAny', 'fieldAny']);
    expect(domainsOf('field')).toEqual(['sobjectAny', 'fieldAny']);
  });

  it('maps kinds with no dynamic construct to no domain', () => {
    expect(domainsOf('label')).toEqual([]);
    expect(domainsOf('permset')).toEqual([]);
  });
});

/**
 * Turning an impacted node set into a list of Apex test classes (DESIGN.md 7.4).
 */

import picomatch from 'picomatch';
import { type Config } from '../config/schema.js';
import { type ImpactGraph } from '../graph/model.js';
import { NodeFlags, hasFlag, type GraphNode, type NodeKey } from '../types.js';

/** Why a test ended up in the selection. Drives the explanation the CLI prints. */
export type SelectionReason = 'impacted' | 'always-run' | 'see-all-data';

export interface SelectedTest {
  readonly name: string;
  readonly key: NodeKey;
  readonly reason: SelectionReason;
}

export interface Selection {
  readonly tests: readonly SelectedTest[];
  readonly totalTests: number;
  /** Share of the org's tests this selection skips, 0-100. */
  readonly reductionPercent: number;
}

export function allTestClasses(graph: ImpactGraph): readonly GraphNode[] {
  return graph.nodes.filter((n) => hasFlag(n.flags, NodeFlags.IS_TEST));
}

/**
 * Select the tests to run.
 *
 * Three sources, unioned:
 *  - tests in the impacted set,
 *  - tests matched by `alwaysRun`,
 *  - `@IsTest(SeeAllData=true)` tests, which read org data we cannot see in git and so can
 *    never be shown to be unaffected by a change.
 */
export function selectTests(
  graph: ImpactGraph,
  impacted: ReadonlySet<NodeKey>,
  config: Config,
): Selection {
  const tests = allTestClasses(graph);
  const matchesAlwaysRun =
    config.alwaysRun.length === 0 ? (): boolean => false : picomatch(config.alwaysRun as string[]);

  const selected = new Map<NodeKey, SelectedTest>();
  for (const test of tests) {
    const reason = reasonFor(test, impacted, matchesAlwaysRun);
    if (reason !== null) selected.set(test.key, { name: test.name, key: test.key, reason });
  }

  const list = [...selected.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    tests: list,
    totalTests: tests.length,
    reductionPercent: tests.length === 0 ? 0 : ((tests.length - list.length) / tests.length) * 100,
  };
}

function reasonFor(
  test: GraphNode,
  impacted: ReadonlySet<NodeKey>,
  matchesAlwaysRun: (path: string) => boolean,
): SelectionReason | null {
  if (impacted.has(test.key)) return 'impacted';
  if (hasFlag(test.flags, NodeFlags.SEE_ALL_DATA)) return 'see-all-data';
  if (test.declaredIn !== null && matchesAlwaysRun(test.declaredIn)) return 'always-run';
  return null;
}

/**
 * Changed Apex classes with no test that reaches them.
 *
 * Worth surfacing whatever the selection decides: under `RunSpecifiedTests` a production
 * deployment needs every class in the payload individually at 75% coverage, and a class no
 * test reaches will fail that regardless of which tests we choose (DESIGN.md 9.1).
 */
export function coverageGaps(
  graph: ImpactGraph,
  changedNodes: readonly NodeKey[],
  impacted: ReadonlySet<NodeKey>,
): readonly string[] {
  const gaps: string[] = [];
  for (const key of changedNodes) {
    const node = graph.nodeByKey(key);
    if (node === undefined) continue;
    if (node.kind !== 'apex' && node.kind !== 'trigger') continue;
    if (hasFlag(node.flags, NodeFlags.IS_TEST)) continue;

    const covered = coveringTests(graph, key).length > 0;
    if (!covered && impacted.has(key)) gaps.push(node.name);
  }
  return gaps;
}

/**
 * Every test class with a path to `target`.
 *
 * This is the ground truth the coverage argument in DESIGN.md 9.1 rests on: because the
 * reverse closure is complete rather than minimal, the selected set always contains all of
 * these, so the target's coverage is the same as it would be under `RunLocalTests`.
 */
export function coveringTests(graph: ImpactGraph, target: NodeKey): readonly GraphNode[] {
  const index = graph.indexOf(target);
  if (index === undefined) return [];

  const seen = new Set<number>([index]);
  const stack = [index];
  const found: GraphNode[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const node = graph.nodeAt(current);
    if (node !== undefined && current !== index && hasFlag(node.flags, NodeFlags.IS_TEST)) {
      found.push(node);
    }
    for (const dependent of graph.dependentsOf(current)) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      stack.push(dependent);
    }
  }
  return found;
}

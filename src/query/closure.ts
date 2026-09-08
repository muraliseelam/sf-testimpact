/**
 * Reverse transitive closure with the taint fixpoint (DESIGN.md 7.2).
 *
 * This function decides which tests get skipped. It is the single place where a mistake
 * turns into a production defect, so the algorithm below is written to be read.
 */

import { domainsOf, type ImpactGraph } from '../graph/model.js';
import { type NodeKey, type TaintDomain } from '../types.js';

export interface ClosureResult {
  /** Every node that could be affected by the seeds. Always a superset of the seeds. */
  readonly impacted: ReadonlySet<NodeKey>;
  /** Taint domains that fired, with the node whose reachability activated each. */
  readonly activated: ReadonlyMap<TaintDomain, NodeKey>;
}

/**
 * Compute the set of nodes a change to `seeds` could affect.
 *
 * **Why taint activates on the impacted set, not the seed set.**
 *
 * The tempting implementation checks, once at the start, which domains the *changed* nodes
 * belong to, and seeds every node tainted in those domains. It is wrong, and the way it is
 * wrong is a false negative — the failure mode this tool exists to avoid.
 *
 * Consider: `Rating__c` changes; `PricingService` reads it; `Dispatcher` calls
 * `Type.forName('PricingService')`. The change set holds a *field*, so a seed-time check of
 * the `apexType` domain never fires, `Dispatcher` is never reached, and `DispatcherTest` is
 * never selected — even though `Dispatcher` dynamically invokes a class whose behaviour just
 * changed. Activating domains as nodes are *reached* fixes this, because `PricingService`
 * enters the impacted set during the walk and activates `apexType` from there.
 *
 * Termination is guaranteed: there are three domains, each activates at most once, and
 * membership of `impacted` is monotone. The walk stays O(V + E + T).
 */
export function computeImpacted(graph: ImpactGraph, seeds: readonly NodeKey[]): ClosureResult {
  const impacted = new Set<NodeKey>();
  const activated = new Map<TaintDomain, NodeKey>();
  const frontier: number[] = [];

  const push = (key: NodeKey): void => {
    if (impacted.has(key)) return;
    const index = graph.indexOf(key);
    if (index === undefined) return; // Not in the graph; nothing to walk from.
    impacted.add(key);
    frontier.push(index);
  };

  for (const seed of seeds) push(seed);

  while (frontier.length > 0) {
    const index = frontier.pop();
    if (index === undefined) break;
    const node = graph.nodeAt(index);
    if (node === undefined) continue;

    // Activate every taint domain this node's kind belongs to. Nodes tainted in a newly
    // activated domain join the frontier and are then walked like any other node, so their
    // own dependents — and any further domains they activate — are picked up too.
    for (const domain of domainsOf(node.kind)) {
      if (activated.has(domain)) continue;
      activated.set(domain, node.key);
      for (const tainted of graph.taintedIn(domain)) push(tainted);
    }

    for (const dependent of graph.dependentsOf(index)) {
      const dependentNode = graph.nodeAt(dependent);
      if (dependentNode !== undefined) push(dependentNode.key);
    }
  }

  return { impacted, activated };
}

/**
 * Forward reachability from a single node: everything it depends on.
 *
 * Used by the coverage argument in DESIGN.md 9.1 to answer "which classes does this test
 * actually cover", and by reporting to find changed classes with no covering test.
 */
export function computeReachable(graph: ImpactGraph, from: NodeKey): ReadonlySet<NodeKey> {
  const seen = new Set<NodeKey>();
  const outgoing = new Map<NodeKey, NodeKey[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.from);
    if (bucket === undefined) outgoing.set(edge.from, [edge.to]);
    else bucket.push(edge.to);
  }

  const queue: NodeKey[] = [from];
  seen.add(from);
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

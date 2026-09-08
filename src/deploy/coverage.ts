/**
 * Production coverage handling for `sf testimpact deploy` (DESIGN.md 9).
 *
 * ## The correctness property
 *
 * `RunSpecifiedTests` requires **every class and trigger in the deployment to individually
 * reach 75%**, computed only from the tests actually executed. Org-wide averages do not
 * save a single under-covered class, so a guarantee of the form "we included at least one
 * covering test" is worthless: one test can leave a class at 20% and fail the deploy.
 *
 * The property that does hold follows from the closure being *complete*, not *minimal*:
 *
 * > For every class `C` in the payload, coverage of `C` under the selected test set is
 * > identical to its coverage under `RunLocalTests`.
 *
 * A test `t` contributes coverage to `C` only by executing lines of `C`, which requires a
 * call path `t -> ... -> C`. Every such path is a forward path in the graph. `C` is in the
 * payload, so `C` changed, so `C` is a seed of the reverse closure — and the reverse closure
 * from a seed yields *every* node with a forward path to it. Hence
 * `selected ⊇ { t : t covers C }`, and tests outside that set contribute zero lines to `C`.
 * **Selection therefore cannot reduce per-class coverage.**
 *
 * ## Where the property breaks
 *
 * It is conditional on the graph's *inbound* edges to `C` being complete:
 *
 *  - a test reaching `C` only dynamically is covered by taint (DESIGN.md 6.2) — unless the
 *    dynamic construct is one we do not detect;
 *  - `entryPointPolicy: strict` trusts the graph by the user's explicit choice;
 *  - **tests present in the org but not in the repository** are invisible to any static
 *    analysis. In a non-source-tracked org this is the dominant risk, and it is why
 *    `--verify-coverage` exists.
 *
 * `verifyCoverage` below is the empirical check for what the argument cannot cover.
 */

import { type ImpactGraph } from '../graph/model.js';
import { NodeFlags, hasFlag, type GraphNode, type NodeKey } from '../types.js';
import { coveringTests } from '../query/selection.js';

/** Salesforce's per-class floor for a production deployment. */
export const COVERAGE_FLOOR_PERCENT = 75;

/** One row of `ApexCodeCoverageAggregate`. */
export interface CoverageRow {
  readonly name: string;
  readonly linesCovered: number;
  readonly linesUncovered: number;
}

/**
 * The org queries `--verify-coverage` needs.
 *
 * An interface rather than a jsforce connection, so tests never touch a network and the
 * rest of the tool never imports jsforce at all.
 */
export interface CoverageClient {
  /** Last-known aggregate coverage for the named classes and triggers. */
  aggregateCoverage(names: readonly string[]): Promise<readonly CoverageRow[]>;
  /** Names of Apex test classes that exist in the org. */
  orgTestClasses(): Promise<readonly string[]>;
}

export function coveragePercent(row: CoverageRow): number {
  const total = row.linesCovered + row.linesUncovered;
  return total === 0 ? 0 : (row.linesCovered / total) * 100;
}

export interface CoverageBlocker {
  readonly className: string;
  readonly percent: number;
  readonly reason: 'below-floor' | 'no-coverage-data';
}

export interface VerifyCoverageResult {
  /** Classes that would fail the deployment on coverage grounds. */
  readonly blockers: readonly CoverageBlocker[];
  /**
   * Test classes the org has that the repository does not.
   *
   * Their existence falsifies the completeness premise of the §9.1 argument for this org:
   * under `RunLocalTests` they contribute coverage, and under `RunSpecifiedTests` with our
   * list they do not.
   */
  readonly orgOnlyTests: readonly string[];
  readonly checked: number;
}

/**
 * Pre-flight coverage check against a target org.
 *
 * **Honest limitation:** `ApexCodeCoverageAggregate` reports coverage from the org's *last*
 * test run. It is a strong signal about classes already sitting near the floor, and it
 * detects repo/org drift exactly, but it does not predict the coverage of the run about to
 * happen. Callers must report it as such rather than as a guarantee.
 */
export async function verifyCoverage(
  client: CoverageClient,
  payloadClasses: readonly string[],
  repoTestClasses: readonly string[],
): Promise<VerifyCoverageResult> {
  const rows = payloadClasses.length === 0 ? [] : await client.aggregateCoverage(payloadClasses);
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));

  const blockers: CoverageBlocker[] = [];
  for (const className of payloadClasses) {
    const row = byName.get(className.toLowerCase());
    if (row === undefined) {
      // No row means the org has never run a test that touched this class. That is a real
      // hazard, not a missing datum to shrug at: it deploys at 0%.
      blockers.push({ className, percent: 0, reason: 'no-coverage-data' });
      continue;
    }
    const percent = coveragePercent(row);
    if (percent < COVERAGE_FLOOR_PERCENT) {
      blockers.push({ className, percent, reason: 'below-floor' });
    }
  }

  const known = new Set(repoTestClasses.map((n) => n.toLowerCase()));
  const orgOnlyTests = (await client.orgTestClasses()).filter((n) => !known.has(n.toLowerCase()));

  return { blockers, orgOnlyTests: [...orgOnlyTests].sort(), checked: payloadClasses.length };
}

/** Apex classes and triggers in the deployment payload, derived from the change set. */
export function payloadClasses(graph: ImpactGraph, seeds: readonly NodeKey[]): readonly string[] {
  const names = new Set<string>();
  for (const key of seeds) {
    const node = graph.nodeByKey(key);
    if (node === undefined) continue;
    if (node.kind !== 'apex' && node.kind !== 'trigger') continue;
    if (hasFlag(node.flags, NodeFlags.IS_EXTERNAL)) continue;
    names.add(node.name);
  }
  return [...names].sort();
}

/**
 * The §9.1 property, computed rather than assumed.
 *
 * Returns any payload class for which a test exists that covers it but was not selected.
 * The argument says this must always be empty; a non-empty result means the closure lost an
 * edge, and the deploy should not proceed on a claim that no longer holds.
 */
export function findCoverageRegressions(
  graph: ImpactGraph,
  payload: readonly NodeKey[],
  selectedTests: readonly string[],
): readonly { className: string; missingTests: readonly string[] }[] {
  const selected = new Set(selectedTests.map((n) => n.toLowerCase()));
  const out: { className: string; missingTests: readonly string[] }[] = [];

  for (const key of payload) {
    const node = graph.nodeByKey(key);
    if (node === undefined || (node.kind !== 'apex' && node.kind !== 'trigger')) continue;

    const missing = coveringTests(graph, key)
      .filter((t: GraphNode) => !selected.has(t.name.toLowerCase()))
      .map((t) => t.name);
    if (missing.length > 0) out.push({ className: node.name, missingTests: missing });
  }
  return out;
}

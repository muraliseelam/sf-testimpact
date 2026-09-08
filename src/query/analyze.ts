/**
 * The `analyze` pipeline: change set -> closure -> selection -> safety gates.
 *
 * Pure over an already-loaded graph, so the whole decision path is testable without a
 * filesystem, a git repository or an org.
 */

import { type Config } from '../config/schema.js';
import { type ImpactGraph } from '../graph/model.js';
import { type NodeKey, type TaintDomain } from '../types.js';
import { resolveChangeSet, type ChangedFile } from './changeSet.js';
import { computeImpacted } from './closure.js';
import { applyEntryPointPolicy, checkFallbacks, checkReduction, type Decision } from './safety.js';
import { coverageGaps, selectTests, type SelectedTest } from './selection.js';

export type Outcome = 'selected' | 'full';

export interface AnalysisResult {
  readonly outcome: Outcome;
  /** Test class names for `--tests`. Empty when the outcome is `full`. */
  readonly tests: readonly SelectedTest[];
  readonly totalTests: number;
  readonly reductionPercent: number;
  /** The `--test-level` the deploy command should use. */
  readonly testLevel: string;
  /** Every rule that fired, in the order it fired. */
  readonly decisions: readonly Decision[];
  readonly activatedDomains: readonly TaintDomain[];
  readonly impacted: ReadonlySet<NodeKey>;
  readonly seeds: readonly NodeKey[];
  /** Changed classes that no test reaches — a deploy hazard regardless of selection. */
  readonly coverageGaps: readonly string[];
}

export function analyze(
  graph: ImpactGraph,
  changed: readonly ChangedFile[],
  config: Config,
): AnalysisResult {
  const changeSet = resolveChangeSet(graph, changed, config);
  const decisions: Decision[] = [...checkFallbacks(graph, changeSet, config)];

  const first = computeImpacted(graph, changeSet.seeds);
  const entryPoints = applyEntryPointPolicy(graph, first.impacted, config);
  decisions.push(...entryPoints.decisions);

  // Widening adds seeds, so the closure is rerun rather than patched: a widened entry point
  // has its own dependencies and its own taint activations, and both must be walked.
  const closure =
    entryPoints.extraSeeds.length === 0
      ? first
      : computeImpacted(graph, [...changeSet.seeds, ...entryPoints.extraSeeds]);

  for (const [domain, cause] of closure.activated) {
    const node = graph.nodeByKey(cause);
    decisions.push({
      level: 'widen',
      rule: `taint-domain-activated-${domain}`,
      subject: node?.name ?? cause,
      message:
        `Taint domain \`${domain}\` activated because ${node?.name ?? cause} is impacted. ` +
        'Classes with unresolvable references into that domain are selected too.',
    });
  }

  const selection = selectTests(graph, closure.impacted, config);
  decisions.push(
    ...checkReduction(selection.reductionPercent, selection.tests.length, selection.totalTests, config),
  );

  const failed = decisions.some((d) => d.level === 'fallback');
  const gaps = coverageGaps(graph, changeSet.seeds, closure.impacted);

  if (failed) {
    return {
      outcome: 'full',
      tests: [],
      totalTests: selection.totalTests,
      reductionPercent: 0,
      testLevel: config.fullTestLevel,
      decisions,
      activatedDomains: [...closure.activated.keys()],
      impacted: closure.impacted,
      seeds: changeSet.seeds,
      coverageGaps: gaps,
    };
  }

  return {
    outcome: 'selected',
    tests: selection.tests,
    totalTests: selection.totalTests,
    reductionPercent: selection.reductionPercent,
    testLevel: 'RunSpecifiedTests',
    decisions,
    activatedDomains: [...closure.activated.keys()],
    impacted: closure.impacted,
    seeds: changeSet.seeds,
    coverageGaps: gaps,
  };
}

/** One line per decision, in the shape the CLI prints. */
export function formatDecisions(decisions: readonly Decision[]): string[] {
  return decisions.map((d) => {
    const label = d.level === 'fallback' ? 'FALLBACK' : d.level === 'widen' ? 'WIDEN   ' : 'INFO    ';
    const head = `${label}  ${d.rule}: ${d.message}`;
    return d.hint === undefined ? head : `${head}\n          hint: ${d.hint}`;
  });
}

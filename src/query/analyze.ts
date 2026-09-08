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
  /**
   * What a different policy would have selected, measured on this repository.
   *
   * Populated only when `entryPointPolicy: full` was the *sole* reason for the fallback, so
   * it is only ever offered when changing that setting would actually change the answer.
   * Shipped defaults produce a full run on most change sets, and a user has no way to judge
   * the trade without numbers from their own code; this supplies them at the moment the
   * fallback happens rather than asking them to go and run a benchmark.
   */
  readonly counterfactual?: PolicyCounterfactual;
}

export interface PolicyCounterfactual {
  readonly policy: 'widen';
  readonly wouldSelect: number;
  readonly totalTests: number;
  readonly reductionPercent: number;
  /** The entry points whose external callers `widen` asks you to rule out. */
  readonly assumesNoExternalCallerOf: readonly string[];
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
      ...counterfactualFor(graph, changed, config, decisions),
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

/**
 * What `widen` would have selected, when `full` is the only thing standing in the way.
 *
 * Deliberately narrow. It is computed only if every fallback that fired was
 * `entry-point-policy-full`: if anything else forced the full run — an unparseable file, an
 * unmodelled type, a file missing from the index — then changing `entryPointPolicy` would
 * not have changed the answer, and saying otherwise would send the reader to a setting that
 * cannot help them.
 *
 * This re-runs the analysis rather than reusing the closure, because widening adds seeds and
 * a widened entry point brings its own dependencies and taint activations. The extra run
 * happens only on a fallback, and `analyze` is measured in single-digit milliseconds on
 * apex-recipes and ~51 ms on NPSP, so the cost is paid exactly where it buys something.
 *
 * No recursion risk: the nested call runs with `entryPointPolicy: 'widen'`, which cannot
 * emit `entry-point-policy-full`.
 */
function counterfactualFor(
  graph: ImpactGraph,
  changed: readonly ChangedFile[],
  config: Config,
  decisions: readonly Decision[],
): { counterfactual?: PolicyCounterfactual } {
  if (config.entryPointPolicy !== 'full') return {};

  const fallbacks = decisions.filter((d) => d.level === 'fallback');
  if (fallbacks.length === 0) return {};
  if (!fallbacks.every((d) => d.rule === 'entry-point-policy-full')) return {};

  const widened = analyze(graph, changed, { ...config, entryPointPolicy: 'widen' });
  if (widened.outcome !== 'selected') return {};

  const subjects = fallbacks.flatMap((d) => d.subjects ?? (d.subject === undefined ? [] : [d.subject]));

  return {
    counterfactual: {
      policy: 'widen',
      wouldSelect: widened.tests.length,
      totalTests: widened.totalTests,
      reductionPercent: widened.reductionPercent,
      assumesNoExternalCallerOf: [...new Set(subjects)],
    },
  };
}

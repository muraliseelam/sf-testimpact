/**
 * Stage 4: turn stored observations into the false-negative result.
 *
 * The scoring itself lives in `falseNegatives.ts` and is not touched here. This module does
 * two things that module deliberately does not: it reads a store (including the commits that
 * produced no outcomes at all), and it decides whether the data supports quoting a rate.
 *
 * That second job is the point of the module. A false-negative rate computed over three
 * newly-failing pairs is arithmetic, not a measurement, and publishing it as a percentage
 * invites exactly the reading it cannot support. Below the threshold the rate is withheld and
 * the raw counts are reported instead, with the reason stated in the artifact rather than
 * left for a reader to work out.
 */

import { summarise, type BenchmarkSummary, type CommitObservation } from './falseNegatives.js';
import { type ExcludedCommit, type ObservationStore, type WindowIdentity } from './observationStore.js';

/**
 * Newly-failing pairs below which a rate is not reported.
 *
 * 30 is the figure `docs/CORRECTNESS-PLAN.md` §6 commits to. It is a judgement about when a
 * proportion starts to mean anything, not a computed bound, and it is named here so that
 * changing it is a visible decision rather than an edit to a comparison.
 */
export const MIN_DENOMINATOR = 30;

export interface PolicyObservations {
  /** `full`, `widen`, `strict` — whatever the run scored. */
  readonly policy: string;
  readonly observations: readonly CommitObservation[];
}

export interface FnReportInput {
  readonly window: WindowIdentity;
  /** One entry per `entryPointPolicy` scored. */
  readonly perPolicy: readonly PolicyObservations[];
  readonly excluded: readonly ExcludedCommit[];
  /** Tests seen to fail then pass at the same commit, from the execution driver. */
  readonly flakyObserved?: readonly { readonly commit: string; readonly test: string }[];
  readonly minDenominator?: number;
}

export interface PolicyResult {
  readonly policy: string;
  /** True when the denominator supports quoting a rate. */
  readonly rateReportable: boolean;
  /**
   * The rate, or null when the denominator is too small.
   *
   * Null is used rather than 0 because they mean opposite things: 0 is "nothing was missed",
   * null is "this data cannot say". Collapsing them would turn an absence of evidence into
   * the strongest possible result.
   */
  readonly falseNegativeRatePercent: number | null;
  readonly newlyFailing: number;
  readonly falseNegatives: number;
  readonly falseNegativeDetail: readonly { readonly commit: string; readonly test: string }[];
  readonly fallbacks: number;
  readonly fallbackRatePercent: number;
  readonly reductionPercent: number;
  readonly totalSelected: number;
  readonly totalAvailable: number;
  readonly flakyExcluded: number;
  readonly commitsScored: number;
  /** Present only when the rate is withheld. */
  readonly note?: string;
}

export interface FnReport {
  readonly window: WindowIdentity;
  readonly minDenominator: number;
  /** True only if every policy had a sufficient denominator. */
  readonly measurable: boolean;
  readonly perPolicy: readonly PolicyResult[];
  readonly excludedCommits: readonly ExcludedCommit[];
  readonly flakyObserved: readonly { readonly commit: string; readonly test: string }[];
  /** Stated in the artifact so a reader is never left to infer it. */
  readonly summary: string;
}

const NOT_MEASURABLE = 'not measurable from this data';

export function buildFnReport(input: FnReportInput): FnReport {
  const minDenominator = input.minDenominator ?? MIN_DENOMINATOR;

  const perPolicy = input.perPolicy.map(({ policy, observations }) =>
    toPolicyResult(policy, summarise(observations), observations.length, minDenominator),
  );

  const measurable = perPolicy.length > 0 && perPolicy.every((p) => p.rateReportable);

  return {
    window: input.window,
    minDenominator,
    measurable,
    perPolicy,
    excludedCommits: input.excluded,
    flakyObserved: input.flakyObserved ?? [],
    summary: describe(perPolicy, minDenominator, input.excluded.length),
  };
}

function toPolicyResult(
  policy: string,
  summary: BenchmarkSummary,
  commitsScored: number,
  minDenominator: number,
): PolicyResult {
  const reportable = summary.newlyFailing >= minDenominator;

  return {
    policy,
    rateReportable: reportable,
    falseNegativeRatePercent: reportable ? summary.falseNegativeRatePercent : null,
    newlyFailing: summary.newlyFailing,
    falseNegatives: summary.falseNegatives.length,
    falseNegativeDetail: summary.falseNegatives.map((f) => ({
      commit: f.commit,
      test: `${f.className}.${f.methodName}`,
    })),
    fallbacks: summary.fallbacks,
    fallbackRatePercent: summary.fallbackRatePercent,
    reductionPercent: summary.reductionPercent,
    totalSelected: summary.totalSelected,
    totalAvailable: summary.totalAvailable,
    flakyExcluded: summary.flakyExcluded,
    commitsScored,
    ...(reportable
      ? {}
      : {
          note:
            `${NOT_MEASURABLE}: ${summary.newlyFailing} newly-failing (test, commit) pair(s), ` +
            `below the ${minDenominator} needed to quote a rate. The counts above are still ` +
            'the observed counts.',
        }),
  };
}

function describe(
  perPolicy: readonly PolicyResult[],
  minDenominator: number,
  excludedCount: number,
): string {
  if (perPolicy.length === 0) return 'No policy was scored, so there is no result.';

  const excludedNote =
    excludedCount === 0 ? '' : ` ${excludedCount} commit(s) were excluded and are listed.`;

  const insufficient = perPolicy.filter((p) => !p.rateReportable);
  if (insufficient.length === perPolicy.length) {
    const n = perPolicy[0]?.newlyFailing ?? 0;
    return (
      `${NOT_MEASURABLE}. The window produced ${n} newly-failing (test, commit) pair(s), ` +
      `below the ${minDenominator} this project requires before quoting a false-negative ` +
      `rate. Raw counts are reported; no percentage is.${excludedNote}`
    );
  }

  const parts = perPolicy.map((p) =>
    p.rateReportable
      ? `${p.policy}: ${p.falseNegatives ?? 0} of ${p.newlyFailing} missed ` +
        `(${p.falseNegativeRatePercent ?? 0}%), fallback ${p.fallbackRatePercent}%, ` +
        `reduction ${p.reductionPercent}%`
      : `${p.policy}: ${NOT_MEASURABLE} (${p.newlyFailing} newly-failing)`,
  );
  return `${parts.join('; ')}.${excludedNote}`;
}

/**
 * Read a store and score it.
 *
 * The store holds one outcome series; a selection under a different `entryPointPolicy` is a
 * different set of `selected` lists over the *same* outcomes. `selectionsByPolicy` supplies
 * those, so the expensive half — the org runs — is done once and scored many times.
 */
export function reportFromStore(
  store: ObservationStore,
  selectionsByPolicy: ReadonlyMap<string, ReadonlyMap<string, { selected: readonly string[]; fellBack: boolean; totalTests: number }>>,
  options: { readonly minDenominator?: number } = {},
): FnReport {
  const base = store.toObservations();

  const perPolicy: PolicyObservations[] = [...selectionsByPolicy.entries()].map(
    ([policy, byCommit]) => ({
      policy,
      observations: base.map((o) => {
        const selection = byCommit.get(o.commit);
        // A commit with no recorded selection for this policy contributes its outcomes as a
        // baseline only. Substituting an empty selection would score it as "selected nothing"
        // and manufacture false negatives that no run of the tool ever produced.
        if (selection === undefined) return { ...o, selected: [], fellBack: false, totalTests: 0, baselineOnly: true };
        return { ...o, ...selection };
      }),
    }),
  );

  return buildFnReport({
    window: store.window,
    perPolicy,
    excluded: store.excluded(),
    ...(options.minDenominator === undefined ? {} : { minDenominator: options.minDenominator }),
  });
}

/** Human-readable rendering, for a terminal or a commit message. */
export function renderFnReport(report: FnReport): string {
  const lines: string[] = [];
  const w = report.window;
  lines.push(`False-negative measurement — ${w.repo} ${w.baseSha}..${w.headSha} (${w.commitCount} commits)`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  for (const p of report.perPolicy) {
    lines.push(`entryPointPolicy: ${p.policy}`);
    lines.push(`  commits scored          ${p.commitsScored}`);
    lines.push(`  newly-failing pairs     ${p.newlyFailing}`);
    lines.push(`  false negatives         ${p.falseNegatives}`);
    lines.push(
      `  false-negative rate     ${p.falseNegativeRatePercent === null ? NOT_MEASURABLE : `${p.falseNegativeRatePercent}%`}`,
    );
    lines.push(`  fallback rate           ${p.fallbackRatePercent}%`);
    lines.push(`  reduction               ${p.reductionPercent}%`);
    lines.push(`  flaky excluded          ${p.flakyExcluded}`);
    if (p.note !== undefined) lines.push(`  note: ${p.note}`);
    lines.push('');
  }

  if (report.excludedCommits.length > 0) {
    lines.push(`Excluded commits (${report.excludedCommits.length}):`);
    for (const e of report.excludedCommits) lines.push(`  ${e.commit}  ${e.reason}`);
    lines.push('');
  }

  return lines.join('\n');
}

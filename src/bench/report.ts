/**
 * Benchmark report rendering.
 *
 * The false-negative rate and the fallback rate are always printed together and adjacent.
 * A selector that falls back on every commit scores a perfect zero on the first number
 * while delivering nothing, so presenting either alone would be misleading.
 */

import { type BenchmarkSummary } from './falseNegatives.js';

export function renderReport(summary: BenchmarkSummary, repo: string): string {
  const lines: string[] = [];
  const pct = (n: number): string => `${n.toFixed(2)}%`;

  lines.push(`sf-testimpact benchmark — ${repo}`);
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Commits analysed          ${summary.commits}`);
  lines.push('');

  lines.push('CORRECTNESS');
  lines.push(`  False negatives         ${summary.falseNegatives.length} of ${summary.newlyFailing} newly-failing`);
  lines.push(`  False-negative rate     ${pct(summary.falseNegativeRatePercent)}`);
  // Printed immediately below, never in a separate section.
  lines.push(`  Fallback rate           ${pct(summary.fallbackRatePercent)}  (${summary.fallbacks}/${summary.commits} commits ran everything)`);
  if (summary.newlyFailing === 0) {
    lines.push('  NOTE: no newly-failing tests in this window, so the rate above is not evidence of anything.');
  }
  lines.push('');

  lines.push('SELECTION');
  lines.push(`  Tests selected          ${summary.totalSelected} of ${summary.totalAvailable}`);
  lines.push(`  Reduction               ${pct(summary.reductionPercent)}`);
  lines.push(
    summary.minutesSaved === null
      ? '  Minutes saved           unknown (the result format carried no timings; counts only)'
      : `  Minutes saved           ${summary.minutesSaved.toFixed(1)}`,
  );
  lines.push('');

  lines.push('EXCLUDED');
  lines.push(`  Flaky tests             ${summary.flaky.length} (${summary.flakyExcluded} outcome(s) excluded from both numbers)`);
  for (const flaky of summary.flaky.slice(0, 10)) {
    lines.push(`    ${flaky.className}.${flaky.methodName}  (${flaky.flips} flips)`);
  }
  if (summary.flaky.length > 10) lines.push(`    ... and ${summary.flaky.length - 10} more`);

  if (summary.falseNegatives.length > 0) {
    lines.push('');
    lines.push('FALSE NEGATIVES (tests that would have caught a regression but were not selected)');
    for (const fn of summary.falseNegatives) {
      lines.push(`  ${fn.commit.slice(0, 10)}  ${fn.className}.${fn.methodName}`);
    }
  }

  return lines.join('\n');
}

/** Machine-readable form, written next to the printed report. */
export function toReportJson(summary: BenchmarkSummary, repo: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repo,
    commits: summary.commits,
    correctness: {
      falseNegatives: summary.falseNegatives.length,
      newlyFailing: summary.newlyFailing,
      falseNegativeRatePercent: summary.falseNegativeRatePercent,
      fallbacks: summary.fallbacks,
      fallbackRatePercent: summary.fallbackRatePercent,
      detail: summary.falseNegatives,
    },
    selection: {
      totalSelected: summary.totalSelected,
      totalAvailable: summary.totalAvailable,
      reductionPercent: summary.reductionPercent,
      minutesSaved: summary.minutesSaved,
    },
    excluded: { flaky: summary.flaky, flakyOutcomes: summary.flakyExcluded },
  };
}

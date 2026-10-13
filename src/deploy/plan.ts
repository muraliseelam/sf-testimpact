/**
 * Turning an analysis into `sf project deploy start` arguments.
 */

import { type Config } from '../config/schema.js';
import { type AnalysisResult } from '../query/analyze.js';

export interface DeployPlan {
  /** Arguments appended to `sf project deploy start`. */
  readonly args: readonly string[];
  readonly testLevel: string;
  readonly tests: readonly string[];
  /** Human-readable summary of why this test level was chosen. */
  readonly rationale: string;
}

export interface Passthrough {
  /** Everything after the first `--`, verbatim and in order, for `sf project deploy start`. */
  readonly passthrough: readonly string[];
  /** Positional arguments that came before `--`. `deploy` takes none, so each is a mistake. */
  readonly unexpected: readonly string[];
}

/**
 * Split the command line into what goes to `sf project deploy start` and what is left over.
 *
 * The passthrough is read from the raw command line, not from oclif's parsed `argv`. oclif
 * sorts `argv` by where each token FIRST appears on the command line, so a flag given twice
 * (`-- --source-dir A --source-dir B`) came out as `--source-dir --source-dir A B`, and a
 * token that also appears before the separator, such as `--dry-run` or a branch name, moved
 * to the front.
 *
 * `parsedArgs` is oclif's `argv`, which holds every positional argument, before and after
 * the separator. Whatever it holds beyond the passthrough came before `--`.
 */
export function passthroughArgs(rawArgv: readonly string[], parsedArgs: readonly string[]): Passthrough {
  const separator = rawArgv.indexOf('--');
  const passthrough = separator < 0 ? [] : rawArgv.slice(separator + 1);
  const remaining = [...passthrough];
  const unexpected: string[] = [];
  for (const arg of parsedArgs) {
    const at = remaining.indexOf(arg);
    if (at < 0) unexpected.push(arg);
    else remaining.splice(at, 1);
  }
  return { passthrough, unexpected };
}

/**
 * Build the deploy arguments.
 *
 * A fallback deploys at the configured full level; otherwise `RunSpecifiedTests` with the
 * selected list. The selection is complete rather than minimal, so per-class coverage is
 * unchanged (see `coverage.ts` for the argument and its preconditions).
 */
export function buildDeployPlan(
  result: AnalysisResult,
  config: Config,
  passthrough: readonly string[] = [],
): DeployPlan {
  if (result.outcome === 'full') {
    const reason = result.decisions.find((d) => d.level === 'fallback');
    return {
      args: ['--test-level', config.fullTestLevel, ...passthrough],
      testLevel: config.fullTestLevel,
      tests: [],
      rationale:
        reason === undefined
          ? `Running ${config.fullTestLevel}.`
          : `Running ${config.fullTestLevel}: ${reason.rule} (${reason.subject}).`,
    };
  }

  const tests = result.tests.map((t) => t.name);
  if (tests.length === 0) {
    // `RunSpecifiedTests` with an empty list is rejected by the platform, and silently
    // deploying with no tests at all would be a much worse answer than saying so.
    return {
      args: ['--test-level', 'NoTestRun', ...passthrough],
      testLevel: 'NoTestRun',
      tests: [],
      rationale: 'No test is affected by this change set, so no test is run.',
    };
  }

  return {
    // One `--tests` per test, NOT a comma-separated list. `sf project deploy start` rejects
    // the comma form outright: "The previous version of this command used a comma-separated
    // list for tests. We've changed how you specify multiple tests". Repeating the flag is
    // the form it documents first, and it is the only one that stays unambiguous if a test
    // name ever contains a space.
    args: [
      '--test-level',
      'RunSpecifiedTests',
      ...tests.flatMap((name) => ['--tests', name]),
      ...passthrough,
    ],
    testLevel: 'RunSpecifiedTests',
    tests,
    rationale: `Running ${tests.length} of ${result.totalTests} tests (RunSpecifiedTests).`,
  };
}

/**
 * Stage 3 of the false-negative harness: execute the suite at each commit against an org.
 *
 * This is the only stage that needs credentials, and it is written so that none of its logic
 * does. `deploy`, `runTests` and `select` are injected, so every branch below — a clean
 * commit, a failing commit, a deploy failure, a flaky test, a resume — is exercised in the
 * unit tests with fakes and no org.
 *
 * Two things this driver must get right, because they are the difference between a
 * measurement and a plausible-looking number:
 *
 * - It runs the **full** suite, never the selection. The metric is defined over tests the
 *   selector chose to skip, so recording only the selected subset would make a false negative
 *   unobservable by construction — the harness would be incapable of ever finding one.
 * - A commit that cannot be deployed or run is recorded as *excluded with a reason*, never
 *   dropped. Silently skipping infrastructure failures biases the window in a direction
 *   nobody can see afterwards.
 */

import { sfJsonAdapter, type TestOutcome } from './adapters.js';
import {
  type ObservationStore,
  type StoredCommit,
} from './observationStore.js';

/** What the selector said for one commit. Produced offline by `analyze`. */
export interface SelectionAtCommit {
  /** Test class names the tool selected. */
  readonly selected: readonly string[];
  readonly fellBack: boolean;
  readonly totalTests: number;
}

export interface DeployResult {
  readonly ok: boolean;
  /** Why the deploy failed. Recorded as the exclusion reason, after redaction. */
  readonly reason?: string;
}

export interface TestRunResult {
  readonly ok: boolean;
  readonly results: readonly TestOutcome[];
  readonly reason?: string;
}

/**
 * Everything that touches an org or the working tree, injected.
 *
 * `runTests` takes an optional list of specific tests: the driver uses that to re-run only
 * the failures when checking for flakiness. An implementation that ignores the argument and
 * always runs everything is still correct, just slower.
 */
export interface ExecuteDeps {
  deploy(commit: string): DeployResult;
  runTests(commit: string, only?: readonly string[]): TestRunResult;
  select(commit: string): SelectionAtCommit;
  /** Progress reporting. Defaults to a no-op so tests stay quiet. */
  log?(message: string): void;
}

export interface ExecuteOptions {
  /**
   * Re-run failing tests once at the same commit to identify flakes.
   *
   * On by default. Re-running only the failures is far cheaper than repeating the whole
   * suite N times, and failures are the only outcome that can put a spurious entry in the
   * numerator. It does not detect a test that flakily *passes*; that is a known limitation,
   * recorded in the change's design.
   */
  readonly recheckFailures?: boolean;
  /** Treat the first commit as a baseline: outcomes only, no selection scored against it. */
  readonly firstCommitIsBaseline?: boolean;
}

export interface ExecuteReport {
  readonly attempted: number;
  readonly recorded: number;
  readonly skippedAlreadyRecorded: number;
  readonly excluded: readonly { readonly commit: string; readonly reason: string }[];
  /** `class.method` ids that failed then passed on re-run, per commit. */
  readonly flakyObserved: readonly { readonly commit: string; readonly test: string }[];
}

const testId = (t: TestOutcome): string => `${t.className}.${t.methodName}`;

/**
 * Run the window, appending to the store as it goes.
 *
 * Commits already present in the store are skipped, which is what makes an interrupted run
 * resumable: the caller passes the same window and the driver picks up where it stopped.
 */
export function executeWindow(
  deps: ExecuteDeps,
  store: ObservationStore,
  commits: readonly string[],
  options: ExecuteOptions = {},
): ExecuteReport {
  const recheckFailures = options.recheckFailures ?? true;
  const log = (message: string): void => deps.log?.(message);

  const excluded: { commit: string; reason: string }[] = [];
  const flakyObserved: { commit: string; test: string }[] = [];
  let recorded = 0;
  let skippedAlreadyRecorded = 0;

  for (const [index, commit] of commits.entries()) {
    if (store.has(commit)) {
      skippedAlreadyRecorded++;
      continue;
    }

    log(`[${index + 1}/${commits.length}] ${commit}`);

    const deployed = deps.deploy(commit);
    if (!deployed.ok) {
      const reason = redactSecrets(`deploy failed: ${deployed.reason ?? 'no reason reported'}`);
      store.append(excludedRecord(commit, reason));
      excluded.push({ commit, reason });
      log(`  excluded: ${reason}`);
      continue;
    }

    const run = deps.runTests(commit);
    if (!run.ok) {
      const reason = redactSecrets(`test run failed: ${run.reason ?? 'no reason reported'}`);
      store.append(excludedRecord(commit, reason));
      excluded.push({ commit, reason });
      log(`  excluded: ${reason}`);
      continue;
    }

    // A run that succeeds but reports nothing is not a clean commit — it is a commit whose
    // outcomes we do not have. Recording it as "no failures" would be a fabricated pass.
    if (run.results.length === 0) {
      const reason = 'test run reported no outcomes';
      store.append(excludedRecord(commit, reason));
      excluded.push({ commit, reason });
      log(`  excluded: ${reason}`);
      continue;
    }

    let results = run.results;
    const flakyHere: string[] = [];

    if (recheckFailures) {
      const failed = results.filter((r) => r.outcome === 'Fail');
      if (failed.length > 0) {
        const recheck = deps.runTests(commit, failed.map(testId));
        if (recheck.ok) {
          const passedOnRetry = new Set(
            recheck.results.filter((r) => r.outcome === 'Pass').map(testId),
          );
          for (const t of failed) {
            if (passedOnRetry.has(testId(t))) flakyHere.push(testId(t));
          }
          // The re-run's outcomes are NOT merged into `results`. The first run is the
          // observation; the re-run only answers "was that reproducible". Overwriting a Fail
          // with the retry's Pass would erase the failure the metric exists to count.
          if (flakyHere.length > 0) {
            log(`  flaky at this commit: ${flakyHere.join(', ')}`);
            for (const t of flakyHere) flakyObserved.push({ commit, test: t });
          }
        } else {
          // A failed re-check leaves flakiness unknown for this commit. The window-level
          // flake detection in the scorer still applies; claiming "not flaky" here would be
          // an assertion the run did not support.
          log(`  flake re-check failed: ${recheck.reason ?? 'no reason reported'}`);
        }
      }
      results = run.results;
    }

    const baselineOnly = (options.firstCommitIsBaseline ?? false) && index === 0;
    const selection = baselineOnly
      ? { selected: [], fellBack: false, totalTests: 0 }
      : deps.select(commit);

    store.append({
      commit,
      results,
      selected: selection.selected,
      fellBack: selection.fellBack,
      totalTests: selection.totalTests,
      ...(baselineOnly ? { baselineOnly: true } : {}),
      ...(flakyHere.length > 0 ? { flakyHere } : {}),
    });
    recorded++;
  }

  return {
    attempted: commits.length,
    recorded,
    skippedAlreadyRecorded,
    excluded,
    flakyObserved,
  };
}

function excludedRecord(commit: string, reason: string): StoredCommit {
  return { commit, results: [], selected: [], fellBack: false, totalTests: 0, excluded: reason };
}

// ---------------------------------------------------------------------------------------
// Credential hygiene
// ---------------------------------------------------------------------------------------

/**
 * Patterns that must never reach an artifact.
 *
 * Exclusion reasons are captured from CLI stderr, which is exactly where a token or an
 * instance URL turns up when authentication goes wrong. The reason is the most useful field
 * in the store for diagnosing a bad run, so it is redacted rather than dropped.
 *
 * This is a backstop, not the primary control: the driver never receives credentials in the
 * first place, because it obtains sessions only through injected functions that talk to the
 * `sf` CLI's own authenticated state.
 */
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]+/g, label: '[redacted-access-token]' },
  { pattern: /\b5Aep[A-Za-z0-9._-]{20,}/g, label: '[redacted-refresh-token]' },
  { pattern: /https:\/\/[A-Za-z0-9.-]*\.my\.salesforce\.com\S*/g, label: '[redacted-instance-url]' },
  { pattern: /https:\/\/[A-Za-z0-9.-]*\.salesforce\.com\/services\/\S*/g, label: '[redacted-session-url]' },
  { pattern: /\bsfdxAuthUrl:\S+/gi, label: '[redacted-auth-url]' },
  { pattern: /force:\/\/\S+/g, label: '[redacted-auth-url]' },
];

/** Strip anything credential-shaped from text bound for an artifact. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, label } of SECRET_PATTERNS) out = out.replace(pattern, label);
  return out;
}

// ---------------------------------------------------------------------------------------
// Wiring the sf CLI to the driver
// ---------------------------------------------------------------------------------------

/** Runs a command and returns its stdout, or throws. Injected so no test spawns a process. */
export type CommandRunner = (argv: readonly string[]) => string;

/**
 * Build a `runTests` from a command runner, parsing with the existing `sfJsonAdapter`.
 *
 * JSON is used rather than the human report because for runs we control it is authoritative
 * and stable; `sfHumanAdapter` exists for reading historical CI logs where JSON was never
 * captured, which is a different problem.
 */
export function makeCliTestRunner(run: CommandRunner): ExecuteDeps['runTests'] {
  return (_commit, only) => {
    const argv = ['apex', 'run', 'test', '--result-format', 'json', '--wait', '60'];
    if (only !== undefined && only.length > 0) {
      argv.push('--test-level', 'RunSpecifiedTests');
      // One --tests per test: `sf` rejects a comma-separated list.
      for (const t of only) argv.push('--tests', t);
    } else {
      argv.push('--test-level', 'RunLocalTests');
    }

    let stdout: string;
    try {
      stdout = run(argv);
    } catch (error) {
      return { ok: false, results: [], reason: redactSecrets(describeError(error)) };
    }

    try {
      const parsed = sfJsonAdapter.parse(stdout);
      return { ok: true, results: parsed.results };
    } catch (error) {
      return { ok: false, results: [], reason: redactSecrets(`could not parse test output: ${describeError(error)}`) };
    }
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

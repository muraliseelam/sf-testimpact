/**
 * The seam between the execution driver and the `sf` CLI.
 *
 * `bench/execute.js` is the only code that spawns `sf`, and it is deliberately thin: it
 * runs a process and hands the exit status, stdout and stderr to the functions here. Every
 * decision about what that output *means* is made in this module, so it is unit-tested with
 * recorded outputs and never with an org.
 *
 * Two of those decisions would silently corrupt the measurement if made the obvious way:
 *
 * - **A failing test run is a completed run.** `sf apex run test` exits non-zero when any
 *   test fails. A runner that treated non-zero exit as "the run broke" would exclude every
 *   commit with a failing test — exactly the commits the false-negative metric is built from.
 *   `testRunStdoutFromProcess` therefore trusts the output, not the exit code.
 * - **A deploy failure is a reason, not a stack trace.** The reason is written into the
 *   observation store, so it is kept short and passed through `redactSecrets`.
 */

import { type AnalysisResult } from '../query/analyze.js';
import { redactSecrets, type DeployResult, type SelectionAtCommit } from './execute.js';
import { type WindowIdentity } from './observationStore.js';

/** What a spawned process left behind. `error` is set when it never ran at all. */
export interface ProcessOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** The envelope `sf --json` prints. Only the fields this module reads. */
export interface SfJsonEnvelope {
  readonly status?: number;
  readonly name?: string;
  readonly message?: string;
  readonly result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse an `sf` JSON payload, tolerating anything printed before the first `{`.
 *
 * `sf` writes its JSON to stdout and its warnings to stderr, so stdout is normally clean.
 * A plugin that prints a notice to stdout anyway should not make the whole run unreadable,
 * so parsing starts at the first brace rather than at byte zero.
 */
export function parseSfJson(stdout: string): SfJsonEnvelope | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Longest reason written to the store. Enough to diagnose; not a log dump. */
const MAX_REASON_LENGTH = 600;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_REASON_LENGTH ? trimmed : `${trimmed.slice(0, MAX_REASON_LENGTH)}…`;
}

interface ComponentFailure {
  readonly componentType?: string;
  readonly fullName?: string;
  readonly problem?: string;
}

function componentFailuresOf(result: unknown): readonly ComponentFailure[] {
  if (!isRecord(result)) return [];
  const details = result['details'];
  if (!isRecord(details)) return [];
  const failures = details['componentFailures'];
  if (failures === undefined || failures === null) return [];
  const list: unknown[] = Array.isArray(failures) ? (failures as unknown[]) : [failures];
  return list.filter(isRecord);
}

/** How many component failures a reason names before summarising. */
const FAILURE_PREVIEW_LIMIT = 5;

/**
 * Interpret the outcome of `sf project deploy start --json`.
 *
 * Exit 0 is success whatever the payload looks like: a tracked deploy with nothing to deploy
 * still exits 0, and so does a deploy whose JSON a future CLI reshapes. Anything else is a
 * failure whose reason is taken, in order of usefulness, from the component failures, the
 * CLI's own message, stderr, or the bare exit status.
 */
export function deployResultFromProcess(outcome: ProcessOutcome): DeployResult {
  if (outcome.error !== undefined) {
    return { ok: false, reason: redactSecrets(clip(`sf did not run: ${outcome.error}`)) };
  }
  if (outcome.status === 0) return { ok: true };

  const doc = parseSfJson(outcome.stdout);
  if (doc !== null && isRecord(doc.result) && doc.result['success'] === true) return { ok: true };

  const failures = doc === null ? [] : componentFailuresOf(doc.result);
  if (failures.length > 0) {
    const shown = failures
      .slice(0, FAILURE_PREVIEW_LIMIT)
      .map((f) => `${f.componentType ?? 'component'} ${f.fullName ?? '?'}: ${f.problem ?? 'no problem text'}`)
      .join('; ');
    const more = failures.length > FAILURE_PREVIEW_LIMIT ? ` (and ${failures.length - FAILURE_PREVIEW_LIMIT} more)` : '';
    return {
      ok: false,
      reason: redactSecrets(clip(`${failures.length} component failure(s): ${shown}${more}`)),
    };
  }

  const message = doc?.message;
  if (typeof message === 'string' && message.trim() !== '') {
    const name = typeof doc?.name === 'string' && doc.name !== '' ? `${doc.name}: ` : '';
    return { ok: false, reason: redactSecrets(clip(`${name}${message}`)) };
  }

  const stderr = outcome.stderr.trim();
  if (stderr !== '') return { ok: false, reason: redactSecrets(clip(stderr)) };

  return { ok: false, reason: `sf exited with status ${outcome.status ?? 'unknown'} and no output` };
}

function looksLikeTestResults(stdout: string): boolean {
  const doc = parseSfJson(stdout);
  if (doc === null) return false;
  const tests = isRecord(doc.result) ? doc.result['tests'] : (doc as Record<string, unknown>)['tests'];
  return Array.isArray(tests);
}

/**
 * The stdout of `sf apex run test`, or a thrown error when the run did not complete.
 *
 * `sf apex run test` exits non-zero when any test fails, and failing tests are the point of
 * this harness. So the exit status does not decide anything on its own: output that carries
 * a `tests` array is a completed run regardless of status, and output that does not is a
 * broken run regardless of status. The thrown message is redacted because the driver writes
 * it into the store as the exclusion reason.
 */
export function testRunStdoutFromProcess(outcome: ProcessOutcome): string {
  if (outcome.error !== undefined) {
    throw new Error(redactSecrets(clip(`sf did not run: ${outcome.error}`)));
  }
  if (looksLikeTestResults(outcome.stdout)) return outcome.stdout;
  if (outcome.status === 0) return outcome.stdout;

  const doc = parseSfJson(outcome.stdout);
  const message = doc?.message;
  const detail =
    typeof message === 'string' && message.trim() !== ''
      ? message
      : outcome.stderr.trim() !== ''
        ? outcome.stderr
        : outcome.stdout.trim() !== ''
          ? outcome.stdout
          : 'no output';
  throw new Error(
    redactSecrets(clip(`sf apex run test exited with status ${outcome.status ?? 'unknown'}: ${detail}`)),
  );
}

/** The selection record the store keeps, from an `analyze` result. */
export function toSelection(analysis: AnalysisResult): SelectionAtCommit {
  return {
    selected: analysis.tests.map((t) => t.name),
    fellBack: analysis.outcome === 'full',
    totalTests: analysis.totalTests,
  };
}

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * Commit SHAs from `git rev-list` output, oldest first as `--reverse` produces them.
 *
 * Anything that is not a SHA is refused rather than skipped: a stray line here would become
 * a commit the driver tries to deploy, or worse, a commit silently missing from the window.
 */
export function parseRevList(text: string): string[] {
  const shas: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '') continue;
    if (!SHA.test(line)) {
      throw new Error(`git rev-list output line ${index + 1} is not a commit SHA: ${JSON.stringify(line)}`);
    }
    shas.push(line);
  }
  return shas;
}

/**
 * The commits the driver executes for a window, and the identity the store is keyed by.
 *
 * The base commit itself is executed first, as a baseline: the scorer defines a false
 * negative against the *previous* observation, so without the base's outcomes the first real
 * commit's failures could never be scored. `commitCount` counts the baseline, because it is
 * executed and recorded like any other commit and the identity guard must see the same
 * number on every run.
 */
export function windowFor(
  repo: string,
  baseSha: string,
  headSha: string,
  revList: readonly string[],
): { readonly identity: WindowIdentity; readonly commits: readonly string[] } {
  const commits = [baseSha, ...revList.filter((c) => c !== baseSha)];
  return {
    identity: { repo, baseSha, headSha, commitCount: commits.length },
    commits,
  };
}

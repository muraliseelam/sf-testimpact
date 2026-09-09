/**
 * Resumable persistence for per-commit test outcomes.
 *
 * A window of ~200 commits, each needing a deploy and a full suite run, is measured in hours
 * of org time. A run that loses everything on interruption cannot be finished in practice, so
 * outcomes are appended after every commit rather than written once at the end.
 *
 * The format is newline-delimited JSON: one header record, then one record per commit. NDJSON
 * is chosen precisely because it degrades well. A process killed mid-write leaves a truncated
 * final line, and a truncated line is *detectably* incomplete — it fails to parse — whereas a
 * partially-written JSON array is indistinguishable from a complete one that happens to be
 * short. `load` discards a trailing unparseable line and reports the commit as absent, so the
 * next run redoes exactly that commit and nothing else.
 *
 * The store is keyed by window identity. Appending outcomes gathered from one commit range
 * into a store built for another would produce a result corresponding to no experiment that
 * was ever run, and nothing downstream could detect it afterwards. That is made impossible
 * here rather than documented as a caveat.
 */

import { type CommitObservation } from './falseNegatives.js';
import { type TestOutcome } from './adapters.js';

/** Identity of the commit range a store belongs to. */
export interface WindowIdentity {
  /** Repository the window was taken from, for the reader's benefit. */
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly commitCount: number;
}

/** Why a commit produced no outcomes. Recorded, never silently dropped. */
export interface ExcludedCommit {
  readonly commit: string;
  readonly reason: string;
}

/** One commit's recorded outcomes, or the reason it has none. */
export interface StoredCommit {
  readonly commit: string;
  readonly results: readonly TestOutcome[];
  readonly selected: readonly string[];
  readonly fellBack: boolean;
  readonly totalTests: number;
  readonly baselineOnly?: boolean;
  /** Tests that failed then passed on re-run at this same commit. */
  readonly flakyHere?: readonly string[];
  /** Present when the commit yielded no outcomes at all. */
  readonly excluded?: string;
}

export interface StoreContents {
  readonly window: WindowIdentity;
  readonly commits: readonly StoredCommit[];
  /**
   * A trailing line that could not be parsed was discarded.
   *
   * Surfaced rather than swallowed: it means a previous run was interrupted mid-write, which
   * the operator should know even though the store itself is fine.
   */
  readonly truncatedTailDiscarded: boolean;
}

/**
 * The filesystem operations the store needs, injected.
 *
 * Deliberately narrower than `graph/store.ts`'s `FileSystem`: this one appends. Sharing that
 * interface would mean either widening it for a consumer that does not need most of it, or
 * pretending an append is a read-modify-write, which is exactly the thing that loses data
 * when a run is interrupted.
 */
export interface AppendOnlyFileSystem {
  readFile(path: string): string;
  /** Appends to the file, creating it if absent. Must not truncate. */
  appendFile(path: string, contents: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

/** Raised when the requested window does not match the one already in the store. */
export class WindowMismatchError extends Error {
  readonly stored: WindowIdentity;
  readonly requested: WindowIdentity;

  constructor(stored: WindowIdentity, requested: WindowIdentity) {
    super(
      'This store was written for a different commit window. Refusing to mix them.\n' +
        `  stored:    ${describeWindow(stored)}\n` +
        `  requested: ${describeWindow(requested)}\n` +
        'Use a different store path, or delete the existing one to start over.',
    );
    this.name = 'WindowMismatchError';
    this.stored = stored;
    this.requested = requested;
  }
}

function describeWindow(w: WindowIdentity): string {
  return `${w.repo} ${w.baseSha}..${w.headSha} (${w.commitCount} commits)`;
}

function sameWindow(a: WindowIdentity, b: WindowIdentity): boolean {
  return (
    a.repo === b.repo &&
    a.baseSha === b.baseSha &&
    a.headSha === b.headSha &&
    a.commitCount === b.commitCount
  );
}

interface HeaderRecord {
  readonly kind: 'window';
  readonly window: WindowIdentity;
}

interface CommitRecord extends StoredCommit {
  readonly kind: 'commit';
}

/**
 * Read a store from disk.
 *
 * Returns null when the file does not exist, which is the ordinary "first run" case and not
 * an error. A file that exists but has no parseable header IS an error: continuing would mean
 * appending to something whose provenance is unknown.
 */
export function loadStore(fs: AppendOnlyFileSystem, path: string): StoreContents | null {
  if (!fs.exists(path)) return null;

  const raw = fs.readFile(path);
  const lines = raw.split('\n');

  let window: WindowIdentity | null = null;
  const commits: StoredCommit[] = [];
  let truncatedTailDiscarded = false;

  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (text === '') continue;

    let record: HeaderRecord | CommitRecord;
    try {
      record = JSON.parse(text) as HeaderRecord | CommitRecord;
    } catch {
      // Only the FINAL line may be truncated - that is what an interrupted append leaves.
      // A bad line anywhere else means the file was edited or corrupted, and silently
      // skipping it would drop a commit's outcomes without anyone noticing.
      const isLastNonEmpty = lines.slice(index + 1).every((l) => l.trim() === '');
      if (isLastNonEmpty) {
        truncatedTailDiscarded = true;
        break;
      }
      throw new Error(
        `Observation store ${path} is corrupt at line ${index + 1}: not valid JSON, and it is ` +
          'not the final line, so this is not an interrupted write.',
      );
    }

    if (record.kind === 'window') window = record.window;
    else if (record.kind === 'commit') {
      const { kind, ...rest } = record;
      void kind;
      commits.push(rest);
    }
  }

  if (window === null) {
    throw new Error(
      `Observation store ${path} has no window header. Refusing to append to a store whose ` +
        'commit range is unknown.',
    );
  }

  return { window, commits, truncatedTailDiscarded };
}

export interface OpenResult {
  readonly store: ObservationStore;
  /** Commits already recorded, in the order they were written. */
  readonly recorded: readonly string[];
  /** True when a partial trailing line was found and discarded. */
  readonly resumedAfterInterruption: boolean;
}

/**
 * Open a store for the given window, creating it if absent.
 *
 * Throws `WindowMismatchError` when an existing store belongs to a different window.
 */
export function openStore(
  fs: AppendOnlyFileSystem,
  path: string,
  window: WindowIdentity,
): OpenResult {
  const existing = loadStore(fs, path);

  if (existing === null) {
    const dir = path.replace(/[\\/][^\\/]*$/, '');
    if (dir !== path && dir !== '') fs.mkdirp(dir);
    fs.appendFile(path, `${JSON.stringify({ kind: 'window', window } satisfies HeaderRecord)}\n`);
    return { store: new ObservationStore(fs, path, window, []), recorded: [], resumedAfterInterruption: false };
  }

  if (!sameWindow(existing.window, window)) {
    throw new WindowMismatchError(existing.window, window);
  }

  const recorded = existing.commits.map((c) => c.commit);
  return {
    store: new ObservationStore(fs, path, window, existing.commits),
    recorded,
    resumedAfterInterruption: existing.truncatedTailDiscarded,
  };
}

export class ObservationStore {
  private readonly fs: AppendOnlyFileSystem;
  private readonly path: string;
  readonly window: WindowIdentity;
  private readonly commits: StoredCommit[];
  private readonly seen: Set<string>;

  constructor(
    fs: AppendOnlyFileSystem,
    path: string,
    window: WindowIdentity,
    existing: readonly StoredCommit[],
  ) {
    this.fs = fs;
    this.path = path;
    this.window = window;
    this.commits = [...existing];
    this.seen = new Set(this.commits.map((c) => c.commit));
  }

  /** Commits already recorded, in write order. */
  recordedCommits(): readonly string[] {
    return this.commits.map((c) => c.commit);
  }

  has(commit: string): boolean {
    return this.seen.has(commit);
  }

  /**
   * Append one commit's record.
   *
   * Re-recording a commit is refused rather than accepted as an update. Two records for one
   * commit would make the observation sequence ambiguous, and the scorer reads it as an
   * ordered series where each entry is the predecessor of the next.
   */
  append(record: StoredCommit): void {
    if (this.seen.has(record.commit)) {
      throw new Error(
        `Commit ${record.commit} is already recorded in ${this.path}. Refusing to write it ` +
          'twice: the scorer reads this file as an ordered series, and a duplicate would make ' +
          'the predecessor of the next commit ambiguous.',
      );
    }
    this.fs.appendFile(this.path, `${JSON.stringify({ kind: 'commit', ...record } satisfies CommitRecord)}\n`);
    this.commits.push(record);
    this.seen.add(record.commit);
  }

  /** Every record, in write order. */
  all(): readonly StoredCommit[] {
    return [...this.commits];
  }

  /** Commits recorded with no outcomes, and why. */
  excluded(): readonly ExcludedCommit[] {
    return this.commits
      .filter((c) => c.excluded !== undefined)
      .map((c) => ({ commit: c.commit, reason: c.excluded ?? '' }));
  }

  /**
   * The observations the scorer consumes.
   *
   * Excluded commits are dropped here, not earlier: they are kept in the store so the run can
   * report which commits were skipped and why, but they carry no outcomes, and feeding an
   * empty result set to the scorer would read as "every test passed" — which would make a
   * deploy failure look like evidence of correctness.
   */
  toObservations(): readonly CommitObservation[] {
    return this.commits
      .filter((c) => c.excluded === undefined)
      .map((c) => ({
        commit: c.commit,
        results: c.results,
        selected: c.selected,
        fellBack: c.fellBack,
        totalTests: c.totalTests,
        ...(c.baselineOnly === true ? { baselineOnly: true } : {}),
      }));
  }
}

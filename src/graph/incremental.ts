/**
 * Incremental re-indexing (DESIGN.md 4.4).
 *
 * Planning is a pure function over file hashes, so it is testable without a filesystem and
 * without a parser.
 */

import { type FileFacts } from '../types.js';
import { type IndexedFile } from './model.js';

/** A file currently on disk, with its content hash. */
export interface ScannedFile {
  readonly path: string;
  readonly hash: string;
}

export interface ReindexPlan {
  /** Files whose hash is unchanged: their stored facts are reused verbatim. */
  readonly unchanged: readonly string[];
  /** Files present before and now, with different contents. Must be re-extracted. */
  readonly changed: readonly string[];
  /** Files not previously indexed. Must be extracted. */
  readonly added: readonly string[];
  /** Files that were indexed and are now gone. Their facts are dropped. */
  readonly removed: readonly string[];
}

export function planReindex(
  indexed: readonly IndexedFile[],
  scanned: readonly ScannedFile[],
): ReindexPlan {
  const previous = new Map(indexed.map((f) => [f.path, f]));
  const current = new Map(scanned.map((f) => [f.path, f]));

  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];

  for (const file of scanned) {
    const before = previous.get(file.path);
    if (before === undefined) added.push(file.path);
    else if (before.hash === file.hash) unchanged.push(file.path);
    else changed.push(file.path);
  }

  const removed = indexed.filter((f) => !current.has(f.path)).map((f) => f.path);
  return { unchanged, changed, added, removed };
}

/** Files that must be handed to an extractor for this plan. */
export function filesToExtract(plan: ReindexPlan): readonly string[] {
  return [...plan.changed, ...plan.added];
}

/**
 * Combine reused facts with freshly extracted ones.
 *
 * Facts for changed, added and removed files are dropped from the reused set first, so a
 * file cannot contribute two generations of facts at once. Ordering is by path, which makes
 * the written index byte-stable for a given input and therefore diffable and cacheable.
 */
export function mergeFacts(
  stored: readonly FileFacts[],
  fresh: readonly FileFacts[],
  plan: ReindexPlan,
): FileFacts[] {
  const superseded = new Set<string>([...plan.changed, ...plan.added, ...plan.removed]);
  const merged = [...stored.filter((f) => !superseded.has(f.path)), ...fresh];
  return merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The file table for the merged facts. */
export function mergeFiles(
  stored: readonly IndexedFile[],
  fresh: readonly IndexedFile[],
  plan: ReindexPlan,
): IndexedFile[] {
  const superseded = new Set<string>([...plan.changed, ...plan.added, ...plan.removed]);
  return [...stored.filter((f) => !superseded.has(f.path)), ...fresh].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

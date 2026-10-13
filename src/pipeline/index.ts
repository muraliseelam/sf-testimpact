/**
 * The `index` pipeline: walk, hash, extract, resolve, persist.
 *
 * All I/O is injected, so the whole pipeline runs in tests against an in-memory project
 * with no filesystem, no network and no org.
 */

import { extractFile, isModelledPath } from '../extract/index.js';
import {
  filesToExtract,
  mergeFacts,
  mergeFiles,
  planReindex,
  type ReindexPlan,
  type ScannedFile,
} from '../graph/incremental.js';
import { type IndexedFile, type ImpactGraph, type ProjectInfo } from '../graph/model.js';
import {
  buildGraph,
  checkStaleness,
  currentGenerator,
  hashBytes,
  hashContents,
  loadGraph,
  saveGraph,
  type FileSystem,
  type StalenessReason,
} from '../graph/store.js';
import { type FileFacts } from '../types.js';

/** Enumerates candidate source files. Injected so tests need no directory tree. */
export type FileWalker = (sourcePaths: readonly string[]) => readonly string[];

export interface IndexDeps {
  readonly fs: FileSystem;
  readonly walk: FileWalker;
  readonly now: () => Date;
  /** Progress callback; the command turns this into a spinner. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface IndexOptions {
  readonly root: string;
  readonly project: ProjectInfo;
  /** Discard any existing index and re-extract everything. */
  readonly force?: boolean;
}

export interface IndexResult {
  readonly graph: ImpactGraph;
  readonly plan: ReindexPlan;
  readonly path: string;
  readonly extracted: number;
  readonly reused: number;
  /**
   * Why the stored index was discarded and every file re-extracted, or null when it was not.
   *
   * Set when the stored index was written by a different format version, parser major
   * version or extractor identity than this build — typically after upgrading the plugin.
   */
  readonly rebuiltStale: StalenessReason | null;
}

export function runIndex(deps: IndexDeps, options: IndexOptions): IndexResult {
  const stored = options.force === true ? null : loadGraph(deps.fs, options.root);
  // A stored index from a different build cannot be extended: reusing its facts for the
  // unchanged files would mix two generations of extractor output, which is exactly what
  // the staleness check exists to refuse, and every `analyze` would then fall back with
  // "run index --force". So a stale index is treated as absent and everything is
  // re-extracted, as `--force` would. Before this, a plain `index` after an upgrade kept the
  // stale facts and left the project falling back until someone forced a rebuild by hand.
  const rebuiltStale = stored === null ? null : checkStaleness(stored);
  const existing = rebuiltStale === null ? stored : null;

  // Hash from raw bytes where the filesystem can supply them. An incremental index must
  // read every candidate file to prove it is unchanged, so this read is the floor on how
  // fast the operation can be; decoding each file to UTF-8 only to re-encode it for the
  // digest doubles that floor for no benefit.
  const hashOf = (path: string): string => {
    const bytes = deps.fs.readBytes?.(path);
    return bytes === undefined ? hashContents(deps.fs.readFile(path)) : hashBytes(bytes);
  };
  const scanned: ScannedFile[] = deps
    .walk(options.project.sourcePaths)
    .filter(isModelledPath)
    .map((path) => ({ path, hash: hashOf(path) }));

  const plan = planReindex(existing?.files ?? [], scanned);
  const toExtract = filesToExtract(plan);

  const fresh: FileFacts[] = [];
  const freshFiles: IndexedFile[] = [];
  let done = 0;
  for (const path of toExtract) {
    const contents = deps.fs.readFile(path);
    const facts = extractFile(path, contents);
    // isModelledPath already filtered the walk, so a null here means the two disagree —
    // a bug in dispatch rather than an unmodelled file. Skipping silently would hide it.
    if (facts === null) continue;
    fresh.push(facts);
    freshFiles.push({
      path,
      hash: hashOf(path),
      parsedOk: facts.parsedOk,
      extractor: facts.extractor,
    });
    deps.onProgress?.(++done, toExtract.length);
  }

  const facts = mergeFacts(existing?.facts ?? [], fresh, plan);
  const files = mergeFiles(existing?.files ?? [], freshFiles, plan);
  const generator = currentGenerator();
  const createdAt = deps.now().toISOString();

  const graph = buildGraph(files, facts, options.project, generator, createdAt);
  const path = saveGraph(deps.fs, {
    root: options.root,
    files,
    facts,
    project: options.project,
    generator,
    createdAt,
  });

  return { graph, plan, path, extracted: fresh.length, reused: plan.unchanged.length, rebuiltStale };
}

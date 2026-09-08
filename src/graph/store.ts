/**
 * Reading and writing `.sf-testimpact/graph.json`, and detecting a stale index.
 *
 * Filesystem access is injected so the tests are real rather than ceremonial.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { TestImpactError } from '../errors.js';
import { ALL_EXTRACTOR_IDS } from '../extract/index.js';
import { joinPath } from '../paths.js';
import { resolve as resolveGraph } from '../resolve/resolver.js';
import { APEX_PARSER_VERSION, GRAPH_FORMAT_VERSION, TOOL_VERSION, majorVersion } from '../version.js';
import { ImpactGraph, type GraphGenerator, type IndexedFile, type ProjectInfo } from './model.js';
import {
  deserializeGraph,
  serializeGraph,
  type SerializedGraph,
  type SerializeInput,
} from './serialize.js';

export const GRAPH_DIR = '.sf-testimpact';
export const GRAPH_FILE = 'graph.json';
/** Suffix used when the serialised index exceeds `GZIP_THRESHOLD_BYTES`. */
export const GZIP_SUFFIX = '.gz';

/** The filesystem operations the store needs. Injected so tests need no temp directories. */
export interface FileSystem {
  readFile(path: string): string;
  /**
   * Raw bytes, when the implementation can provide them.
   *
   * Optional so an in-memory test filesystem needs only `readFile`. Hashing bytes directly
   * skips a UTF-8 decode followed immediately by a re-encode, which profiling showed to be
   * the dominant cost of an incremental index — not the graph work it was assumed to be.
   */
  readBytes?(path: string): Uint8Array;
  writeFile(path: string, contents: string): void;
  /** Raw bytes. Required for the gzipped index; without it the plain form is always used. */
  writeBytes?(path: string, bytes: Uint8Array): void;
  /**
   * Atomic replace (DESIGN.md 4.4).
   *
   * Optional because an in-memory test filesystem does not need it, but every real
   * implementation should provide it: without a rename the "write temp, then swap" sequence
   * degrades to a copy, and an interrupted run leaves a half-written index in place.
   */
  rename?(from: string, to: string): void;
  /** Deletes a path if it exists. Used to clean up temp files and stale index variants. */
  remove?(path: string): void;
  mkdirp(path: string): void;
  exists(path: string): boolean;
}

/**
 * Serialised size above which the index is gzipped on disk (DESIGN.md 4.4).
 *
 * Not hypothetical: NPSP's graph is ~8.5 MB, so a real project of that size crosses it.
 */
export const GZIP_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** sha256 of a file's contents, used to skip unchanged files on re-index. */
export function hashContents(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * sha256 of raw bytes.
 *
 * For valid UTF-8 this is the same digest `hashContents` produces, because `update(str,
 * 'utf8')` encodes to exactly these bytes. It differs only for content that is not valid
 * UTF-8, where the decode is lossy — and for those files the byte hash is the more faithful
 * fingerprint of the two.
 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function currentGenerator(): GraphGenerator {
  return {
    formatVersion: GRAPH_FORMAT_VERSION,
    toolVersion: TOOL_VERSION,
    apexParserVersion: APEX_PARSER_VERSION,
  };
}

/**
 * Why a persisted graph cannot be trusted (DESIGN.md 7.3).
 *
 * Each carries the observed and expected values, because "your index is stale" without
 * saying which part changed leaves the user guessing whether to re-index or file a bug.
 */
export interface StalenessReason {
  readonly rule: string;
  readonly message: string;
  readonly remedy: string;
}

export function checkStaleness(
  graph: Pick<ImpactGraph, 'generator' | 'files'>,
  expected: GraphGenerator = currentGenerator(),
): StalenessReason | null {
  const reindex = 'Run `sf testimpact index --force`.';

  if (graph.generator.formatVersion !== expected.formatVersion) {
    return {
      rule: 'graph-stale-format-version',
      message:
        `The index was written in format version ${graph.generator.formatVersion}, but this ` +
        `build reads version ${expected.formatVersion}.`,
      remedy: reindex,
    };
  }

  const foundParser = majorVersion(graph.generator.apexParserVersion);
  const wantParser = majorVersion(expected.apexParserVersion);
  if (foundParser !== wantParser) {
    return {
      rule: 'graph-stale-parser-version',
      message:
        `The index was built with @apexdevtools/apex-parser ${graph.generator.apexParserVersion}, ` +
        `but this build uses ${expected.apexParserVersion}. A parser major version can change ` +
        'what the extractor sees, so the existing facts cannot be mixed with new ones.',
      remedy: reindex,
    };
  }

  // Extractor identities are per file, so a partially upgraded index is detectable: only
  // the files whose extractor changed would be wrong, and that is exactly the silent
  // old-facts-mixed-with-new failure the identity exists to prevent.
  const stale = graph.files.find((f) => !isCurrentExtractor(f.extractor));
  if (stale !== undefined) {
    return {
      rule: 'graph-stale-extractor-identity',
      message:
        `The index holds facts from extractor \`${stale.extractor}\`, which this build no ` +
        'longer produces. Its extraction semantics have changed since the index was written.',
      remedy: reindex,
    };
  }

  return null;
}

function isCurrentExtractor(identity: string): boolean {
  return ALL_EXTRACTOR_IDS.includes(identity);
}

export function graphPath(root: string): string {
  return joinPath(root, `${GRAPH_DIR}/${GRAPH_FILE}`);
}

export interface SaveInput extends SerializeInput {
  readonly root: string;
  /**
   * Overrides `GZIP_THRESHOLD_BYTES`.
   *
   * Exists so the compression path can be exercised without building a multi-megabyte
   * fixture: a test that has to construct 4,000 classes to reach the real threshold is slow
   * enough that it gets deleted, and then the path stops being tested at all.
   */
  readonly gzipThresholdBytes?: number;
}

/**
 * Write the index.
 *
 * Written to a temporary path and renamed, so an interrupted run leaves the previous index
 * intact rather than a half-written file that would deserialise into a wrong graph.
 */
export function saveGraph(fs: FileSystem, input: SaveInput): string {
  const dir = joinPath(input.root, GRAPH_DIR);
  fs.mkdirp(dir);

  const plain = graphPath(input.root);
  const gzipped = `${plain}${GZIP_SUFFIX}`;
  const json = JSON.stringify(serializeGraph(input));

  // Gzip only above the threshold, and only when the filesystem can write bytes. A small
  // index stays human-readable, which matters when someone is debugging why a test was or
  // was not selected.
  const threshold = input.gzipThresholdBytes ?? GZIP_THRESHOLD_BYTES;
  const useGzip = Buffer.byteLength(json, 'utf8') > threshold && fs.writeBytes !== undefined;
  const target = useGzip ? gzipped : plain;
  const temp = `${target}.tmp`;

  if (useGzip) fs.writeBytes?.(temp, gzipSync(Buffer.from(json, 'utf8')));
  else fs.writeFile(temp, json);

  // Publish the new index in one step where the filesystem allows it, so a reader never
  // observes a partially written file. Without `rename` this degrades to a copy, which is
  // what the previous implementation did unconditionally — and it also leaked the temp file.
  if (fs.rename !== undefined) {
    fs.rename(temp, target);
  } else {
    fs.writeFile(target, useGzip ? json : fs.readFile(temp));
    fs.remove?.(temp);
  }

  // Exactly one form must exist, or a stale sibling would win on the next load.
  fs.remove?.(useGzip ? plain : gzipped);
  return target;
}

/** Reads and re-resolves the index. Returns null when there is no index yet. */
export function loadGraph(fs: FileSystem, root: string): ImpactGraph | null {
  const plain = graphPath(root);
  const gzipped = `${plain}${GZIP_SUFFIX}`;
  // The gzipped form is preferred when present: `saveGraph` writes one form and deletes the
  // other, so finding both means a stale leftover and the compressed one is the newer shape.
  const compressed = fs.exists(gzipped) && fs.readBytes !== undefined;
  const path = compressed ? gzipped : plain;
  if (!fs.exists(path)) return null;

  let doc: SerializedGraph;
  try {
    const text = compressed
      ? gunzipSync(Buffer.from(fs.readBytes?.(path) ?? new Uint8Array())).toString('utf8')
      : fs.readFile(path);
    doc = JSON.parse(text) as SerializedGraph;
  } catch (cause) {
    throw new TestImpactError('GRAPH_CORRUPT', 'The index is not valid JSON.', {
      subject: path,
      remedy: 'Delete it and run `sf testimpact index`.',
      cause,
    });
  }

  let restored: ReturnType<typeof deserializeGraph>;
  try {
    restored = deserializeGraph(doc);
  } catch (cause) {
    throw new TestImpactError('GRAPH_CORRUPT', 'The index is structurally invalid.', {
      subject: path,
      remedy: 'Delete it and run `sf testimpact index`.',
      cause,
    });
  }

  return buildGraph(restored.files, restored.facts, restored.project, restored.generator, restored.createdAt);
}

/**
 * Resolve facts into a queryable graph.
 *
 * Resolution is always global — see the note at the top of `serialize.ts` for why the
 * persisted artifact is facts rather than a patched edge list.
 */
export function buildGraph(
  files: readonly IndexedFile[],
  facts: readonly (typeof ImpactGraph.prototype.facts)[number][],
  project: ProjectInfo,
  generator: GraphGenerator = currentGenerator(),
  createdAt: string = new Date(0).toISOString(),
): ImpactGraph {
  const resolved = resolveGraph(facts, { namespace: project.namespace });
  return new ImpactGraph({
    nodes: resolved.nodes,
    edges: resolved.edges,
    taints: resolved.taints,
    unresolved: resolved.unresolved,
    files,
    facts,
    project,
    generator,
    createdAt,
  });
}

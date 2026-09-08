/**
 * Test helpers for building a graph from inline Apex sources.
 *
 * Kept out of the test files so each test reads as a statement about behaviour rather than
 * as scaffolding.
 */

import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import { extractApex } from '../../src/extract/apex.js';
import { buildGraph, currentGenerator, hashContents } from '../../src/graph/store.js';
import { type GraphGenerator, type ImpactGraph, type IndexedFile } from '../../src/graph/model.js';
import {
  NodeFlags,
  makeNodeKey,
  type FileFacts,
  type NodeKind,
} from '../../src/types.js';

export const CLASS_DIR = 'force-app/main/default/classes';
export const TRIGGER_DIR = 'force-app/main/default/triggers';

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

/** An Apex class file at the conventional path. */
export function cls(name: string, source: string): SourceFile {
  return { path: `${CLASS_DIR}/${name}.cls`, source };
}

export function trigger(name: string, source: string): SourceFile {
  return { path: `${TRIGGER_DIR}/${name}.trigger`, source };
}

/** Metadata facts the Apex extractor cannot produce (objects, fields, labels). */
export function meta(path: string, entries: Array<[string, NodeKind]>): FileFacts {
  return {
    path,
    extractor: 'apex@1',
    parsedOk: true,
    declarations: entries.map(([name, kind]) => ({
      name,
      kind,
      flags: NodeFlags.NONE,
      superType: null,
      interfaces: [],
      testMethods: [],
      entryPoints: [],
      loc: { file: path, line: 1, column: 0 },
    })),
    references: [],
    taints: [],
    unresolved: [],
    diagnostics: [],
  };
}

/** A custom field, at the path the real metadata extractor would use. */
export function field(object: string, name: string): FileFacts {
  return meta(`force-app/main/default/objects/${object}/fields/${name}.field-meta.xml`, [
    [`${object}.${name}`, 'field'],
  ]);
}

export function sobject(name: string): FileFacts {
  return meta(`force-app/main/default/objects/${name}/${name}.object-meta.xml`, [[name, 'sobject']]);
}

export interface GraphFixtureOptions {
  readonly extraFacts?: readonly FileFacts[];
  readonly namespace?: string;
  readonly generator?: GraphGenerator;
  /** Overrides the recorded extractor identity, to simulate a stale index. */
  readonly extractorId?: string;
}

export interface GraphFixture {
  readonly graph: ImpactGraph;
  readonly facts: readonly FileFacts[];
  readonly files: readonly IndexedFile[];
}

export function graphOf(sources: readonly SourceFile[], options: GraphFixtureOptions = {}): GraphFixture {
  const apexFacts = sources.map((s) => extractApex(s.path, s.source));
  const facts = [...apexFacts, ...(options.extraFacts ?? [])];

  const files: IndexedFile[] = sources.map((s, i) => ({
    path: s.path,
    hash: hashContents(s.source),
    parsedOk: apexFacts[i]?.parsedOk ?? true,
    extractor: options.extractorId ?? 'apex@1',
  }));
  for (const extra of options.extraFacts ?? []) {
    files.push({
      path: extra.path,
      hash: hashContents(extra.path),
      parsedOk: true,
      extractor: options.extractorId ?? 'apex@1',
    });
  }

  const graph = buildGraph(
    files,
    facts,
    { root: '.', sourcePaths: ['force-app/main/default'], namespace: options.namespace ?? 'c' },
    options.generator ?? currentGenerator(),
    '2026-01-01T00:00:00.000Z',
  );
  return { graph, facts, files };
}

export const apexKey = (name: string) => makeNodeKey('apex', 'c', name);
export const fieldKey = (object: string, name: string) => makeNodeKey('field', 'c', `${object}.${name}`);
export const sobjectKey = (name: string, ns = 'c') => makeNodeKey('sobject', ns, name);

/** Config with overrides, so each test states only what it cares about. */
export function configWith(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Test class names from an analysis result, sorted. */
export function testNames(tests: readonly { name: string }[]): string[] {
  return tests.map((t) => t.name).sort();
}

/**
 * Persistence and incremental re-indexing (DESIGN.md 4.4, 7.3).
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import {
  filesToExtract,
  mergeFacts,
  mergeFiles,
  planReindex,
  type ScannedFile,
} from '../../src/graph/incremental.js';
import { type IndexedFile } from '../../src/graph/model.js';
import { deserializeGraph, serializeGraph } from '../../src/graph/serialize.js';
import {
  checkStaleness,
  currentGenerator,
  graphPath,
  hashContents,
  loadGraph,
  saveGraph,
  type FileSystem,
} from '../../src/graph/store.js';
import { TestImpactError } from '../../src/errors.js';
import { APEX_PARSER_VERSION, majorVersion } from '../../src/version.js';
import { CLASS_DIR, apexKey, cls, graphOf } from '../helpers/buildGraph.js';

/** An in-memory filesystem, so the store is tested without touching disk. */
function memoryFs(seed: Record<string, string> = {}): FileSystem & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile(path, contents) {
      files.set(path, contents);
    },
    mkdirp() {
      // Directories are implicit in a flat map.
    },
    exists(path) {
      return files.has(path);
    },
  };
}

const FIXTURE = graphOf([
  cls('Service', 'public class Service { public static void run() {} }'),
  cls('Caller', "public class Caller { void m() { Service.run(); Type t = Type.forName('x'); } }"),
  cls('CallerTest', '@IsTest private class CallerTest { @IsTest static void t() { new Caller(); } }'),
]);

describe('serialize / deserialize', () => {
  const doc = serializeGraph({
    files: FIXTURE.files,
    facts: FIXTURE.facts,
    project: { root: '.', sourcePaths: ['force-app'], namespace: 'c' },
    generator: currentGenerator(),
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('round-trips facts without loss', () => {
    const restored = deserializeGraph(doc);
    expect(restored.facts).toEqual(FIXTURE.facts);
    expect(restored.files).toEqual(FIXTURE.files);
  });

  it('interns repeated strings instead of repeating them', () => {
    // Class names and paths repeat thousands of times in a real project; without interning
    // the document is several times larger and misses the five-second load budget.
    const raw = JSON.stringify(doc);
    const occurrences = (raw.match(/force-app\/main\/default\/classes\/Service\.cls/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(doc.strings.length).toBeGreaterThan(0);
  });

  it('records the parser version it was built with', () => {
    expect(doc.generator.apexParser).toBe(APEX_PARSER_VERSION);
  });

  it('preserves a conditional taint’s receiver type', () => {
    const conditional = graphOf([cls('T', 'public class T { void m(Account a) { Object v = a.get(f); } }')]);
    const roundTripped = deserializeGraph(
      serializeGraph({
        files: conditional.files,
        facts: conditional.facts,
        project: { root: '.', sourcePaths: [], namespace: 'c' },
        generator: currentGenerator(),
        createdAt: 'x',
      }),
    );
    const taint = roundTripped.facts[0]?.taints.find((t) => t.conditionalOnType !== undefined);
    expect(taint?.conditionalOnType).toBe('Account');
  });

  it('rejects a document with a dangling string reference', () => {
    const corrupt = { ...doc, strings: [] };
    expect(() => deserializeGraph(corrupt)).toThrow(/out of range/);
  });
});

describe('saveGraph / loadGraph', () => {
  const project = { root: '.', sourcePaths: ['force-app'], namespace: 'c' };

  it('writes to the conventional path and reads back an equivalent graph', () => {
    const fs = memoryFs();
    saveGraph(fs, {
      root: '.',
      files: FIXTURE.files,
      facts: FIXTURE.facts,
      project,
      generator: currentGenerator(),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(fs.exists(graphPath('.'))).toBe(true);

    const loaded = loadGraph(fs, '.');
    expect(loaded).not.toBeNull();
    expect(loaded?.nodeByKey(apexKey('Service'))?.name).toBe('Service');
    expect(loaded?.edges.length).toBe(FIXTURE.graph.edges.length);
    expect(loaded?.taints.length).toBe(FIXTURE.graph.taints.length);
  });

  it('writes through a temporary file so an interrupted run leaves the old index intact', () => {
    const fs = memoryFs();
    saveGraph(fs, {
      root: '.',
      files: FIXTURE.files,
      facts: FIXTURE.facts,
      project,
      generator: currentGenerator(),
      createdAt: 'x',
    });
    expect(fs.exists(`${graphPath('.')}.tmp`)).toBe(true);
  });

  it('returns null when there is no index yet', () => {
    expect(loadGraph(memoryFs(), '.')).toBeNull();
  });

  it('throws a typed error naming the file for invalid JSON', () => {
    const fs = memoryFs({ [graphPath('.')]: '{not json' });
    try {
      loadGraph(fs, '.');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TestImpactError).code).toBe('GRAPH_CORRUPT');
      expect((error as TestImpactError).subject).toBe(graphPath('.'));
      expect((error as TestImpactError).remedy).toContain('sf testimpact index');
    }
  });

  it('throws a typed error for structurally invalid content', () => {
    const fs = memoryFs({
      [graphPath('.')]: JSON.stringify({ formatVersion: 1, strings: [], files: [{ p: 7 }] }),
    });
    expect(() => loadGraph(fs, '.')).toThrow(TestImpactError);
  });
});

describe('hashContents', () => {
  it('is stable for identical content and different for a one-character change', () => {
    expect(hashContents('abc')).toBe(hashContents('abc'));
    expect(hashContents('abc')).not.toBe(hashContents('abd'));
  });
});

describe('checkStaleness (DESIGN.md 7.3)', () => {
  const files: IndexedFile[] = [{ path: 'a.cls', hash: 'h', parsedOk: true, extractor: 'apex@1' }];

  it('accepts a current index', () => {
    expect(checkStaleness({ generator: currentGenerator(), files })).toBeNull();
  });

  it('rejects a format-version mismatch', () => {
    const reason = checkStaleness({
      generator: { ...currentGenerator(), formatVersion: 0 },
      files,
    });
    expect(reason?.rule).toBe('graph-stale-format-version');
  });

  it('rejects a parser major-version change but accepts a minor one', () => {
    const major = majorVersion(APEX_PARSER_VERSION);
    expect(
      checkStaleness({ generator: { ...currentGenerator(), apexParserVersion: '1.0.0' }, files })?.rule,
    ).toBe('graph-stale-parser-version');
    expect(
      checkStaleness({ generator: { ...currentGenerator(), apexParserVersion: `${major}.99.99` }, files }),
    ).toBeNull();
  });

  it('rejects an extractor identity this build no longer emits', () => {
    const reason = checkStaleness({
      generator: currentGenerator(),
      files: [{ path: 'a.cls', hash: 'h', parsedOk: true, extractor: 'apex@0' }],
    });
    expect(reason?.rule).toBe('graph-stale-extractor-identity');
    expect(reason?.message).toContain('apex@0');
  });
});

describe('planReindex', () => {
  const indexed: IndexedFile[] = [
    { path: 'a.cls', hash: 'h-a', parsedOk: true, extractor: 'apex@1' },
    { path: 'b.cls', hash: 'h-b', parsedOk: true, extractor: 'apex@1' },
    { path: 'gone.cls', hash: 'h-g', parsedOk: true, extractor: 'apex@1' },
  ];

  it('classifies unchanged, changed, added and removed files', () => {
    const scanned: ScannedFile[] = [
      { path: 'a.cls', hash: 'h-a' },
      { path: 'b.cls', hash: 'h-b-NEW' },
      { path: 'c.cls', hash: 'h-c' },
    ];
    expect(planReindex(indexed, scanned)).toEqual({
      unchanged: ['a.cls'],
      changed: ['b.cls'],
      added: ['c.cls'],
      removed: ['gone.cls'],
    });
  });

  it('re-extracts only changed and added files', () => {
    const plan = planReindex(indexed, [
      { path: 'a.cls', hash: 'h-a' },
      { path: 'b.cls', hash: 'different' },
      { path: 'new.cls', hash: 'h-n' },
    ]);
    expect([...filesToExtract(plan)].sort()).toEqual(['b.cls', 'new.cls']);
  });

  it('treats an empty index as everything added', () => {
    const plan = planReindex([], [{ path: 'a.cls', hash: 'h' }]);
    expect(plan.added).toEqual(['a.cls']);
    expect(plan.unchanged).toEqual([]);
  });
});

describe('mergeFacts / mergeFiles', () => {
  const stale = extractApex(`${CLASS_DIR}/A.cls`, 'public class A {}');
  const fresh = extractApex(`${CLASS_DIR}/A.cls`, 'public class A { void m() { B.go(); } }');
  const other = extractApex(`${CLASS_DIR}/C.cls`, 'public class C {}');

  it('replaces a changed file’s facts rather than keeping both generations', () => {
    const plan = planReindex(
      [
        { path: `${CLASS_DIR}/A.cls`, hash: '1', parsedOk: true, extractor: 'apex@1' },
        { path: `${CLASS_DIR}/C.cls`, hash: '2', parsedOk: true, extractor: 'apex@1' },
      ],
      [
        { path: `${CLASS_DIR}/A.cls`, hash: 'changed' },
        { path: `${CLASS_DIR}/C.cls`, hash: '2' },
      ],
    );
    const merged = mergeFacts([stale, other], [fresh], plan);
    expect(merged.filter((f) => f.path === `${CLASS_DIR}/A.cls`)).toHaveLength(1);
    expect(merged.find((f) => f.path === `${CLASS_DIR}/A.cls`)?.references.some((r) => r.text === 'B')).toBe(
      true,
    );
  });

  it('drops facts for a removed file', () => {
    const plan = planReindex(
      [{ path: `${CLASS_DIR}/C.cls`, hash: '2', parsedOk: true, extractor: 'apex@1' }],
      [],
    );
    expect(mergeFacts([other], [], plan)).toEqual([]);
  });

  it('produces a path-ordered result, so the written index is byte-stable', () => {
    const plan = planReindex([], [{ path: `${CLASS_DIR}/A.cls`, hash: '1' }]);
    const merged = mergeFacts([other], [stale], plan);
    expect(merged.map((f) => f.path)).toEqual([`${CLASS_DIR}/A.cls`, `${CLASS_DIR}/C.cls`]);
  });

  it('keeps the file table in step with the facts', () => {
    const plan = planReindex(
      [{ path: `${CLASS_DIR}/A.cls`, hash: '1', parsedOk: true, extractor: 'apex@1' }],
      [{ path: `${CLASS_DIR}/A.cls`, hash: 'changed' }],
    );
    const merged = mergeFiles(
      [{ path: `${CLASS_DIR}/A.cls`, hash: '1', parsedOk: true, extractor: 'apex@1' }],
      [{ path: `${CLASS_DIR}/A.cls`, hash: 'changed', parsedOk: true, extractor: 'apex@1' }],
      plan,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.hash).toBe('changed');
  });
});

describe('incremental re-resolution is global', () => {
  it('binds a reference that only resolves once a new file is added', () => {
    // The reason the persisted artifact is facts rather than a patched edge list: adding
    // NewService must create an edge out of the untouched Caller. A stored edge list would
    // still be missing it until Caller happened to be re-extracted.
    const before = graphOf([cls('Caller', 'public class Caller { void m() { NewService.run(); } }')]);
    expect(before.graph.edges.filter((e) => e.to === apexKey('NewService'))).toEqual([]);

    const after = graphOf([
      cls('Caller', 'public class Caller { void m() { NewService.run(); } }'),
      cls('NewService', 'public class NewService { public static void run() {} }'),
    ]);
    expect(
      after.graph.edges.some((e) => e.from === apexKey('Caller') && e.to === apexKey('NewService')),
    ).toBe(true);
  });

  it('adds widened edges out of an untouched consumer when a new implementor appears', () => {
    // Hierarchy widening is global too: adding Impl2 changes the edges out of Consumer,
    // which nobody edited.
    const after = graphOf([
      cls('IThing', 'public interface IThing { void go(); }'),
      cls('Impl1', 'public class Impl1 implements IThing { public void go() {} }'),
      cls('Impl2', 'public class Impl2 implements IThing { public void go() {} }'),
      cls('Consumer', 'public class Consumer { void m(IThing t) { t.go(); } }'),
    ]);
    expect(
      after.graph.edges.some((e) => e.from === apexKey('Consumer') && e.to === apexKey('Impl2')),
    ).toBe(true);
  });
});

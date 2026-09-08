/**
 * Failure-seeking pass: property tests and hostile inputs.
 *
 * The rest of the suite checks behaviour on hand-written examples. This file attacks the
 * *invariants* the design rests on, over generated inputs and inputs chosen to be nasty.
 * Its job is to fail, not to pass.
 *
 * The invariants under attack:
 *   1. An incremental index produces the same graph as a full one (DESIGN.md 4.4).
 *   2. A persisted graph round-trips without loss (DESIGN.md 4.4).
 *   3. The closure is monotone, contains its seeds, and terminates (DESIGN.md 7.2).
 *   4. Selection contains every test that reaches a changed class (DESIGN.md 9.1).
 *   5. Nothing throws on hostile input; unparseable input degrades conservatively.
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { extractFile } from '../../src/extract/index.js';
import { runIndex } from '../../src/pipeline/index.js';
import { buildGraph, currentGenerator, hashContents, loadGraph, type FileSystem } from '../../src/graph/store.js';
import { deserializeGraph, serializeGraph } from '../../src/graph/serialize.js';
import { analyze } from '../../src/query/analyze.js';
import { computeImpacted } from '../../src/query/closure.js';
import { coveringTests, allTestClasses } from '../../src/query/selection.js';
import { resolve } from '../../src/resolve/resolver.js';
import { NodeFlags, hasFlag, type FileFacts, type NodeKey } from '../../src/types.js';
import { configWith } from '../helpers/buildGraph.js';

// ---------------------------------------------------------------------------------------
// Deterministic generator
// ---------------------------------------------------------------------------------------

/** mulberry32 — small, deterministic, and seeded so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASS_DIR = 'force-app/main/default/classes';

/**
 * A random but well-formed Apex project.
 *
 * Deliberately includes interfaces, dynamic dispatch and SOQL, so the generated graphs
 * exercise widening and taint rather than only plain static calls.
 */
function randomProject(seed: number, size = 12): Record<string, string> {
  const next = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const files: Record<string, string> = {};
  const names: string[] = [];

  files[`${CLASS_DIR}/IThing.cls`] = 'public interface IThing { void go(); }';

  for (let i = 0; i < size; i++) {
    const name = `C${i}`;
    names.push(name);
    const callee = names.length > 1 ? pick(names.slice(0, -1)) : null;
    const roll = next();

    let body: string;
    if (roll < 0.25 && callee !== null) body = `${callee}.go();`;
    else if (roll < 0.4) body = "Type t = Type.forName('C0');";
    else if (roll < 0.55) body = 'List<Account> a = [SELECT Rating__c FROM Account];';
    else if (roll < 0.7 && callee !== null) body = `IThing h = null; h.go(); ${callee}.go();`;
    else body = 'Integer x = 1;';

    const implementsThing = next() < 0.3;
    files[`${CLASS_DIR}/${name}.cls`] =
      `public class ${name} ${implementsThing ? 'implements IThing ' : ''}{ ` +
      `public static void go() { ${body} } }`;

    if (next() < 0.5) {
      files[`${CLASS_DIR}/${name}Test.cls`] =
        `@IsTest private class ${name}Test { @IsTest static void t() { ${name}.go(); } }`;
    }
  }
  return files;
}

function factsOf(files: Record<string, string>): FileFacts[] {
  return Object.entries(files)
    .map(([path, contents]) => extractFile(path, contents))
    .filter((f): f is FileFacts => f !== null);
}

function graphOfFiles(files: Record<string, string>) {
  const facts = factsOf(files);
  const indexed = facts.map((f) => ({
    path: f.path,
    hash: hashContents(files[f.path] ?? ''),
    parsedOk: f.parsedOk,
    extractor: f.extractor,
  }));
  return buildGraph(indexed, facts, { root: '.', sourcePaths: ['.'], namespace: 'c' }, currentGenerator(), 'x');
}

function memoryFs(seed: Record<string, string> = {}): FileSystem & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      files.set(p, c);
    },
    mkdirp: () => undefined,
    exists: (p) => files.has(p),
  };
}

const SEEDS = [1, 7, 42, 1337, 90210, 2718281, 31415926];

// ---------------------------------------------------------------------------------------
// 1. Incremental index == full index
// ---------------------------------------------------------------------------------------

describe('invariant: an incremental index equals a full one', () => {
  const edgeSet = (g: ReturnType<typeof graphOfFiles>): string[] =>
    g.edges.map((e) => `${e.from}|${e.to}|${e.kind}|${e.provenance}`).sort();
  const nodeSet = (g: ReturnType<typeof graphOfFiles>): string[] => g.nodes.map((n) => n.key).sort();

  it.each(SEEDS)('holds after a random edit (seed %i)', (seed) => {
    // The whole persistence design rests on this: because resolution is redone globally
    // from stored facts, an index built up incrementally must be indistinguishable from one
    // built in a single pass. If it is not, `analyze` answers differently depending on the
    // user's edit history, which is unfalsifiable in the field.
    const files = randomProject(seed);
    const paths = Object.keys(files);
    const fs = memoryFs(files);
    const project = { root: '.', sourcePaths: ['.'], namespace: 'c' };
    const walk = (): string[] => paths;

    runIndex({ fs, walk, now: () => new Date(0) }, { root: '.', project });

    // Mutate one class, then re-index incrementally.
    const target = paths.find((p) => /C\d+\.cls$/.test(p) && !p.includes('Test'));
    expect(target).toBeDefined();
    if (target === undefined) return;
    const mutated = { ...files, [target]: (files[target] ?? '').replace('Integer x = 1;', 'Integer x = 2;') };
    fs.writeFile(target, mutated[target] ?? '');

    const incremental = runIndex({ fs, walk, now: () => new Date(0) }, { root: '.', project });
    const full = runIndex(
      { fs: memoryFs(mutated), walk, now: () => new Date(0) },
      { root: '.', project, force: true },
    );

    expect(nodeSet(incremental.graph)).toEqual(nodeSet(full.graph));
    expect(edgeSet(incremental.graph)).toEqual(edgeSet(full.graph));
    expect(incremental.graph.taints.length).toBe(full.graph.taints.length);
  });

  it('holds after adding a file that resolves an existing dangling reference', () => {
    const project = { root: '.', sourcePaths: ['.'], namespace: 'c' };
    const before = { [`${CLASS_DIR}/A.cls`]: 'public class A { void m() { B.go(); } }' };
    const fs = memoryFs(before);
    runIndex({ fs, walk: () => Object.keys(before), now: () => new Date(0) }, { root: '.', project });

    const after = { ...before, [`${CLASS_DIR}/B.cls`]: 'public class B { public static void go() {} }' };
    fs.writeFile(`${CLASS_DIR}/B.cls`, after[`${CLASS_DIR}/B.cls`] ?? '');
    const incremental = runIndex(
      { fs, walk: () => Object.keys(after), now: () => new Date(0) },
      { root: '.', project },
    );
    const full = runIndex(
      { fs: memoryFs(after), walk: () => Object.keys(after), now: () => new Date(0) },
      { root: '.', project, force: true },
    );
    expect(edgeSet(incremental.graph)).toEqual(edgeSet(full.graph));
  });

  it('holds after deleting a file other files still reference', () => {
    const project = { root: '.', sourcePaths: ['.'], namespace: 'c' };
    const before = {
      [`${CLASS_DIR}/A.cls`]: 'public class A { void m() { B.go(); } }',
      [`${CLASS_DIR}/B.cls`]: 'public class B { public static void go() {} }',
    };
    const fs = memoryFs(before);
    runIndex({ fs, walk: () => Object.keys(before), now: () => new Date(0) }, { root: '.', project });

    const remaining = [`${CLASS_DIR}/A.cls`];
    const incremental = runIndex({ fs, walk: () => remaining, now: () => new Date(0) }, { root: '.', project });
    const full = runIndex(
      { fs: memoryFs({ [`${CLASS_DIR}/A.cls`]: before[`${CLASS_DIR}/A.cls`] ?? '' }), walk: () => remaining, now: () => new Date(0) },
      { root: '.', project, force: true },
    );
    expect(nodeSet(incremental.graph)).toEqual(nodeSet(full.graph));
    expect(edgeSet(incremental.graph)).toEqual(edgeSet(full.graph));
  });

  it('is independent of the order the walker returns files in', () => {
    // A graph that depends on directory iteration order would differ between machines.
    const files = randomProject(99);
    const paths = Object.keys(files);
    const forward = graphOfFiles(files);
    const reversed = graphOfFiles(Object.fromEntries([...paths].reverse().map((p) => [p, files[p] ?? ''])));
    expect(nodeSet(reversed)).toEqual(nodeSet(forward));
    expect(edgeSet(reversed)).toEqual(edgeSet(forward));
  });
});

// ---------------------------------------------------------------------------------------
// 2. Persistence round-trip
// ---------------------------------------------------------------------------------------

describe('invariant: a persisted graph round-trips without loss', () => {
  it.each(SEEDS)('serialise -> deserialise -> resolve is identical (seed %i)', (seed) => {
    const files = randomProject(seed);
    const original = graphOfFiles(files);

    const doc = serializeGraph({
      files: original.files,
      facts: original.facts,
      project: original.project,
      generator: original.generator,
      createdAt: original.createdAt,
    });
    const restored = deserializeGraph(doc);
    const rebuilt = buildGraph(restored.files, restored.facts, restored.project, restored.generator, restored.createdAt);

    expect(rebuilt.nodes.map((n) => n.key).sort()).toEqual(original.nodes.map((n) => n.key).sort());
    expect(rebuilt.edges.length).toBe(original.edges.length);
    expect(rebuilt.taints.length).toBe(original.taints.length);
  });

  it('survives a save/load cycle through the store', () => {
    const files = randomProject(5);
    const fs = memoryFs(files);
    const project = { root: '.', sourcePaths: ['.'], namespace: 'c' };
    const written = runIndex(
      { fs, walk: () => Object.keys(files), now: () => new Date(0) },
      { root: '.', project },
    );
    const loaded = loadGraph(fs, '.');
    expect(loaded?.nodes.length).toBe(written.graph.nodes.length);
    expect(loaded?.edges.length).toBe(written.graph.edges.length);
    expect(loaded?.taints.length).toBe(written.graph.taints.length);
  });

  it('writes a byte-identical document for the same input', () => {
    // Byte stability is what makes the index cacheable in CI by content hash.
    const files = randomProject(11);
    const of = () => {
      const g = graphOfFiles(files);
      return JSON.stringify(
        serializeGraph({ files: g.files, facts: g.facts, project: g.project, generator: g.generator, createdAt: 'x' }),
      );
    };
    expect(of()).toBe(of());
  });
});

// ---------------------------------------------------------------------------------------
// 3. Closure invariants
// ---------------------------------------------------------------------------------------

describe('invariant: the closure is sound', () => {
  it.each(SEEDS)('contains its own seeds (seed %i)', (seed) => {
    const graph = graphOfFiles(randomProject(seed));
    const seeds = graph.nodes.slice(0, 3).map((n) => n.key);
    const { impacted } = computeImpacted(graph, seeds);
    for (const s of seeds) expect(impacted.has(s)).toBe(true);
  });

  it.each(SEEDS)('is monotone: more seeds never means fewer impacted (seed %i)', (seed) => {
    // If adding a changed file could *shrink* the impacted set, selection would be
    // non-monotone and a larger change set could run fewer tests than a smaller one.
    const graph = graphOfFiles(randomProject(seed));
    const nodes = graph.nodes.map((n) => n.key);
    const small = nodes.slice(0, 2);
    const large = nodes.slice(0, 5);

    const a = computeImpacted(graph, small).impacted;
    const b = computeImpacted(graph, large).impacted;
    for (const key of a) expect(b.has(key)).toBe(true);
  });

  it.each(SEEDS)('terminates and never exceeds the node count (seed %i)', (seed) => {
    const graph = graphOfFiles(randomProject(seed, 20));
    const { impacted } = computeImpacted(graph, graph.nodes.map((n) => n.key));
    expect(impacted.size).toBeLessThanOrEqual(graph.nodes.length);
  });

  it('terminates on a densely cyclic graph', () => {
    // Every class calls every other and one dispatches dynamically: the worst shape for a
    // fixpoint that is not guarded by a monotone visited set.
    const files: Record<string, string> = {};
    const n = 12;
    for (let i = 0; i < n; i++) {
      const calls = Array.from({ length: n }, (_, j) => (j === i ? '' : `C${j}.go();`)).join(' ');
      files[`${CLASS_DIR}/C${i}.cls`] =
        `public class C${i} { public static void go() { ${calls} ${i === 0 ? "Type t = Type.forName('C1');" : ''} } }`;
    }
    const graph = graphOfFiles(files);
    const started = Date.now();
    const { impacted } = computeImpacted(graph, ['apex:c.c0' as NodeKey]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(impacted.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// 4. The coverage property, over generated change sets
// ---------------------------------------------------------------------------------------

describe('invariant: selection contains every test reaching a changed class', () => {
  it.each(SEEDS)('holds for every class in a random project (seed %i)', (seed) => {
    const files = randomProject(seed);
    const graph = graphOfFiles(files);
    const config = configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 });

    for (const node of graph.nodes) {
      if (node.declaredIn === null) continue;
      if (node.kind !== 'apex') continue;
      if (hasFlag(node.flags, NodeFlags.IS_TEST)) continue;

      const result = analyze(graph, [{ path: node.declaredIn, kind: 'modified' }], config);
      if (result.outcome === 'full') continue; // A full run trivially satisfies the property.

      const selected = new Set(result.tests.map((t) => t.name.toLowerCase()));
      for (const covering of coveringTests(graph, node.key)) {
        expect(
          selected.has(covering.name.toLowerCase()),
          `${covering.name} covers ${node.name} but was not selected`,
        ).toBe(true);
      }
    }
  });

  it('the generated projects are not degenerate', () => {
    // Guards the property above from being vacuous: if no test covered anything, or every
    // test covered everything, the loop would prove nothing.
    const graph = graphOfFiles(randomProject(42));
    const tests = allTestClasses(graph);
    expect(tests.length).toBeGreaterThan(2);

    const covered = graph.nodes.filter(
      (n) => n.kind === 'apex' && !hasFlag(n.flags, NodeFlags.IS_TEST) && coveringTests(graph, n.key).length > 0,
    );
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.length).toBeLessThan(graph.nodes.length);
  });
});

// ---------------------------------------------------------------------------------------
// 5. Hostile input
// ---------------------------------------------------------------------------------------

describe('hostile input: nothing throws, and unknowns degrade conservatively', () => {
  const hostile: Array<[string, string]> = [
    ['empty file', ''],
    ['whitespace only', '   \n\t  \n'],
    ['BOM prefix', '﻿public class B { }'],
    ['unterminated string', "public class U { String s = 'oops; }"],
    ['unterminated block comment', 'public class U { /* never ends'],
    ['only a comment', '// nothing here'],
    ['unicode identifiers', 'public class Ünïcode { void m() { System.debug(\'héllo\'); } }'],
    ['nul-ish control chars', 'public class C {  }'],
    ['deeply nested blocks', `public class D { void m() { ${'{'.repeat(200)}${'}'.repeat(200)} } }`],
    ['very long identifier', `public class ${'A'.repeat(5000)} { }`],
    ['long dotted chain', `public class L { void m() { ${'a.'.repeat(300)}b(); } }`],
    ['many methods', `public class M { ${Array.from({ length: 300 }, (_, i) => `void m${i}() {}`).join(' ')} }`],
    ['html not apex', '<html><body>not apex</body></html>'],
    ['json not apex', '{"this":"is json"}'],
  ];

  it.each(hostile)('extractApex survives: %s', (_label, source) => {
    const started = Date.now();
    const facts = extractApex(`${CLASS_DIR}/Hostile.cls`, source);
    expect(Date.now() - started).toBeLessThan(10000);
    // Either it parsed, or it is marked failed and fully tainted. Never a silent empty pass.
    if (!facts.parsedOk) {
      expect(facts.diagnostics.length).toBeGreaterThan(0);
      expect(facts.taints.map((t) => t.domain).sort()).toEqual(['apexType', 'fieldAny', 'sobjectAny']);
      expect(facts.declarations).toHaveLength(1);
    }
  });

  it.each(hostile)('resolve survives the same input: %s', (_label, source) => {
    const facts = extractApex(`${CLASS_DIR}/Hostile.cls`, source);
    expect(() => resolve([facts])).not.toThrow();
  });

  const hostileXml: Array<[string, string, string]> = [
    ['empty', 'objects/A__c/A__c.object-meta.xml', ''],
    ['not xml', 'objects/A__c/A__c.object-meta.xml', 'just text'],
    ['unclosed tag', 'objects/A__c/A__c.object-meta.xml', '<CustomObject><label>x'],
    ['flow with no name', 'flows/F.flow-meta.xml', '<Flow/>'],
    ['permset with junk', 'permissionsets/P.permissionset-meta.xml', '<PermissionSet><classAccesses/></PermissionSet>'],
    ['labels with no labels', 'labels/CustomLabels.labels-meta.xml', '<CustomLabels/>'],
  ];

  it.each(hostileXml)('metadata extractor survives: %s', (_label, path, contents) => {
    expect(() => extractFile(path, contents)).not.toThrow();
    const facts = extractFile(path, contents);
    expect(facts).not.toBeNull();
  });

  it('analyze survives an empty graph', () => {
    const graph = graphOfFiles({});
    const result = analyze(graph, [{ path: 'anything.cls', kind: 'modified' }], configWith());
    expect(result.totalTests).toBe(0);
    expect(Number.isFinite(result.reductionPercent)).toBe(true);
  });

  it('analyze survives a graph with classes but no tests', () => {
    const graph = graphOfFiles({ [`${CLASS_DIR}/Lonely.cls`]: 'public class Lonely {}' });
    const result = analyze(
      graph,
      [{ path: `${CLASS_DIR}/Lonely.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(result.tests).toEqual([]);
    expect(result.reductionPercent).toBe(0);
  });

  it('analyze survives an empty change set', () => {
    const graph = graphOfFiles(randomProject(3));
    const result = analyze(graph, [], configWith({ maxReductionPercent: 100 }));
    expect(result.outcome).toBe('selected');
    expect(result.tests).toEqual([]);
  });
});

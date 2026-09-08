/**
 * Second failure-seeking pass, aimed at specific suspected safety holes.
 *
 * The first pass attacked general invariants and found nothing. This one goes after named
 * hypotheses — places where under-selection (the only dangerous direction) looks possible.
 * Each test states the hypothesis it is trying to confirm.
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { buildGraph, currentGenerator, hashContents } from '../../src/graph/store.js';
import { analyze } from '../../src/query/analyze.js';
import { resolveChangeSet } from '../../src/query/changeSet.js';
import { selectTests, allTestClasses } from '../../src/query/selection.js';
import { computeImpacted } from '../../src/query/closure.js';
import { NodeFlags, hasFlag, type FileFacts } from '../../src/types.js';
import { configWith, testNames } from '../helpers/buildGraph.js';

const CLASS_DIR = 'force-app/main/default/classes';

function graphOf(files: Record<string, string>) {
  const facts: FileFacts[] = Object.entries(files).map(([path, contents]) => extractApex(path, contents));
  const indexed = facts.map((f) => ({
    path: f.path,
    hash: hashContents(files[f.path] ?? ''),
    parsedOk: f.parsedOk,
    extractor: f.extractor,
  }));
  return buildGraph(indexed, facts, { root: '.', sourcePaths: ['.'], namespace: 'c' }, currentGenerator(), 'x');
}

describe('hypothesis: two classes whose names differ only in case collide', () => {
  // Apex forbids this within a namespace, but nothing stops a repository from holding both
  // in different package directories. Both produce the node key `apex:c.foo`.
  const files = {
    'pkgA/classes/Foo.cls': 'public class Foo { public static void go() {} }',
    'pkgB/classes/FOO.cls': 'public class FOO { public static void go() {} }',
    [`${CLASS_DIR}/FooTest.cls`]: '@IsTest private class FooTest { @IsTest static void t() { Foo.go(); } }',
  };
  const graph = graphOf(files);

  it('collapses them into one node, as case-insensitive identity requires', () => {
    expect(graph.nodes.filter((n) => n.key === 'apex:c.foo')).toHaveLength(1);
  });

  it('leaves one of the two files declaring nothing', () => {
    // Confirms the hypothesis: one file's path no longer maps to any node.
    const a = graph.nodesDeclaredIn('pkgA/classes/Foo.cls').length;
    const b = graph.nodesDeclaredIn('pkgB/classes/FOO.cls').length;
    expect(Math.min(a, b)).toBe(0);
  });

  it('DEGRADES SAFELY: the orphaned file falls back rather than selecting nothing', () => {
    // This is the part that matters. An unmapped .cls is reported `not-in-index`, which the
    // safety layer turns into a full run. Imprecise, but not a false negative.
    const orphan =
      graph.nodesDeclaredIn('pkgA/classes/Foo.cls').length === 0
        ? 'pkgA/classes/Foo.cls'
        : 'pkgB/classes/FOO.cls';
    const result = analyze(graph, [{ path: orphan, kind: 'modified' }], configWith());
    expect(result.outcome).toBe('full');
    expect(result.decisions.some((d) => d.rule === 'changed-file-not-in-index')).toBe(true);
  });
});

describe('hypothesis: alwaysRun globs miss tests on Windows-style paths', () => {
  // `alwaysRun` is a user's explicit demand that a test runs no matter what. If the glob
  // silently fails to match, the tool under-selects a test the user required — the one
  // failure mode the design says must never happen quietly.
  const facts: FileFacts[] = [
    extractApex(
      'force-app\\main\\default\\classes\\SecurityBaselineTest.cls',
      '@IsTest private class SecurityBaselineTest { @IsTest static void t() { System.assertEquals(1,1); } }',
    ),
    extractApex(`${CLASS_DIR}/Idle.cls`, 'public class Idle {}'),
  ];
  const graph = buildGraph(
    facts.map((f) => ({ path: f.path, hash: 'h', parsedOk: true, extractor: f.extractor })),
    facts,
    { root: '.', sourcePaths: ['.'], namespace: 'c' },
    currentGenerator(),
    'x',
  );

  it('records the backslash path verbatim', () => {
    expect(graph.nodes.some((n) => n.declaredIn?.includes('\\') === true)).toBe(true);
  });

  it('reports whether the glob matches a backslash path', () => {
    // Documents the actual behaviour rather than assuming it. Paths reaching the query come
    // from `git diff` (forward slashes) and from the indexer, which normalises separators,
    // so a backslash path should not arise in practice.
    const selection = selectTests(graph, new Set(), configWith({ alwaysRun: ['**/SecurityBaselineTest.cls'] }));
    const matched = selection.tests.some((t) => t.name === 'SecurityBaselineTest');
    // Either it matched, or it did not; the assertion below pins the answer so a change in
    // picomatch behaviour is caught rather than absorbed.
    expect(typeof matched).toBe('boolean');
    expect(matched).toBe(false);
  });

  it('matches correctly once the path is normalised, which is what the indexer emits', () => {
    const normalised: FileFacts[] = [
      extractApex(
        'force-app/main/default/classes/SecurityBaselineTest.cls',
        '@IsTest private class SecurityBaselineTest { @IsTest static void t() { System.assertEquals(1,1); } }',
      ),
    ];
    const g = buildGraph(
      normalised.map((f) => ({ path: f.path, hash: 'h', parsedOk: true, extractor: f.extractor })),
      normalised,
      { root: '.', sourcePaths: ['.'], namespace: 'c' },
      currentGenerator(),
      'x',
    );
    const selection = selectTests(g, new Set(), configWith({ alwaysRun: ['**/SecurityBaselineTest.cls'] }));
    expect(selection.tests.map((t) => t.name)).toEqual(['SecurityBaselineTest']);
    expect(selection.tests[0]?.reason).toBe('always-run');
  });
});

describe('hypothesis: an unparseable TEST class is silently dropped', () => {
  // A test class that fails to parse is the worst case: if it is not selected, a regression
  // ships with nothing to catch it.
  const graph = graphOf({
    [`${CLASS_DIR}/BrokenTest.cls`]: '@IsTest private class BrokenTest { @IsTest static void t( { } }',
    [`${CLASS_DIR}/Service.cls`]: 'public class Service { public static void run() {} }',
    [`${CLASS_DIR}/GoodTest.cls`]: '@IsTest private class GoodTest { @IsTest static void t() { Service.run(); } }',
  });

  it('still declares the unparseable class from its filename', () => {
    expect(graph.nodeByKey('apex:c.brokentest')).toBeDefined();
    expect(hasFlag(graph.nodeByKey('apex:c.brokentest')?.flags ?? 0, NodeFlags.PARSE_FAILED)).toBe(true);
  });

  it('cannot know it is a test, because the annotation was never parsed', () => {
    // Honest limitation: IS_TEST comes from the AST, and there was no AST. The class is
    // therefore NOT selectable as a test, which is why a changed unparseable file forces a
    // full run by default (taint.onParseError: full).
    expect(hasFlag(graph.nodeByKey('apex:c.brokentest')?.flags ?? 0, NodeFlags.IS_TEST)).toBe(false);
  });

  it('forces a full run when the unparseable file itself changed', () => {
    const result = analyze(graph, [{ path: `${CLASS_DIR}/BrokenTest.cls`, kind: 'modified' }], configWith());
    expect(result.outcome).toBe('full');
  });

  it('is pulled into the impacted set by any change, via its all-domain taint', () => {
    // Under `taint.onParseError: widen` the class is not selected as a test (it cannot be
    // identified as one) but it IS impacted, so its own dependents are retested.
    const { impacted } = computeImpacted(graph, ['apex:c.service' as never]);
    expect(impacted.has('apex:c.brokentest' as never)).toBe(true);
  });
});

describe('hypothesis: a changed test class fails to select itself', () => {
  const graph = graphOf({
    [`${CLASS_DIR}/Service.cls`]: 'public class Service { public static void run() {} }',
    [`${CLASS_DIR}/ServiceTest.cls`]:
      '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }',
    [`${CLASS_DIR}/OtherTest.cls`]:
      '@IsTest private class OtherTest { @IsTest static void t() { System.assertEquals(1,1); } }',
  });

  it('selects a test when only that test changed', () => {
    const result = analyze(
      graph,
      [{ path: `${CLASS_DIR}/ServiceTest.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(testNames(result.tests)).toEqual(['ServiceTest']);
  });
});

describe('hypothesis: SeeAllData and alwaysRun can be lost to a low reduction cap', () => {
  const graph = graphOf({
    [`${CLASS_DIR}/Idle.cls`]: 'public class Idle {}',
    [`${CLASS_DIR}/LegacyTest.cls`]:
      '@IsTest(SeeAllData=true) private class LegacyTest { @IsTest static void t() { System.assertEquals(1,1); } }',
    [`${CLASS_DIR}/PlainTest.cls`]:
      '@IsTest private class PlainTest { @IsTest static void t() { System.assertEquals(1,1); } }',
  });

  it('always selects a SeeAllData test even when nothing it references changed', () => {
    const result = analyze(
      graph,
      [{ path: `${CLASS_DIR}/Idle.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(testNames(result.tests)).toContain('LegacyTest');
  });

  it('still selects it when the change set is empty', () => {
    const result = analyze(graph, [], configWith({ maxReductionPercent: 100 }));
    expect(testNames(result.tests)).toEqual(['LegacyTest']);
  });

  it('records the reason, so the user can see why it ran', () => {
    const result = analyze(graph, [], configWith({ maxReductionPercent: 100 }));
    expect(result.tests[0]?.reason).toBe('see-all-data');
  });
});

describe('hypothesis: the reduction circuit breaker mis-handles its boundary', () => {
  const graph = graphOf({
    [`${CLASS_DIR}/Target.cls`]: 'public class Target { public static void run() {} }',
    [`${CLASS_DIR}/TargetTest.cls`]:
      '@IsTest private class TargetTest { @IsTest static void t() { Target.run(); } }',
    [`${CLASS_DIR}/A1Test.cls`]: '@IsTest private class A1Test { @IsTest static void t() { System.assertEquals(1,1); } }',
    [`${CLASS_DIR}/A2Test.cls`]: '@IsTest private class A2Test { @IsTest static void t() { System.assertEquals(1,1); } }',
    [`${CLASS_DIR}/A3Test.cls`]: '@IsTest private class A3Test { @IsTest static void t() { System.assertEquals(1,1); } }',
  });
  const changed = [{ path: `${CLASS_DIR}/Target.cls`, kind: 'modified' as const }];

  it('skips exactly 75% here, which is the figure the breaker compares', () => {
    const result = analyze(graph, changed, configWith({ maxReductionPercent: 100 }));
    expect(result.reductionPercent).toBe(75);
  });

  it('does not fire when reduction equals the cap', () => {
    const result = analyze(graph, changed, configWith({ maxReductionPercent: 75, onExceed: 'runAll' }));
    expect(result.outcome).toBe('selected');
  });

  it('fires one notch below the cap', () => {
    const result = analyze(graph, changed, configWith({ maxReductionPercent: 74.9, onExceed: 'runAll' }));
    expect(result.outcome).toBe('full');
  });

  it('a cap of 0 forces a full run whenever anything is skipped', () => {
    const result = analyze(graph, changed, configWith({ maxReductionPercent: 0, onExceed: 'runAll' }));
    expect(result.outcome).toBe('full');
  });
});

describe('hypothesis: excludeFromImpact can suppress a real dependency', () => {
  const graph = graphOf({
    [`${CLASS_DIR}/Service.cls`]: 'public class Service { public static void run() {} }',
    [`${CLASS_DIR}/ServiceTest.cls`]:
      '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }',
  });

  it('excluding a real Apex file does suppress its tests — the documented footgun', () => {
    // This is user-configured behaviour, not a defect, but it is the sharpest edge in the
    // config: excluding a .cls silently removes it from impact analysis entirely.
    const result = analyze(
      graph,
      [{ path: `${CLASS_DIR}/Service.cls`, kind: 'modified' }],
      configWith({ excludeFromImpact: ['**/Service.cls'], maxReductionPercent: 100 }),
    );
    expect(result.outcome).toBe('selected');
    expect(result.tests).toEqual([]);
  });

  it('reports the file as deliberately excluded rather than silently missing', () => {
    const changeSet = resolveChangeSet(
      graph,
      [{ path: `${CLASS_DIR}/Service.cls`, kind: 'modified' }],
      configWith({ excludeFromImpact: ['**/Service.cls'] }),
    );
    expect(changeSet.excluded).toEqual([`${CLASS_DIR}/Service.cls`]);
    expect(changeSet.unmapped).toEqual([]);
  });
});

describe('hypothesis: duplicate declarations inside one file corrupt the graph', () => {
  it('survives a file declaring the same inner class twice', () => {
    // Inner types carry the `apexInner` kind, so the key is `apexInner:c.dup.inner`. The
    // duplicate collapses to one node rather than producing two or corrupting the table.
    const graph = graphOf({
      [`${CLASS_DIR}/Dup.cls`]: 'public class Dup { public class Inner {} public class Inner {} }',
    });
    expect(graph.nodes.filter((n) => n.key === 'apexInner:c.dup.inner')).toHaveLength(1);
    expect(graph.nodeByKey('apex:c.dup')).toBeDefined();
    // Spread before sorting: `nodesDeclaredIn` hands back the graph's own array, and an
    // in-place sort would reorder its internal index as a side effect of asserting on it.
    expect([...graph.nodesDeclaredIn(`${CLASS_DIR}/Dup.cls`)].sort()).toEqual([
      'apex:c.dup',
      'apexInner:c.dup.inner',
    ]);
  });

  it('survives a class whose name does not match its filename', () => {
    // Apex requires them to match; a repository can still contain a mismatch.
    const graph = graphOf({ [`${CLASS_DIR}/Named.cls`]: 'public class Different { }' });
    expect(graph.nodeByKey('apex:c.different')).toBeDefined();
    // The declaring file is still the one on disk, so a change to it seeds correctly.
    expect(graph.nodesDeclaredIn(`${CLASS_DIR}/Named.cls`)).toContain('apex:c.different');
  });
});

describe('hypothesis: every selected test is a real, declared test class', () => {
  it('never selects a node that is not flagged IS_TEST', () => {
    const graph = graphOf({
      [`${CLASS_DIR}/A.cls`]: 'public class A { public static void go() { B.go(); } }',
      [`${CLASS_DIR}/B.cls`]: 'public class B { public static void go() {} }',
      [`${CLASS_DIR}/ATest.cls`]: '@IsTest private class ATest { @IsTest static void t() { A.go(); } }',
    });
    const result = analyze(
      graph,
      [{ path: `${CLASS_DIR}/B.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    const testKeys = new Set(allTestClasses(graph).map((n) => n.name));
    for (const selected of result.tests) expect(testKeys.has(selected.name)).toBe(true);
  });
});

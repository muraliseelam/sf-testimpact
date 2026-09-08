/**
 * Source-path scoping in the change set (DESIGN.md 7.1).
 *
 * Found by a coverage audit of `src/query/`: `outsideSourcePaths` had NO test at all, and
 * it is the one branch in the change-set mapper that makes the tool select *fewer* tests.
 * Every other path in that function either seeds nodes or escalates to a full run; this one
 * drops a changed file on the floor. An untested selection-narrowing branch is exactly the
 * shape of a future false negative, so it is pinned from both sides here: files outside the
 * configured source paths are ignored, and files inside them never are.
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { buildGraph, currentGenerator } from '../../src/graph/store.js';
import { analyze } from '../../src/query/analyze.js';
import { resolveChangeSet, componentPathFor } from '../../src/query/changeSet.js';
import { configWith, testNames } from '../helpers/buildGraph.js';
import type { FileFacts } from '../../src/types.js';

const CLASSES = 'force-app/main/default/classes';

const facts: FileFacts[] = [
  extractApex(`${CLASSES}/Svc.cls`, 'public class Svc { public static void go() { Integer x = 1; } }'),
  extractApex(`${CLASSES}/SvcTest.cls`, '@IsTest private class SvcTest { @IsTest static void t() { Svc.go(); } }'),
];

const graph = buildGraph(
  facts.map((f) => ({ path: f.path, hash: 'h', parsedOk: true, extractor: f.extractor })),
  facts,
  { root: '.', sourcePaths: ['force-app'], namespace: 'c' },
  currentGenerator(),
  'x',
);

const changeSetFor = (paths: string[]) =>
  resolveChangeSet(
    graph,
    paths.map((path) => ({ path, kind: 'modified' as const })),
    configWith(),
  );

describe('files outside every configured source path are not project metadata', () => {
  it.each([
    '.github/workflows/ci.yml',
    'README.md',
    'scripts/deploy.sh',
    'package.json',
    'docs/DESIGN.md',
  ])('ignores %s', (path) => {
    const result = changeSetFor([path]);
    expect(result.outsideSourcePaths).toEqual([path]);
    expect(result.unmapped).toEqual([]);
    expect(result.seeds).toEqual([]);
  });

  it('does not escalate to a full run for out-of-tree noise', () => {
    // This is the behaviour that took the measured fallback rate down: an unmodelled file
    // type inside the source tree still forces a full run, but a CI workflow does not.
    const result = analyze(
      graph,
      [{ path: '.github/workflows/ci.yml', kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(result.outcome).toBe('selected');
    expect(result.tests).toEqual([]);
  });
});

describe('files INSIDE the source paths are never silently dropped', () => {
  it('a known source file seeds its nodes', () => {
    const result = changeSetFor([`${CLASSES}/Svc.cls`]);
    expect(result.outsideSourcePaths).toEqual([]);
    expect(result.seeds).toContain('apex:c.svc');
  });

  it('an UNMODELLED file inside the source paths still forces a full run', () => {
    // The dangerous direction. If source-path scoping ever swallowed these, an unknown
    // metadata type would silently select nothing instead of everything.
    const result = analyze(
      graph,
      [{ path: 'force-app/main/default/layouts/Account-Layout.layout-meta.xml', kind: 'modified' }],
      configWith(),
    );
    expect(result.outcome).toBe('full');
    expect(result.decisions.some((d) => d.rule === 'unmodelled-file-type')).toBe(true);
  });

  it('an unknown .cls inside the source paths still forces a full run', () => {
    const result = analyze(graph, [{ path: `${CLASSES}/Ghost.cls`, kind: 'added' }], configWith());
    expect(result.outcome).toBe('full');
    expect(result.decisions.some((d) => d.rule === 'changed-file-not-in-index')).toBe(true);
  });

  it('still selects the right test for an in-tree change', () => {
    const result = analyze(
      graph,
      [{ path: `${CLASSES}/Svc.cls`, kind: 'modified' }],
      configWith({ maxReductionPercent: 100 }),
    );
    expect(testNames(result.tests)).toEqual(['SvcTest']);
  });
});

describe('source-path matching is prefix-safe', () => {
  it('does not treat a sibling directory with a shared prefix as in-tree', () => {
    // `force-app-legacy/` must not match a `force-app` source path by string prefix alone.
    const result = changeSetFor(['force-app-legacy/classes/Old.cls']);
    expect(result.outsideSourcePaths).toEqual(['force-app-legacy/classes/Old.cls']);
  });

  it('treats the source path itself as in-tree', () => {
    const result = changeSetFor(['force-app']);
    expect(result.outsideSourcePaths).toEqual([]);
  });

  it('project config is checked before source-path scoping', () => {
    // sfdx-project.json lives at the repo root, outside every source path. It must still
    // force a full run: it determines what gets indexed at all.
    const result = analyze(graph, [{ path: 'sfdx-project.json', kind: 'modified' }], configWith());
    expect(result.outcome).toBe('full');
    expect(result.decisions.some((d) => d.rule === 'project-config-changed')).toBe(true);
  });
});

describe('componentPathFor', () => {
  it('maps a -meta.xml companion to the file it belongs to', () => {
    expect(componentPathFor(`${CLASSES}/Svc.cls-meta.xml`)).toBe(`${CLASSES}/Svc.cls`);
  });

  it('maps a static resource bundle member to its .resource-meta.xml', () => {
    expect(componentPathFor('force-app/main/default/staticresources/docs/a.md')).toBe(
      'force-app/main/default/staticresources/docs.resource-meta.xml',
    );
  });

  it('returns null for a path that is its own component', () => {
    expect(componentPathFor(`${CLASSES}/Svc.cls`)).toBeNull();
    expect(componentPathFor('force-app/main/default/objects/A__c/A__c.object-meta.xml')).toBeNull();
  });
});

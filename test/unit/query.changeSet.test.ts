/**
 * Change-set resolution: git status parsing, deletions, renames and exclusions
 * (DESIGN.md 7.1).
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/query/analyze.js';
import { gitChangedFiles, resolveChangeSet, type ChangedFile } from '../../src/query/changeSet.js';
import { TestImpactError } from '../../src/errors.js';
import { CLASS_DIR, apexKey, cls, configWith, graphOf, testNames } from '../helpers/buildGraph.js';

const FIXTURE = graphOf([
  cls('Service', 'public class Service { public static void run() {} }'),
  cls('Caller', 'public class Caller { void m() { Service.run(); } }'),
  cls('CallerTest', '@IsTest private class CallerTest { @IsTest static void t() { new Caller(); } }'),
  cls('ServiceTest', '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }'),
]);

describe('gitChangedFiles', () => {
  it('parses added, modified and deleted entries', () => {
    const run = () => ['A\tsrc/New.cls', 'M\tsrc/Old.cls', 'D\tsrc/Gone.cls'].join('\n');
    expect(gitChangedFiles(run, 'main')).toEqual([
      { path: 'src/New.cls', kind: 'added' },
      { path: 'src/Old.cls', kind: 'modified' },
      { path: 'src/Gone.cls', kind: 'deleted' },
    ]);
  });

  it('decomposes a rename into a delete of the old path and an add of the new one', () => {
    // `--name-only` would report only the destination, silently losing the old path whose
    // nodes everything downstream still depends on.
    const run = () => 'R100\tsrc/Old.cls\tsrc/New.cls';
    expect(gitChangedFiles(run, 'main')).toEqual([
      { path: 'src/Old.cls', kind: 'deleted' },
      { path: 'src/New.cls', kind: 'added' },
    ]);
  });

  it('decomposes a copy the same way', () => {
    const run = () => 'C75\tsrc/Source.cls\tsrc/Copy.cls';
    expect(gitChangedFiles(run, 'main').map((f) => f.kind)).toEqual(['deleted', 'added']);
  });

  it('uses a three-dot range so the diff is merge-base aware', () => {
    const seen: string[][] = [];
    gitChangedFiles((args) => {
      seen.push([...args]);
      return '';
    }, 'main', 'feature');
    expect(seen[0]).toContain('main...feature');
    expect(seen[0]).toContain('--find-renames');
  });

  it('ignores blank lines', () => {
    expect(gitChangedFiles(() => '\nM\ta.cls\n\n', 'main')).toHaveLength(1);
  });

  it('throws a typed error naming the range when git fails', () => {
    const run = (): string => {
      throw new Error('fatal: bad revision');
    };
    try {
      gitChangedFiles(run, 'nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TestImpactError);
      expect((error as TestImpactError).code).toBe('GIT_FAILED');
      expect((error as TestImpactError).subject).toBe('nope...HEAD');
    }
  });
});

describe('resolveChangeSet — deletions', () => {
  it('seeds a deleted file’s nodes, because its dependents must still be retested', () => {
    const changed: ChangedFile[] = [{ path: `${CLASS_DIR}/Service.cls`, kind: 'deleted' }];
    const { seeds } = resolveChangeSet(FIXTURE.graph, changed, configWith());
    expect(seeds).toContain(apexKey('Service'));
  });

  it('selects the tests that depended on a deleted class', () => {
    const result = analyze(
      FIXTURE.graph,
      [{ path: `${CLASS_DIR}/Service.cls`, kind: 'deleted' }],
      configWith(),
    );
    expect(result.outcome).toBe('selected');
    // Caller depends on Service, so CallerTest must run even though only Service was deleted.
    expect(testNames(result.tests)).toEqual(['CallerTest', 'ServiceTest']);
  });

  it('does not report a deleted, indexed file as missing from the index', () => {
    const changed: ChangedFile[] = [{ path: `${CLASS_DIR}/Service.cls`, kind: 'deleted' }];
    const { unmapped } = resolveChangeSet(FIXTURE.graph, changed, configWith());
    expect(unmapped).toEqual([]);
  });
});

describe('resolveChangeSet — renames', () => {
  const renamed: ChangedFile[] = [
    { path: `${CLASS_DIR}/Service.cls`, kind: 'deleted' },
    { path: `${CLASS_DIR}/RenamedService.cls`, kind: 'added' },
  ];

  it('seeds the old path’s nodes', () => {
    const { seeds } = resolveChangeSet(FIXTURE.graph, renamed, configWith());
    expect(seeds).toContain(apexKey('Service'));
  });

  it('reports the new path as absent from the index', () => {
    // The index describes the base revision, so the destination is genuinely unknown.
    const { unmapped } = resolveChangeSet(FIXTURE.graph, renamed, configWith());
    expect(unmapped).toEqual([
      { path: `${CLASS_DIR}/RenamedService.cls`, reason: 'not-in-index' },
    ]);
  });

  it('falls back to the full suite for a rename, since the destination is unknown', () => {
    const result = analyze(FIXTURE.graph, renamed, configWith());
    expect(result.outcome).toBe('full');
    expect(result.decisions.some((d) => d.rule === 'changed-file-not-in-index')).toBe(true);
  });
});

describe('resolveChangeSet — exclusions', () => {
  it('ignores excluded paths without reporting them as unmapped', () => {
    const changed: ChangedFile[] = [{ path: 'README.md', kind: 'modified' }];
    const config = configWith({ excludeFromImpact: ['**/*.md'] });
    const result = resolveChangeSet(FIXTURE.graph, changed, config);
    expect(result.excluded).toEqual(['README.md']);
    expect(result.unmapped).toEqual([]);
    expect(result.seeds).toEqual([]);
  });

  it('an excluded-only change set selects nothing at all', () => {
    const config = configWith({ excludeFromImpact: ['**/*.md'], maxReductionPercent: 100 });
    const result = analyze(FIXTURE.graph, [{ path: 'docs/a.md', kind: 'modified' }], config);
    expect(result.outcome).toBe('selected');
    expect(result.tests).toEqual([]);
  });
});

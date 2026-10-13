/**
 * Regressions for defects found by driving the PUBLISHED v0.1.0 package as three users.
 *
 * Every case here is something that unit tests passed straight through because they exercise
 * the library rather than the command a person actually types. They are grouped by the
 * finding that produced them so a future reader can tell what the test is protecting.
 */

import { describe, expect, it } from 'vitest';
import { buildDeployPlan, passthroughArgs } from '../../src/deploy/plan.js';
import { staticResourceOwnerOf } from '../../src/extract/staticresource.js';
import { componentPathFor } from '../../src/query/changeSet.js';
import { TestImpactError, ConfigError, ExtractorError } from '../../src/errors.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import type { AnalysisResult } from '../../src/query/analyze.js';

/** Minimal analyze result: only what deployPlan reads. */
function resultWith(testNames: readonly string[], outcome: 'selected' | 'full' = 'selected'): AnalysisResult {
  return {
    outcome,
    tests: testNames.map((name) => ({ name, reason: 'impacted' as const })),
    totalTests: 10,
    selectedCount: testNames.length,
    reductionPercent: 0,
    decisions: [],
    seeds: [],
    activatedTaintDomains: [],
    coverageGaps: [],
  } as unknown as AnalysisResult;
}

describe('deploy passes --tests in the form sf project deploy start accepts', () => {
  // FOUND BY: running `sf testimpact deploy` for real. The dry-run printed a plausible
  // command line, so nothing caught that the comma form is rejected:
  //   "The previous version of this command used a comma-separated list for tests. We've
  //    changed how you specify multiple tests, so if you continue using your current syntax,
  //    your tests will probably not run as you expect."
  // A deploy gate that cannot deploy is the worst kind of green.
  const plan = (names: readonly string[]) => buildDeployPlan(resultWith(names), DEFAULT_CONFIG, []);

  it('repeats the flag once per test instead of comma-joining', () => {
    const { args } = plan(['A', 'B', 'C']);
    expect(args).toEqual([
      '--test-level',
      'RunSpecifiedTests',
      '--tests',
      'A',
      '--tests',
      'B',
      '--tests',
      'C',
    ]);
  });

  it('never emits a comma-joined test list', () => {
    // The control: this is the exact string the old implementation produced.
    const { args } = plan(['A', 'B', 'C']);
    expect(args).not.toContain('A,B,C');
    expect(args.some((a) => a.includes(','))).toBe(false);
  });

  it('still works for a single test', () => {
    expect(plan(['Only']).args).toEqual(['--test-level', 'RunSpecifiedTests', '--tests', 'Only']);
  });

  it('keeps passthrough flags after the test list', () => {
    const { args } = buildDeployPlan(resultWith(['A', 'B']), DEFAULT_CONFIG, ['--wait', '30']);
    expect(args.slice(-2)).toEqual(['--wait', '30']);
    expect(args).toEqual([
      '--test-level',
      'RunSpecifiedTests',
      '--tests',
      'A',
      '--tests',
      'B',
      '--wait',
      '30',
    ]);
  });
});

describe('deploy hands everything after -- to sf project deploy start, verbatim and in order', () => {
  // FOUND BY: capturing the documentation's examples against 1.3.0. oclif sorts its parsed
  // argv by each token's first position on the command line, so the passthrough
  // `-- --source-dir A.cls --source-dir B.cls` reached sf as `--source-dir --source-dir A.cls
  // B.cls`, and `--dry-run` after `--` jumped ahead of `--manifest` because deploy's own
  // `--dry-run` came earlier. Each `oclifArgv` below is what oclif produced for that line.
  const commandLine = (...after: string[]) => [
    '--base',
    'main',
    '--target-org',
    'dev',
    '--dry-run',
    '--',
    ...after,
  ];

  it('keeps a repeated flag paired with its values', () => {
    const after = ['--source-dir', 'A.cls', '--source-dir', 'B.cls'];
    const oclifArgv = ['--source-dir', '--source-dir', 'A.cls', 'B.cls'];
    expect(passthroughArgs(commandLine(...after), oclifArgv)).toEqual({
      passthrough: after,
      unexpected: [],
    });
  });

  it('keeps a token that also appears before the separator where it was written', () => {
    const after = ['--manifest', 'delta/package/package.xml', '--dry-run', '--wait', '60'];
    const oclifArgv = ['--dry-run', '--manifest', 'delta/package/package.xml', '--wait', '60'];
    expect(passthroughArgs(commandLine(...after), oclifArgv)).toEqual({
      passthrough: after,
      unexpected: [],
    });
  });

  it('passes nothing when there is no separator', () => {
    expect(passthroughArgs(['--base', 'main'], [])).toEqual({ passthrough: [], unexpected: [] });
  });

  it('passes a second -- through like any other argument', () => {
    const raw = ['--base', 'main', '--', 'a', '--', 'b'];
    expect(passthroughArgs(raw, ['a', '--', 'b'])).toEqual({
      passthrough: ['a', '--', 'b'],
      unexpected: [],
    });
  });

  it('reports a positional argument before the separator instead of forwarding it', () => {
    const raw = ['--base', 'main', 'force-app', '--', '--wait', '60'];
    expect(passthroughArgs(raw, ['force-app', '--wait', '60'])).toEqual({
      passthrough: ['--wait', '60'],
      unexpected: ['force-app'],
    });
    expect(passthroughArgs(['--base', 'main', 'force-app'], ['force-app'])).toEqual({
      passthrough: [],
      unexpected: ['force-app'],
    });
  });

  it('counts a stray argument that repeats a passthrough token', () => {
    // `60` appears twice in oclif's argv but only once after the separator.
    const raw = ['--base', 'main', '60', '--', '--wait', '60'];
    expect(passthroughArgs(raw, ['60', '60', '--wait']).unexpected).toEqual(['60']);
  });
});

describe('single-file static resources resolve to their descriptor', () => {
  // FOUND BY: changing `staticresources/SeedAccounts.csv` forced a FULL RUN. Only the
  // directory-bundle layout was handled, so the commoner single-file layout resolved to
  // nothing and was classified as an unmodelled file type. Safe, but it quietly undid the
  // static-resource modelling for most real projects.
  const dir = 'force-app/main/default/staticresources';

  it('maps a sibling payload file to its .resource-meta.xml', () => {
    expect(staticResourceOwnerOf(`${dir}/SeedAccounts.csv`)).toBe(`${dir}/SeedAccounts.resource-meta.xml`);
  });

  it.each(['csv', 'json', 'zip', 'png', 'txt'])('handles a .%s payload', (ext) => {
    expect(staticResourceOwnerOf(`${dir}/Bundle.${ext}`)).toBe(`${dir}/Bundle.resource-meta.xml`);
  });

  it('still maps bundle-directory members', () => {
    expect(staticResourceOwnerOf(`${dir}/docs/a.md`)).toBe(`${dir}/docs.resource-meta.xml`);
    expect(staticResourceOwnerOf(`${dir}/docs/nested/deep/a.md`)).toBe(`${dir}/docs.resource-meta.xml`);
  });

  it('does NOT report the descriptor as owning itself', () => {
    // Self-ownership would make the descriptor its own component parent, which at best is a
    // wasted lookup and at worst a cycle in change-set mapping.
    expect(staticResourceOwnerOf(`${dir}/SeedAccounts.resource-meta.xml`)).toBeNull();
  });

  it('ignores files outside a staticresources directory', () => {
    expect(staticResourceOwnerOf('force-app/main/default/classes/A.cls')).toBeNull();
    expect(staticResourceOwnerOf('docs/notes.csv')).toBeNull();
  });

  it('componentPathFor routes a single-file resource the same way', () => {
    expect(componentPathFor(`${dir}/SeedAccounts.csv`)).toBe(`${dir}/SeedAccounts.resource-meta.xml`);
  });
});

describe('error remedies reach the user', () => {
  // FOUND BY: `analyze --base nosuchref` printed only "Error (GIT_FAILED): Could not diff
  // nosuchref...HEAD." and `--json` carried no remedy field. The remedy was set at the throw
  // site and rendered by format(), but nothing called format(): sf-plugins-core builds its
  // output from the error's `actions`. Every carefully-written remedy was dropped.
  it('exposes the remedy as sf `actions`', () => {
    const err = new TestImpactError('GIT_FAILED', 'Could not diff a...b.', {
      subject: 'a...b',
      remedy: 'Fetch the base ref first.',
    });
    expect(err.actions).toEqual(['Fetch the base ref first.']);
  });

  it('leaves actions undefined when there is no remedy, rather than inventing an empty one', () => {
    // An empty actions array renders as a "Try this:" heading with nothing under it.
    expect(new TestImpactError('GRAPH_STALE', 'No index.').actions).toBeUndefined();
  });

  it('applies to every subclass, so no throw site can forget', () => {
    expect(new ConfigError('bad', { remedy: 'Fix the key.' }).actions).toEqual(['Fix the key.']);
    expect(new ExtractorError('apex@1', 'A.cls', new Error('x')).actions?.length).toBe(1);
  });

  it('keeps format() and actions consistent', () => {
    const err = new ConfigError('bad key', { subject: '.sf-testimpact.yml', remedy: 'Remove it.' });
    expect(err.format()).toContain('Remove it.');
    expect(err.actions).toEqual([err.remedy]);
  });
});

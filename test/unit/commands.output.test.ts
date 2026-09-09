/**
 * Regressions for two findings from the first external user testing.
 *
 * Both are about what a person reads on a terminal, which is why neither was caught by the
 * existing suite: the library was right, and the prose around it was not.
 *
 * See docs/USER-TESTING.md, findings A3 and C2.
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { buildGraph, currentGenerator } from '../../src/graph/store.js';
import { analyze } from '../../src/query/analyze.js';
import { configWith } from '../helpers/buildGraph.js';
import type { FileFacts } from '../../src/types.js';

const DIR = 'force-app/main/default/classes';
const cls = (name: string, body: string) => extractApex(`${DIR}/${name}.cls`, body);

/** `count` @AuraEnabled entry points, all reachable from one shared helper. */
function graphWithEntryPoints(count: number) {
  const facts: FileFacts[] = [
    cls('Shared', 'public class Shared { public static Integer v() { return 1; } }'),
    cls('SharedTest', '@IsTest private class SharedTest { @IsTest static void t() { Shared.v(); } }'),
  ];
  for (let i = 0; i < count; i++) {
    facts.push(
      cls(
        `Entry${i}`,
        `public with sharing class Entry${i} { @AuraEnabled public static Integer f() { return Shared.v(); } }`,
      ),
    );
  }
  return buildGraph(
    facts.map((f) => ({ path: f.path, hash: 'h', parsedOk: true, extractor: f.extractor })),
    facts,
    { root: '.', sourcePaths: ['force-app'], namespace: 'c' },
    currentGenerator(),
    'x',
  );
}

const changeShared = [{ path: `${DIR}/Shared.cls`, kind: 'modified' as const }];

describe('C2: the entry-point fallback message stays readable at scale', () => {
  it('prints every name when there are only a few', () => {
    const result = analyze(graphWithEntryPoints(4), changeShared, configWith());
    const decision = result.decisions.find((d) => d.rule === 'entry-point-policy-full');
    expect(decision?.message).toContain('Entry1');
    expect(decision?.message).not.toContain('more (full list in');
  });

  it('caps the prose once the list gets long', () => {
    // NPSP produced 131 names in a single line, which buried the rule and the count the
    // message exists to communicate.
    const result = analyze(graphWithEntryPoints(40), changeShared, configWith());
    const decision = result.decisions.find((d) => d.rule === 'entry-point-policy-full');
    expect(decision?.message).toContain('more (full list in `--json`)');
  });

  it('keeps the message short enough to read', () => {
    const result = analyze(graphWithEntryPoints(131), changeShared, configWith());
    const decision = result.decisions.find((d) => d.rule === 'entry-point-policy-full');
    // The NPSP message ran to several thousand characters. A cap of 600 is generous and
    // still guarantees the line is legible.
    expect((decision?.message ?? '').length).toBeLessThan(600);
  });

  it('does NOT discard the names — every one is still on the decision', () => {
    // The cap is a presentation change only. The full list is what a reader needs to decide
    // whether `widen` is safe, and it stays available for `--json` and for tooling.
    const result = analyze(graphWithEntryPoints(131), changeShared, configWith());
    const decision = result.decisions.find((d) => d.rule === 'entry-point-policy-full');
    expect(decision?.subjects).toHaveLength(131);
    expect(decision?.subjects).toContain('Entry130');
  });

  it('keeps the counterfactual list complete too', () => {
    const result = analyze(
      graphWithEntryPoints(131),
      changeShared,
      configWith({ maxReductionPercent: 100 }),
    );
    expect(result.counterfactual?.assumesNoExternalCallerOf).toHaveLength(131);
  });
});

describe('A3: an empty change set is not a reduction', () => {
  it('selects nothing and reports a 100% reduction when nothing changed', () => {
    // The underlying numbers are correct; this pins the shape the CLI has to explain, so a
    // future change cannot make the misleading rendering correct-looking again.
    const result = analyze(graphWithEntryPoints(2), [], configWith({ maxReductionPercent: 100 }));
    expect(result.outcome).toBe('selected');
    expect(result.tests).toEqual([]);
    expect(result.reductionPercent).toBe(100);
  });

  it('produces no fallback decisions for an empty change set', () => {
    // So the CLI can distinguish "nothing changed" from "something changed and was skipped"
    // by the change count alone.
    const result = analyze(graphWithEntryPoints(2), [], configWith({ maxReductionPercent: 100 }));
    expect(result.decisions.filter((d) => d.level === 'fallback')).toEqual([]);
  });
});

/**
 * Safety layer: every Level 3 fallback trigger, the entry-point policies, and the
 * reduction circuit breaker (DESIGN.md 6.3, 6.5, 8).
 *
 * Each fallback test asserts on the *log content*, not merely that a fallback occurred.
 * A tool that silently runs everything is indistinguishable from a broken one, so naming
 * the rule and the offending file is part of the behaviour under test.
 */

import { describe, expect, it } from 'vitest';
import { analyze, formatDecisions } from '../../src/query/analyze.js';
import { type ChangedFile } from '../../src/query/changeSet.js';
import { type Decision } from '../../src/query/safety.js';
import { CLASS_DIR, cls, configWith, graphOf, testNames } from '../helpers/buildGraph.js';

const modified = (path: string): ChangedFile => ({ path, kind: 'modified' });

function ruleFired(decisions: readonly Decision[], rule: string): Decision {
  const found = decisions.find((d) => d.rule === rule);
  if (found === undefined) {
    throw new Error(`rule ${rule} did not fire; got: ${decisions.map((d) => d.rule).join(', ')}`);
  }
  return found;
}

const BASIC = graphOf([
  cls('Service', 'public class Service { public static void run() {} }'),
  cls('ServiceTest', '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }'),
]);

describe('Level 3 fallback — a changed file failed to parse (DESIGN.md 6.5)', () => {
  const broken = graphOf([
    cls('Broken', 'public class Broken { void m( { } }'),
    cls('BrokenTest', '@IsTest private class BrokenTest { @IsTest static void t() { Broken.go(); } }'),
  ]);

  it('falls back to the full suite and names the file and the rule', () => {
    const result = analyze(broken.graph, [modified(`${CLASS_DIR}/Broken.cls`)], configWith());
    expect(result.outcome).toBe('full');

    const decision = ruleFired(result.decisions, 'changed-file-parse-failed');
    expect(decision.level).toBe('fallback');
    expect(decision.subject).toBe(`${CLASS_DIR}/Broken.cls`);
    expect(decision.message).toContain('Broken.cls');
    expect(decision.message).toContain('could not be parsed');
  });

  it('offers the cheaper safe alternative in the hint', () => {
    const result = analyze(broken.graph, [modified(`${CLASS_DIR}/Broken.cls`)], configWith());
    expect(ruleFired(result.decisions, 'changed-file-parse-failed').hint).toContain('taint.onParseError: widen');
  });

  it('widens instead of falling back when configured to', () => {
    const config = configWith({ taint: { ...configWith().taint, onParseError: 'widen' } });
    const result = analyze(broken.graph, [modified(`${CLASS_DIR}/Broken.cls`)], config);
    expect(result.outcome).toBe('selected');
    const decision = ruleFired(result.decisions, 'changed-file-parse-failed-widened');
    expect(decision.level).toBe('widen');
    expect(decision.subject).toBe(`${CLASS_DIR}/Broken.cls`);
  });
});

describe('Level 3 fallback — an unmodelled metadata type changed', () => {
  const path = 'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml';

  it('falls back and names the file and the rule', () => {
    const result = analyze(BASIC.graph, [modified(path)], configWith());
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'unmodelled-file-type');
    expect(decision.level).toBe('fallback');
    expect(decision.subject).toBe(path);
    expect(decision.message).toContain('does not model');
  });

  it('is silent when the path is excluded from impact', () => {
    const config = configWith({ excludeFromImpact: ['**/layouts/**'] });
    const result = analyze(BASIC.graph, [modified(path)], config);
    expect(result.outcome).toBe('selected');
    expect(result.decisions.filter((d) => d.level === 'fallback')).toEqual([]);
  });
});

describe('Level 3 fallback — a changed file is not in the index', () => {
  it('falls back and names the file and the rule', () => {
    const path = `${CLASS_DIR}/BrandNew.cls`;
    const result = analyze(BASIC.graph, [{ path, kind: 'added' }], configWith());
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'changed-file-not-in-index');
    expect(decision.level).toBe('fallback');
    expect(decision.subject).toBe(path);
    expect(decision.message).toContain('not in the index');
    expect(decision.hint).toContain('sf testimpact index');
  });
});

describe('Level 3 fallback — project configuration changed', () => {
  it.each(['sfdx-project.json', '.sf-testimpact.yml'])('falls back when %s changes', (path) => {
    const result = analyze(BASIC.graph, [modified(path)], configWith());
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'project-config-changed');
    expect(decision.level).toBe('fallback');
    expect(decision.subject).toBe(path);
    expect(decision.message).toContain('what gets indexed');
  });

  it('fires even when the config file is matched by excludeFromImpact', () => {
    // Excluding the file that determines how indexing works must not be able to switch off
    // the check that the index is still valid.
    const config = configWith({ excludeFromImpact: ['**/*.json', '**/*.yml'] });
    const result = analyze(BASIC.graph, [modified('sfdx-project.json')], config);
    expect(result.outcome).toBe('full');
    expect(ruleFired(result.decisions, 'project-config-changed').level).toBe('fallback');
  });
});

describe('Level 3 fallback — a stale index (DESIGN.md 7.3)', () => {
  const changed = [modified(`${CLASS_DIR}/Service.cls`)];

  it('falls back on a format-version mismatch, naming both versions', () => {
    const stale = graphOf(
      [cls('Service', 'public class Service {}')],
      { generator: { formatVersion: 99, toolVersion: '0.1.0', apexParserVersion: '5.2.0' } },
    );
    const result = analyze(stale.graph, changed, configWith());
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'graph-stale-format-version');
    expect(decision.message).toContain('99');
    expect(decision.message).toContain('version 1');
    expect(decision.hint).toContain('index --force');
  });

  it('falls back on an apex-parser major-version change, naming both versions', () => {
    const stale = graphOf(
      [cls('Service', 'public class Service {}')],
      { generator: { formatVersion: 1, toolVersion: '0.1.0', apexParserVersion: '4.9.1' } },
    );
    const result = analyze(stale.graph, changed, configWith());
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'graph-stale-parser-version');
    expect(decision.message).toContain('4.9.1');
    expect(decision.message).toContain('5.2.0');
  });

  it('does not fall back on an apex-parser patch bump', () => {
    // A patch release cannot change what we extract, so invalidating would be pure cost.
    const fresh = graphOf(
      [cls('Service', 'public class Service {}')],
      { generator: { formatVersion: 1, toolVersion: '0.1.0', apexParserVersion: '5.9.9' } },
    );
    const result = analyze(fresh.graph, changed, configWith());
    expect(result.decisions.filter((d) => d.rule.startsWith('graph-stale'))).toEqual([]);
  });

  it('falls back on an extractor identity this build no longer emits', () => {
    const stale = graphOf([cls('Service', 'public class Service {}')], { extractorId: 'apex@0' });
    const result = analyze(stale.graph, changed, configWith());
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'graph-stale-extractor-identity');
    expect(decision.message).toContain('apex@0');
    expect(decision.message).toContain('extraction semantics have changed');
  });
});

describe('entry-point policy (DESIGN.md 6.3)', () => {
  /**
   * `SharedService` is reached by an Aura entry point and a Schedulable one. `OrderApi` is
   * another Aura entry point that does *not* touch it, and `BulkLoader` is an unrelated
   * Invocable entry point.
   */
  const fixture = graphOf([
    cls('SharedService', 'public class SharedService { public static void run() {} }'),
    cls('OtherService', 'public class OtherService { public static void run() {} }'),
    cls('RefundApi', 'public class RefundApi { @AuraEnabled public static void go() { SharedService.run(); } }'),
    cls('OrderApi', 'public class OrderApi { @AuraEnabled public static void go() { OtherService.run(); } }'),
    cls(
      'NightlyJob',
      'public class NightlyJob implements Schedulable { public void execute(SchedulableContext c) { SharedService.run(); } }',
    ),
    cls('BulkLoader', 'public class BulkLoader { @InvocableMethod public static void go() { OtherService.run(); } }'),
    cls('RefundApiTest', '@IsTest private class RefundApiTest { @IsTest static void t() { RefundApi.go(); } }'),
    cls('OrderApiTest', '@IsTest private class OrderApiTest { @IsTest static void t() { OrderApi.go(); } }'),
    cls('NightlyJobTest', '@IsTest private class NightlyJobTest { @IsTest static void t() { new NightlyJob(); } }'),
    cls('BulkLoaderTest', '@IsTest private class BulkLoaderTest { @IsTest static void t() { BulkLoader.go(); } }'),
    cls('SharedServiceTest', '@IsTest private class SharedServiceTest { @IsTest static void t() { SharedService.run(); } }'),
  ]);

  const changed = [modified(`${CLASS_DIR}/SharedService.cls`)];

  it('full: degrades to the configured full test level and explains the trade', () => {
    const result = analyze(fixture.graph, changed, configWith({ entryPointPolicy: 'full' }));
    expect(result.outcome).toBe('full');
    expect(result.testLevel).toBe('RunLocalTests');
    expect(result.tests).toEqual([]);

    const decision = ruleFired(result.decisions, 'entry-point-policy-full');
    expect(decision.message).toContain('callers may live outside this repository');
    // The hint must say what widen gives up, not just that it is faster.
    expect(decision.hint).toContain('entryPointPolicy: widen');
    expect(decision.hint).toContain('assumes no unindexed caller');
  });

  it('strict: trusts the graph and selects only the tests that reach the change', () => {
    const result = analyze(fixture.graph, changed, configWith({ entryPointPolicy: 'strict' }));
    expect(result.outcome).toBe('selected');
    expect(testNames(result.tests)).toEqual(['NightlyJobTest', 'RefundApiTest', 'SharedServiceTest']);

    const decision = ruleFired(result.decisions, 'entry-point-policy-strict');
    expect(decision.level).toBe('info');
    expect(decision.hint).toContain('can miss a test');
  });

  it('widen: also selects tests reaching other entry points of the same categories', () => {
    // RefundApi is aura and NightlyJob is schedulable, so OrderApi (aura) is widened in.
    const result = analyze(fixture.graph, changed, configWith({ entryPointPolicy: 'widen' }));
    expect(result.outcome).toBe('selected');
    expect(testNames(result.tests)).toEqual([
      'NightlyJobTest',
      'OrderApiTest',
      'RefundApiTest',
      'SharedServiceTest',
    ]);
  });

  it('widen: does not pull in an entry point of an unrelated category', () => {
    // BulkLoader is invocable; no impacted entry point is, so widening must not reach it.
    const result = analyze(fixture.graph, changed, configWith({ entryPointPolicy: 'widen' }));
    expect(testNames(result.tests)).not.toContain('BulkLoaderTest');
  });

  it('widen: names the categories it widened within', () => {
    const result = analyze(fixture.graph, changed, configWith({ entryPointPolicy: 'widen' }));
    const decision = ruleFired(result.decisions, 'entry-point-policy-widen');
    expect(decision.level).toBe('widen');
    expect(decision.message).toMatch(/aura|schedulable/);
  });

  it('the three policies are genuinely different on this fixture', () => {
    const of = (policy: 'full' | 'widen' | 'strict') =>
      testNames(analyze(fixture.graph, changed, configWith({ entryPointPolicy: policy })).tests);
    expect(of('full')).toEqual([]);
    expect(of('strict').length).toBeLessThan(of('widen').length);
  });

  it('no policy fires when no entry point is impacted', () => {
    // `Private` is reached only by its own test, so even the strictest policy has nothing to
    // say. Without this the suite could not distinguish "policy applied correctly" from
    // "policy fires unconditionally".
    const isolated = graphOf([
      cls('Isolated', 'public class Isolated { public static void run() {} }'),
      cls('IsolatedTest', '@IsTest private class IsolatedTest { @IsTest static void t() { Isolated.run(); } }'),
    ]);
    const result = analyze(
      isolated.graph,
      [modified(`${CLASS_DIR}/Isolated.cls`)],
      configWith({ entryPointPolicy: 'full' }),
    );
    expect(result.outcome).toBe('selected');
    expect(result.decisions.some((d) => d.rule.startsWith('entry-point-policy'))).toBe(false);
    expect(testNames(result.tests)).toEqual(['IsolatedTest']);
  });
});

describe('reduction circuit breaker (DESIGN.md 8)', () => {
  const many = graphOf([
    cls('Target', 'public class Target { public static void run() {} }'),
    cls('TargetTest', '@IsTest private class TargetTest { @IsTest static void t() { Target.run(); } }'),
    ...Array.from({ length: 20 }, (_, i) =>
      cls(`Idle${i}Test`, `@IsTest private class Idle${i}Test { @IsTest static void t() { System.assertEquals(1,1); } }`),
    ),
  ]);
  const changed = [modified(`${CLASS_DIR}/Target.cls`)];

  it('warns without changing the selection under onExceed: warn', () => {
    const config = configWith({ maxReductionPercent: 50, onExceed: 'warn' });
    const result = analyze(many.graph, changed, config);
    expect(result.outcome).toBe('selected');
    const decision = ruleFired(result.decisions, 'max-reduction-exceeded-warn');
    expect(decision.level).toBe('info');
    expect(decision.message).toContain('maxReductionPercent');
  });

  it('falls back under onExceed: runAll, naming the rule', () => {
    const config = configWith({ maxReductionPercent: 50, onExceed: 'runAll' });
    const result = analyze(many.graph, changed, config);
    expect(result.outcome).toBe('full');
    const decision = ruleFired(result.decisions, 'max-reduction-exceeded-run-all');
    expect(decision.level).toBe('fallback');
    expect(decision.message).toContain('Running the full suite');
  });

  it('fails the run under onExceed: fail', () => {
    const config = configWith({ maxReductionPercent: 50, onExceed: 'fail' });
    const result = analyze(many.graph, changed, config);
    expect(result.outcome).toBe('full');
    expect(ruleFired(result.decisions, 'max-reduction-exceeded-fail').level).toBe('fallback');
  });

  it('stays quiet when the reduction is within the configured limit', () => {
    const config = configWith({ maxReductionPercent: 99 });
    const result = analyze(many.graph, changed, config);
    expect(result.decisions.filter((d) => d.rule.startsWith('max-reduction'))).toEqual([]);
  });
});

describe('decision formatting', () => {
  it('renders one labelled line per decision, with hints indented beneath', () => {
    const lines = formatDecisions([
      { level: 'fallback', rule: 'r1', subject: 'a.cls', message: 'Something happened.', hint: 'Do this.' },
      { level: 'info', rule: 'r2', subject: 'b.cls', message: 'Noted.' },
    ]);
    expect(lines[0]).toContain('FALLBACK');
    expect(lines[0]).toContain('r1: Something happened.');
    expect(lines[0]).toContain('hint: Do this.');
    expect(lines[1]).toContain('INFO');
    expect(lines[1]).not.toContain('hint:');
  });
});

describe('taint activation is reported', () => {
  it('logs which node activated each domain, so widening is never silent', () => {
    const fixture = graphOf([
      cls('Widget', 'public class Widget {}'),
      cls('Dyn', "public class Dyn { void m() { Type t = Type.forName('Widget'); } }"),
      cls('DynTest', '@IsTest private class DynTest { @IsTest static void t() { new Dyn(); } }'),
    ]);
    const result = analyze(fixture.graph, [modified(`${CLASS_DIR}/Widget.cls`)], configWith());
    const decision = ruleFired(result.decisions, 'taint-domain-activated-apexType');
    expect(decision.level).toBe('widen');
    expect(decision.subject).toBe('Widget');
    expect(result.activatedDomains).toContain('apexType');
  });
});

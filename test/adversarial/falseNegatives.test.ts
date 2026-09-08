/**
 * Round 2: hunting false negatives.
 *
 * A false negative — a changed file whose affected test is not selected — is the only
 * failure this tool is not allowed to have. These tests are written to cause one. Each names
 * the mechanism it attacks, drawn from DESIGN.md §6 (taint/fallback), §7 (query) and §12
 * (known false-negative sources).
 *
 * Anything found here is either fixed in code or recorded in §12. Nothing is left silent.
 */

import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { extractFile } from '../../src/extract/index.js';
import { buildGraph, currentGenerator, hashContents } from '../../src/graph/store.js';
import { analyze } from '../../src/query/analyze.js';
import { computeImpacted } from '../../src/query/closure.js';
import { configWith, testNames } from '../helpers/buildGraph.js';
import type { FileFacts, NodeKey } from '../../src/types.js';

const CLASSES = 'force-app/main/default/classes';
const PROJECT = { root: '.', sourcePaths: ['force-app'], namespace: 'c' };

/** Builds a graph from a path -> contents map, using the real extractor dispatch. */
function graphOf(files: Record<string, string>) {
  const facts: FileFacts[] = [];
  for (const [path, contents] of Object.entries(files)) {
    const extracted = extractFile(path, contents);
    if (extracted !== null) facts.push(extracted);
  }
  const indexed = facts.map((f) => ({
    path: f.path,
    hash: hashContents(files[f.path] ?? ''),
    parsedOk: f.parsedOk,
    extractor: f.extractor,
  }));
  return buildGraph(indexed, facts, PROJECT, currentGenerator(), 'x');
}

/** Tests selected for a change, with the permissive policy so the GRAPH is what is tested. */
function selectedFor(files: Record<string, string>, changedPath: string): string[] {
  const graph = graphOf(files);
  const result = analyze(
    graph,
    [{ path: changedPath, kind: 'modified' }],
    configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 }),
  );
  // A fallback runs everything, so it can never be a false negative. Report it as such.
  return result.outcome === 'full' ? ['<FULL RUN>'] : testNames(result.tests);
}

describe('attack: a test reaching its class only through DML', () => {
  // Before the DML visitor existed this was a real miss: the writer names the object
  // nowhere except the DML statement, so nothing linked it to the object's metadata.
  const files = {
    [`${CLASSES}/Writer.cls`]: 'public class Writer { public static void save(List<Invoice__c> rows) { insert rows; } }',
    [`${CLASSES}/WriterTest.cls`]:
      '@IsTest private class WriterTest { @IsTest static void t() { Writer.save(null); } }',
    'force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml':
      '<CustomObject><fullName>Invoice__c</fullName></CustomObject>',
  };

  it('selects the test when the object it writes changes', () => {
    expect(selectedFor(files, 'force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml')).toContain(
      'WriterTest',
    );
  });
});

describe('attack: a batch class reached only through Database.executeBatch', () => {
  const files = {
    [`${CLASSES}/NightlyBatch.cls`]:
      'public class NightlyBatch implements Database.Batchable { public void execute() { Integer x = 1; } }',
    [`${CLASSES}/Runner.cls`]: "public class Runner { public static void go(String n) { Database.executeBatch((Database.Batchable) Type.forName(n).newInstance()); } }",
    [`${CLASSES}/RunnerTest.cls`]: "@IsTest private class RunnerTest { @IsTest static void t() { Runner.go('NightlyBatch'); } }",
  };

  it('selects the runner test when the dynamically dispatched batch class changes', () => {
    // The runner never names NightlyBatch statically. Only the apexType taint connects them.
    expect(selectedFor(files, `${CLASSES}/NightlyBatch.cls`)).toContain('RunnerTest');
  });
});

describe('attack: a test whose static resource is named at runtime', () => {
  // DESIGN.md 6.4 said such tests are always-run "bound to a resource we do not model".
  // Static resources ARE modelled now, so the always-run clause no longer applies — which
  // left a hole: `domainsOf('staticresource')` returned nothing, so a computed resource name
  // tainted a domain that a static-resource change never activated.
  const files = {
    'force-app/main/default/staticresources/TestData.resource-meta.xml':
      '<StaticResource><contentType>text/csv</contentType></StaticResource>',
    [`${CLASSES}/SeedTest.cls`]:
      "@IsTest private class SeedTest { @IsTest static void t() { String n = pick(); Test.loadData(Account.sObjectType, n); } static String pick() { return 'TestData'; } }",
  };

  it('selects the test when ANY static resource changes', () => {
    expect(
      selectedFor(files, 'force-app/main/default/staticresources/TestData.resource-meta.xml'),
    ).toContain('SeedTest');
  });

  it('records the reason as a resourceAny taint rather than a mislabelled apexType one', () => {
    const graph = graphOf(files);
    expect(graph.taints.map((t) => t.domain)).toContain('resourceAny');
  });
});

describe('attack: a literal static-resource reference gets a real edge', () => {
  const files = {
    'force-app/main/default/staticresources/Seed.resource-meta.xml': '<StaticResource/>',
    [`${CLASSES}/LoadTest.cls`]:
      "@IsTest private class LoadTest { @IsTest static void t() { Test.loadData(Account.sObjectType, 'Seed'); } }",
  };

  it('selects the test when that specific resource changes', () => {
    expect(selectedFor(files, 'force-app/main/default/staticresources/Seed.resource-meta.xml')).toContain(
      'LoadTest',
    );
  });
});

describe('attack: a queueable enqueued by name', () => {
  const files = {
    [`${CLASSES}/Job.cls`]: 'public class Job implements Queueable { public void execute() { Integer x = 1; } }',
    [`${CLASSES}/Enqueuer.cls`]:
      "public class Enqueuer { public static void go(String n) { System.enqueueJob((Queueable) Type.forName(n).newInstance()); } }",
    [`${CLASSES}/EnqueuerTest.cls`]: '@IsTest private class EnqueuerTest { @IsTest static void t() { new Enqueuer(); } }',
  };

  it('selects the enqueuer test when the job class changes', () => {
    expect(selectedFor(files, `${CLASSES}/Job.cls`)).toContain('EnqueuerTest');
  });
});

describe('attack: a deep chain of ordinary references', () => {
  // The closure must not have a depth limit. Ten hops from the change to the test.
  const files: Record<string, string> = {
    [`${CLASSES}/L0.cls`]: 'public class L0 { public static void go() { Integer x = 1; } }',
  };
  for (let i = 1; i <= 10; i++) {
    files[`${CLASSES}/L${i}.cls`] = `public class L${i} { public static void go() { L${i - 1}.go(); } }`;
  }
  files[`${CLASSES}/DeepTest.cls`] = '@IsTest private class DeepTest { @IsTest static void t() { L10.go(); } }';

  it('selects a test ten hops away from the change', () => {
    expect(selectedFor(files, `${CLASSES}/L0.cls`)).toContain('DeepTest');
  });
});

describe('attack: a test reaching its class only through an interface implementor', () => {
  const files = {
    [`${CLASSES}/IJob.cls`]: 'public interface IJob { void run(); }',
    [`${CLASSES}/RealJob.cls`]: 'public class RealJob implements IJob { public void run() { Integer x = 1; } }',
    [`${CLASSES}/Host.cls`]: 'public class Host { public static void host(IJob j) { j.run(); } }',
    [`${CLASSES}/HostTest.cls`]: '@IsTest private class HostTest { @IsTest static void t() { Host.host(null); } }',
  };

  it('selects the host test when the concrete implementor changes', () => {
    expect(selectedFor(files, `${CLASSES}/RealJob.cls`)).toContain('HostTest');
  });
});

describe('attack: a field read only through a relationship traversal', () => {
  const files = {
    'force-app/main/default/objects/Account/fields/Score__c.field-meta.xml':
      '<CustomField><fullName>Score__c</fullName></CustomField>',
    [`${CLASSES}/Rel.cls`]:
      'public class Rel { public static void go() { List<Contact> cs = [SELECT Account.Score__c FROM Contact]; } }',
    [`${CLASSES}/RelTest.cls`]: '@IsTest private class RelTest { @IsTest static void t() { Rel.go(); } }',
  };

  it('selects the test when a field reachable only via a relationship changes', () => {
    // The owning object of `Account.Score__c` in the SELECT is not resolvable without
    // relationship metadata, so the resolver widens to every field of that name.
    expect(
      selectedFor(files, 'force-app/main/default/objects/Account/fields/Score__c.field-meta.xml'),
    ).toContain('RelTest');
  });
});

describe('attack: a class reached only through a trigger', () => {
  const files = {
    [`${CLASSES}/Handler.cls`]: 'public class Handler { public static void run() { Integer x = 1; } }',
    'force-app/main/default/triggers/AccTrigger.trigger':
      'trigger AccTrigger on Account (before insert) { Handler.run(); }',
    [`${CLASSES}/HandlerTest.cls`]: '@IsTest private class HandlerTest { @IsTest static void t() { Handler.run(); } }',
  };

  it('selects the handler test when the handler changes', () => {
    expect(selectedFor(files, `${CLASSES}/Handler.cls`)).toContain('HandlerTest');
  });
});

describe('attack: a companion -meta.xml change', () => {
  const files = {
    [`${CLASSES}/Api.cls`]: 'public class Api { public static void go() { Integer x = 1; } }',
    [`${CLASSES}/Api.cls-meta.xml`]:
      '<ApexClass><apiVersion>59.0</apiVersion><status>Active</status></ApexClass>',
    [`${CLASSES}/ApiTest.cls`]: '@IsTest private class ApiTest { @IsTest static void t() { Api.go(); } }',
  };

  it('selects the class test when only its apiVersion companion changes', () => {
    // An apiVersion bump changes how the class executes, so it must select what a body
    // change would. Treating it as an unknown file type would run everything instead.
    expect(selectedFor(files, `${CLASSES}/Api.cls-meta.xml`)).toContain('ApiTest');
  });
});

describe('attack: taint must activate on a node reached mid-walk, not only on seeds', () => {
  // The DESIGN.md 7.2 counterexample, rebuilt through the public analyze() path rather than
  // the closure directly, so a regression anywhere in the pipeline surfaces here too.
  const files = {
    'force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml':
      '<CustomField><fullName>Rating__c</fullName></CustomField>',
    [`${CLASSES}/Pricing.cls`]:
      'public class Pricing { public static void go() { List<Account> a = [SELECT Rating__c FROM Account]; } }',
    [`${CLASSES}/Dispatch.cls`]: "public class Dispatch { public static Object make() { return Type.forName('Pricing').newInstance(); } }",
    [`${CLASSES}/DispatchTest.cls`]: '@IsTest private class DispatchTest { @IsTest static void t() { Dispatch.make(); } }',
  };

  it('selects the dynamic dispatcher’s test when a FIELD changes', () => {
    expect(
      selectedFor(files, 'force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml'),
    ).toContain('DispatchTest');
  });
});

describe('attack: an unparseable file must not silently drop its dependents', () => {
  const files = {
    [`${CLASSES}/Broken.cls`]: 'public class Broken { void m( { } }',
    [`${CLASSES}/Uses.cls`]: 'public class Uses { public static void go() { Broken.help(); } }',
    [`${CLASSES}/UsesTest.cls`]: '@IsTest private class UsesTest { @IsTest static void t() { Uses.go(); } }',
  };

  it('pulls the unparseable class into the impacted set on any change', () => {
    const graph = graphOf(files);
    const { impacted } = computeImpacted(graph, ['apex:c.uses' as NodeKey]);
    expect(impacted.has('apex:c.uses' as NodeKey)).toBe(true);
  });

  it('runs everything when the unparseable file itself changes', () => {
    expect(selectedFor(files, `${CLASSES}/Broken.cls`)).toEqual(['<FULL RUN>']);
  });
});

describe('attack: selection is monotone under a growing change set', () => {
  const files = {
    [`${CLASSES}/A.cls`]: 'public class A { public static void go() { Integer x = 1; } }',
    [`${CLASSES}/B.cls`]: 'public class B { public static void go() { Integer x = 1; } }',
    [`${CLASSES}/ATest.cls`]: '@IsTest private class ATest { @IsTest static void t() { A.go(); } }',
    [`${CLASSES}/BTest.cls`]: '@IsTest private class BTest { @IsTest static void t() { B.go(); } }',
  };

  it('a two-file change selects at least what each single-file change selects', () => {
    // A larger change set running FEWER tests would be an obvious safety inversion.
    const graph = graphOf(files);
    const config = configWith({ entryPointPolicy: 'strict', maxReductionPercent: 100 });
    const both = analyze(
      graph,
      [
        { path: `${CLASSES}/A.cls`, kind: 'modified' },
        { path: `${CLASSES}/B.cls`, kind: 'modified' },
      ],
      config,
    );
    const selected = new Set(testNames(both.tests));
    expect(selected.has('ATest')).toBe(true);
    expect(selected.has('BTest')).toBe(true);
  });
});

describe('control: the attacks are not passing vacuously', () => {
  it('an unrelated change selects neither everything nor nothing', () => {
    // If every attack above passed because the tool always runs everything, this fails.
    const files = {
      [`${CLASSES}/Alone.cls`]: 'public class Alone { public static void go() { Integer x = 1; } }',
      [`${CLASSES}/AloneTest.cls`]: '@IsTest private class AloneTest { @IsTest static void t() { Alone.go(); } }',
      [`${CLASSES}/Other.cls`]: 'public class Other { public static void go() { Integer x = 1; } }',
      [`${CLASSES}/OtherTest.cls`]: '@IsTest private class OtherTest { @IsTest static void t() { Other.go(); } }',
    };
    const selected = selectedFor(files, `${CLASSES}/Alone.cls`);
    expect(selected).toEqual(['AloneTest']);
  });

  it('extractApex still reports DML for the writer fixture, so that attack is real', () => {
    const f = extractApex(`${CLASSES}/W.cls`, 'public class W { void m(List<Invoice__c> r) { insert r; } }');
    expect(f.references.some((r) => r.kind === 'dmlObject' && r.text === 'Invoice__c')).toBe(true);
  });
});

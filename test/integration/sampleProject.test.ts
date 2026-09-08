/**
 * Fixture-based integration test over `test/fixtures/sample-project`.
 *
 * The unit tests check rules in isolation; this one checks that a realistic project
 * produces a graph with the properties the design promises. It reads real files from disk
 * and touches no network and no org.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { resolve } from '../../src/resolve/resolver.js';
import {
  NodeFlags,
  hasFlag,
  makeNodeKey,
  type FileFacts,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from '../../src/types.js';

const ROOT = join(import.meta.dirname, '../fixtures/sample-project');
const DEFAULT_DIR = join(ROOT, 'force-app/main/default');

/** Every Apex source file in the fixture, as repo-relative paths. */
function apexFiles(): string[] {
  const out: string[] = [];
  for (const sub of ['classes', 'triggers']) {
    const dir = join(DEFAULT_DIR, sub);
    for (const name of readdirSync(dir)) {
      if (/\.(cls|trigger)$/.test(name)) out.push(join(dir, name));
    }
  }
  return out;
}

/** Metadata declarations the Apex extractor cannot produce; the XML extractor lands later. */
function metadataFacts(): FileFacts[] {
  const declare = (path: string, entries: Array<[string, NodeKind]>): FileFacts => ({
    path,
    extractor: 'metadata@0',
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
  });

  return [
    declare('force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml', [['Invoice__c', 'sobject']]),
    declare('force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml', [
      ['Invoice__c.Amount__c', 'field'],
    ]),
    declare('force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml', [
      ['Account.Rating__c', 'field'],
    ]),
  ];
}

const graph = (() => {
  const facts = apexFiles().map((absolute) =>
    extractApex(relative(ROOT, absolute).replace(/\\/g, '/'), readFileSync(absolute, 'utf8')),
  );
  return { facts, ...resolve([...facts, ...metadataFacts()]) };
})();

const node = (name: string): GraphNode | undefined => graph.nodes.find((n) => n.name === name);
const key = (kind: NodeKind, ns: string, name: string) => makeNodeKey(kind, ns, name);
const edgesFrom = (from: string): GraphEdge[] => graph.edges.filter((e) => e.from === from);
const targetsOf = (from: string): string[] => edgesFrom(from).map((e) => e.to);

describe('sample project — parsing', () => {
  it('parses every fixture file without a single failure', () => {
    // A parse failure here would mean the extractor cannot handle ordinary Apex, which
    // would quietly degrade every real project to a full test run.
    const failed = graph.facts.filter((f) => !f.parsedOk);
    expect(failed.map((f) => `${f.path}: ${f.diagnostics[0]?.message ?? ''}`)).toEqual([]);
  });

  it('finds every declared type', () => {
    expect(graph.facts.flatMap((f) => f.declarations.map((d) => d.name)).sort()).toEqual([
      'AccountHandler',
      'AccountTrigger',
      'Dispatcher',
      'DispatcherTest',
      'IHandler',
      'LegacyDataTest',
      'PricingService',
      'PricingServiceTest',
      'RefundApi',
      'ReportBuilder',
    ]);
  });
});

describe('sample project — test classes', () => {
  it('identifies the test classes and no others', () => {
    const tests = graph.nodes.filter((n) => hasFlag(n.flags, NodeFlags.IS_TEST)).map((n) => n.name);
    expect(tests.sort()).toEqual(['DispatcherTest', 'LegacyDataTest', 'PricingServiceTest']);
  });

  it('records test method names for reporting', () => {
    expect(node('PricingServiceTest')?.testMethods).toEqual(['ratesAnAccount']);
  });

  it('flags the SeeAllData test, which can never be safely skipped', () => {
    expect(hasFlag(node('LegacyDataTest')?.flags ?? 0, NodeFlags.SEE_ALL_DATA)).toBe(true);
    expect(hasFlag(node('PricingServiceTest')?.flags ?? 0, NodeFlags.SEE_ALL_DATA)).toBe(false);
  });
});

describe('sample project — entry points', () => {
  it('flags the REST resource and the trigger, whose callers are not in this repo', () => {
    expect(hasFlag(node('RefundApi')?.flags ?? 0, NodeFlags.ENTRY_POINT)).toBe(true);
    expect(hasFlag(node('AccountTrigger')?.flags ?? 0, NodeFlags.ENTRY_POINT)).toBe(true);
  });

  it('does not flag ordinary service classes', () => {
    expect(hasFlag(node('PricingService')?.flags ?? 0, NodeFlags.ENTRY_POINT)).toBe(false);
  });
});

describe('sample project — taint', () => {
  const taintOn = (name: string) => graph.taints.filter((t) => t.node === key('apex', 'c', name));

  it('taints the dynamic dispatcher in the apexType domain', () => {
    expect(taintOn('Dispatcher').map((t) => t.domain)).toContain('apexType');
  });

  it('taints the dynamic-SOQL builder in the sobjectAny domain', () => {
    expect(taintOn('ReportBuilder').map((t) => t.domain)).toContain('sobjectAny');
  });

  it('names the construct responsible, with a source location', () => {
    // Silent degradation is a bug: a user must be able to see why a class was widened.
    const taint = taintOn('Dispatcher')[0];
    expect(taint?.cause).toBe('Type.forName');
    expect(taint?.at.file).toMatch(/Dispatcher\.cls$/);
    expect(taint?.at.line).toBeGreaterThan(0);
  });

  it('leaves statically resolvable classes untainted', () => {
    expect(taintOn('PricingService')).toEqual([]);
    expect(taintOn('AccountHandler')).toEqual([]);
  });
});

describe('sample project — graph shape', () => {
  it('links the trigger to its object', () => {
    const edge = edgesFrom(key('trigger', 'c', 'AccountTrigger')).find((e) => e.kind === 'triggerOn');
    expect(edge?.to).toBe(key('sobject', 'standard', 'Account'));
  });

  it('links a test to the class it exercises', () => {
    expect(targetsOf(key('apex', 'c', 'PricingServiceTest'))).toContain(key('apex', 'c', 'PricingService'));
  });

  it('links a service to the custom field it reads', () => {
    expect(targetsOf(key('apex', 'c', 'PricingService'))).toContain(key('field', 'c', 'Invoice__c.Amount__c'));
  });

  it('widens the interface dependency to its implementor', () => {
    // Dispatcher references IHandler only. Without hierarchy widening, a change to
    // AccountHandler would not select DispatcherTest.
    expect(targetsOf(key('apex', 'c', 'Dispatcher'))).toContain(key('apex', 'c', 'AccountHandler'));
  });

  it('links the REST resource to its label and custom permission', () => {
    const bound = targetsOf(key('apex', 'c', 'RefundApi'));
    expect(bound).toContain(key('label', 'c', 'Refund_Denied'));
    expect(bound).toContain(key('custompermission', 'c', 'Approve_Refunds'));
  });

  it('owns every edge by exactly one real file, so incremental re-indexing is sound', () => {
    for (const edge of graph.edges) {
      expect(edge.ownerFile).toMatch(/\.(cls|trigger|xml)$/);
    }
  });

  it('produces no self-edges', () => {
    expect(graph.edges.filter((e) => e.from === e.to)).toEqual([]);
  });
});

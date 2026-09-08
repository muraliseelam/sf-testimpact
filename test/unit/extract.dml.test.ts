/**
 * DML statements and the dynamic-dispatch table (DESIGN.md 4.3, 6.2).
 *
 * Both were gaps between the design and the code:
 *
 * - The `dml` edge kind was declared in the type unions and handled by the resolver, but no
 *   extractor emitted a `dmlObject` reference. A class that receives records as a parameter
 *   and only writes them had no edge to the object it writes; the dependency survived only
 *   incidentally, via a `new X()` elsewhere or a SOQL query naming the same object.
 * - DESIGN.md 6.2 lists `Database.executeBatch` "with a dynamically obtained instance" as an
 *   `apexType` trigger. It was absent, so a batch class resolved at runtime escaped taint.
 */

import { describe, expect, it } from 'vitest';
import { dmlTargetType, extractApex } from '../../src/extract/apex.js';
import { resolve } from '../../src/resolve/resolver.js';
import type { FileFacts } from '../../src/types.js';

const PATH = 'force-app/main/default/classes/T.cls';
const facts = (body: string): FileFacts => extractApex(PATH, `public class T { ${body} }`);
const dml = (body: string): string[] =>
  facts(body)
    .references.filter((r) => r.kind === 'dmlObject')
    .map((r) => r.text)
    .sort();
const taints = (body: string): string[] => facts(body).taints.map((t) => `${t.domain}:${t.cause}`);

describe('dmlTargetType', () => {
  it.each([
    ['Account', 'Account'],
    ['List<Contact>', 'Contact'],
    ['Set<Lead>', 'Lead'],
    ['Map<Id,Opportunity>', 'Opportunity'],
    ['List<List<Account>>', 'Account'],
    ['Map<String,List<Case>>', 'Case'],
    ['Account[]', 'Account'],
    ['Invoice__c', 'Invoice__c'],
  ])('unwraps %s to %s', (declared, expected) => {
    // DML on a collection touches the ELEMENT type: `update contacts` depends on Contact,
    // not on List. Reporting `List` would be a dependency on a node that does not exist.
    expect(dmlTargetType(declared)).toBe(expected);
  });

  it('returns null for something that is not a nameable type', () => {
    expect(dmlTargetType('')).toBeNull();
    expect(dmlTargetType('List<>')).toBeNull();
  });
});

describe('DML statements emit an object dependency', () => {
  it.each([
    ['insert', 'void m(Account a) { insert a; }', ['Account']],
    ['update', 'void m(List<Contact> cs) { update cs; }', ['Contact']],
    ['delete', 'void m(Lead l) { delete l; }', ['Lead']],
    ['upsert', 'void m(Case c) { upsert c; }', ['Case']],
    ['undelete', 'void m(Case c) { undelete c; }', ['Case']],
  ])('%s', (_label, body, expected) => {
    expect(dml(body)).toEqual(expected);
  });

  it('merge names both operands, because both objects are touched', () => {
    expect(dml('void m(Account master, Account dupe) { merge master dupe; }')).toEqual([
      'Account',
      'Account',
    ]);
  });

  it('resolves a constructed operand', () => {
    expect(dml("void m() { insert new Opportunity(Name = 'x'); }")).toEqual(['Opportunity']);
  });

  it('resolves through a collection accessor such as map.values()', () => {
    expect(dml('void m(Map<Id, Lead> byId) { delete byId.values(); }')).toEqual(['Lead']);
  });

  it('covers the Database.* forms the design lists alongside the statements', () => {
    expect(dml('void m(List<Account> rows) { Database.insert(rows, false); }')).toEqual(['Account']);
    expect(dml('void m(List<Case> rows) { Database.update(rows, false); }')).toEqual(['Case']);
  });

  it('emits nothing when the operand type cannot be determined', () => {
    // Silence is correct here: inventing an object would be a wrong edge, and the safety
    // rule only licenses over-selection when we actually know a candidate.
    expect(dml('void m() { insert unknownThing; }')).toEqual([]);
  });

  it('is the ONLY thing carrying the dependency when nothing else names the object', () => {
    // The regression this closes. Before the visitor existed, this class had no edge to
    // Contact at all: no `new Contact()`, no SOQL, only a parameter it writes.
    const withDml = facts('public static void save(List<Contact> rows) { insert rows; }');
    expect(withDml.references.filter((r) => r.text === 'Contact')).not.toEqual([]);
  });
});

describe('DML references resolve to a dml edge', () => {
  it('produces a `dml` edge to the SObject node', () => {
    const graph = resolve([
      extractApex(PATH, 'public class T { void m(Account a) { insert a; } }'),
    ]);
    const edge = graph.edges.find((e) => e.kind === 'dml');
    expect(edge?.from).toBe('apex:c.t');
    expect(edge?.to).toBe('sobject:standard.account');
  });

  it('produces a dml edge for a custom object too', () => {
    const graph = resolve([
      extractApex(PATH, 'public class T { void m(List<Invoice__c> rows) { upsert rows; } }'),
    ]);
    expect(graph.edges.some((e) => e.kind === 'dml' && e.to === 'sobject:c.invoice__c')).toBe(true);
  });
});

describe('dynamic dispatch table matches DESIGN.md 6.2', () => {
  it('taints apexType on Database.executeBatch', () => {
    // Explicitly listed in the design's 6.2 table and previously missing.
    expect(taints('void m() { Database.executeBatch(new MyBatch()); }')).toContain(
      'apexType:Database.executeBatch',
    );
  });

  it('taints apexType on System.enqueueJob', () => {
    expect(taints('void m() { System.enqueueJob(new MyQueueable()); }')).toContain(
      'apexType:System.enqueueJob',
    );
  });

  it('taints apexType on System.schedule', () => {
    expect(taints("void m() { System.schedule('n', '0 0 1 * * ?', new MySched()); }")).toContain(
      'apexType:System.schedule',
    );
  });

  it('taints a Type.forName().newInstance() chain', () => {
    expect(taints("void m() { Object o = Type.forName('X').newInstance(); }").join()).toContain(
      'apexType',
    );
  });

  it('taints JSON.deserialize into a dynamically resolved type', () => {
    // The design lists `JSON.deserialize(s, Type.forName(...))`. The inner Type.forName is
    // its own dotted chain, so the composite is already covered — asserted rather than
    // assumed, because a separate blanket rule would over-taint every static deserialize.
    expect(taints("void m(String s) { Object o = JSON.deserialize(s, Type.forName('X')); }")).toContain(
      'apexType:Type.forName',
    );
  });

  it('does NOT taint a statically typed JSON.deserialize', () => {
    // The other half of the previous test. `JSON.deserialize(s, Account.class)` names its
    // target; tainting it would put every class that parses JSON into every change set.
    expect(taints('void m(String s) { Account a = (Account) JSON.deserialize(s, Account.class); }')).toEqual(
      [],
    );
  });

  it('does not taint ordinary DML', () => {
    expect(taints('void m(Account a) { insert a; }')).toEqual([]);
  });
});

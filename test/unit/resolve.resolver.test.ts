import { describe, expect, it } from 'vitest';
import { extractApex } from '../../src/extract/apex.js';
import { resolve } from '../../src/resolve/resolver.js';
import { SymbolTable } from '../../src/resolve/symbolTable.js';
import {
  NodeFlags,
  hasFlag,
  makeNodeKey,
  type DeclaredType,
  type FileFacts,
  type GraphEdge,
  type NodeKind,
} from '../../src/types.js';

/** Builds FileFacts for an Apex source string at a synthetic path. */
function apex(name: string, source: string): FileFacts {
  return extractApex(`force-app/main/default/classes/${name}.cls`, source);
}

/** Builds FileFacts for metadata the Apex extractor cannot produce (objects, fields, labels). */
function metadata(path: string, declarations: Array<Pick<DeclaredType, 'name' | 'kind'>>): FileFacts {
  return {
    path,
    extractor: 'test@1',
    parsedOk: true,
    declarations: declarations.map((d) => ({
      name: d.name,
      kind: d.kind,
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
  };
}

function edgeFrom(edges: readonly GraphEdge[], from: string): GraphEdge[] {
  return edges.filter((e) => e.from === from);
}

function targets(edges: readonly GraphEdge[], from: string): string[] {
  return edgeFrom(edges, from)
    .map((e) => e.to)
    .sort();
}

const key = (kind: NodeKind, ns: string, name: string) => makeNodeKey(kind, ns, name);

describe('resolve — basic binding', () => {
  it('binds a static call to the declaring class', () => {
    const { edges } = resolve([
      apex('Caller', 'public class Caller { void m() { ContactService.doThing(); } }'),
      apex('ContactService', 'public class ContactService { public static void doThing() {} }'),
    ]);
    expect(targets(edges, key('apex', 'c', 'Caller'))).toContain(key('apex', 'c', 'ContactService'));
  });

  it('is case-insensitive, as Apex is', () => {
    // Two nodes for one class is a silently missing dependency, so this is load-bearing.
    const { edges, nodes } = resolve([
      apex('Caller', 'public class Caller { void m() { CONTACTSERVICE.doThing(); } }'),
      apex('ContactService', 'public class ContactService {}'),
    ]);
    expect(nodes.filter((n) => n.name.toLowerCase() === 'contactservice')).toHaveLength(1);
    expect(targets(edges, key('apex', 'c', 'Caller'))).toContain(key('apex', 'c', 'ContactService'));
  });

  it('emits extends and implements edges', () => {
    const { edges } = resolve([
      apex('Child', 'public class Child extends Parent implements IThing {}'),
      apex('Parent', 'public virtual class Parent {}'),
      apex('IThing', 'public interface IThing {}'),
    ]);
    const kinds = edgeFrom(edges, key('apex', 'c', 'Child')).map((e) => e.kind);
    expect(kinds).toContain('extends');
    expect(kinds).toContain('implements');
  });

  it('does not emit a self-reference', () => {
    const { edges } = resolve([apex('Solo', 'public class Solo { void m() { Solo.go(); } }')]);
    expect(edgeFrom(edges, key('apex', 'c', 'Solo'))).toEqual([]);
  });

  it('namespace-qualifies node keys so 2GP is additive later', () => {
    const { nodes } = resolve([apex('Thing', 'public class Thing {}')], { namespace: 'acme' });
    expect(nodes.find((n) => n.name === 'Thing')?.key).toBe('apex:acme.thing');
  });
});

describe('resolve — ambiguity widens (DESIGN.md 5.2 rule 2)', () => {
  it('binds every prefix of a dotted name that names a real type', () => {
    // `Outer.Inner.run()` may mean either. Emitting both costs test minutes; picking one
    // and being wrong costs an incident.
    const { edges } = resolve([
      apex('Caller', 'public class Caller { void m() { Outer.Inner.run(); } }'),
      apex('Outer', 'public class Outer { public class Inner { public static void run() {} } }'),
    ]);
    const bound = targets(edges, key('apex', 'c', 'Caller'));
    expect(bound).toContain(key('apex', 'c', 'Outer'));
    expect(bound).toContain(key('apexInner', 'c', 'Outer.Inner'));
  });
});

describe('resolve — hierarchy widening (DESIGN.md 5.3)', () => {
  const files = [
    apex('IHandler', 'public interface IHandler { void run(); }'),
    apex('AccountHandler', 'public class AccountHandler implements IHandler { public void run() {} }'),
    apex('ContactHandler', 'public class ContactHandler implements IHandler { public void run() {} }'),
    apex('Dispatcher', 'public class Dispatcher { void go(IHandler h) { h.run(); } }'),
  ];

  it('makes a dependency on an interface a dependency on every implementor', () => {
    // Without this, changing AccountHandler would not select tests that exercise it through
    // IHandler — the classic false negative in every trigger framework.
    const { edges } = resolve(files);
    const bound = targets(edges, key('apex', 'c', 'Dispatcher'));
    expect(bound).toContain(key('apex', 'c', 'AccountHandler'));
    expect(bound).toContain(key('apex', 'c', 'ContactHandler'));
  });

  it('tags widened edges so their cost can be measured', () => {
    const { edges } = resolve(files);
    const widened = edges.find(
      (e) => e.from === key('apex', 'c', 'Dispatcher') && e.to === key('apex', 'c', 'AccountHandler'),
    );
    expect(widened?.provenance).toBe('widened');
  });

  it('widens through an abstract base class too', () => {
    const { edges } = resolve([
      apex('Base', 'public abstract class Base { public abstract void run(); }'),
      apex('Impl', 'public class Impl extends Base { public override void run() {} }'),
      apex('User2', 'public class User2 { void go(Base b) { b.run(); } }'),
    ]);
    expect(targets(edges, key('apex', 'c', 'User2'))).toContain(key('apex', 'c', 'Impl'));
  });

  it('widens transitively down a multi-level hierarchy', () => {
    const { edges } = resolve([
      apex('IBase', 'public interface IBase {}'),
      apex('Mid', 'public abstract class Mid implements IBase {}'),
      apex('Leaf', 'public class Leaf extends Mid {}'),
      apex('Caller', 'public class Caller { void go(IBase b) {} }'),
    ]);
    expect(targets(edges, key('apex', 'c', 'Caller'))).toContain(key('apex', 'c', 'Leaf'));
  });

  it('does not widen a concrete class', () => {
    const { edges } = resolve([
      apex('Concrete', 'public class Concrete {}'),
      apex('AlsoConcrete', 'public class AlsoConcrete extends Concrete {}'),
      apex('Caller', 'public class Caller { void go(Concrete c) {} }'),
    ]);
    expect(targets(edges, key('apex', 'c', 'Caller'))).not.toContain(key('apex', 'c', 'AlsoConcrete'));
  });
});

describe('resolve — SObjects and fields', () => {
  const objects = metadata('force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml', [
    { name: 'Invoice__c', kind: 'sobject' },
  ]);
  const fields = metadata('force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml', [
    { name: 'Account.Rating__c', kind: 'field' },
  ]);

  it('binds a SOQL FROM clause to the object node', () => {
    const { edges } = resolve([
      apex('Reader', 'public class Reader { void m() { List<Invoice__c> i = [SELECT Id FROM Invoice__c]; } }'),
      objects,
    ]);
    expect(targets(edges, key('apex', 'c', 'Reader'))).toContain(key('sobject', 'c', 'Invoice__c'));
  });

  it('binds a selected field to the declared field node', () => {
    const { edges } = resolve([
      apex('Reader', 'public class Reader { void m() { List<Account> a = [SELECT Rating__c FROM Account]; } }'),
      fields,
    ]);
    expect(targets(edges, key('apex', 'c', 'Reader'))).toContain(key('field', 'c', 'Account.Rating__c'));
  });

  it('puts standard objects in the standard namespace and custom ones in the project namespace', () => {
    const { nodes } = resolve([
      apex('Reader', 'public class Reader { void m() { List<Account> a = [SELECT Id FROM Account]; } }'),
      objects,
    ]);
    expect(nodes.find((n) => n.name === 'Account')?.namespace).toBe('standard');
    expect(nodes.find((n) => n.name === 'Invoice__c')?.namespace).toBe('c');
  });

  it('widens an unresolvable relationship field to every object declaring that field name', () => {
    // `SELECT Owner.Rating__c` — we have no relationship metadata, so we cannot know the
    // owning object. Widening over-selects; dropping it would miss a real dependency.
    const { edges } = resolve([
      apex('Reader', 'public class Reader { void m() { List<Account> a = [SELECT Owner.Rating__c FROM Account]; } }'),
      fields,
      metadata('force-app/main/default/objects/Lead/fields/Rating__c.field-meta.xml', [
        { name: 'Lead.Rating__c', kind: 'field' },
      ]),
    ]);
    const bound = targets(edges, key('apex', 'c', 'Reader'));
    expect(bound).toContain(key('field', 'c', 'Account.Rating__c'));
    expect(bound).toContain(key('field', 'c', 'Lead.Rating__c'));
  });

  it('binds a trigger to its object', () => {
    const { edges } = resolve([
      extractApex(
        'force-app/main/default/triggers/InvoiceTrigger.trigger',
        'trigger InvoiceTrigger on Invoice__c (before insert) { Integer x = 1; }',
      ),
      objects,
    ]);
    const edge = edgeFrom(edges, key('trigger', 'c', 'InvoiceTrigger'))[0];
    expect(edge?.kind).toBe('triggerOn');
    expect(edge?.to).toBe(key('sobject', 'c', 'Invoice__c'));
  });
});

describe('resolve — conditional taint (DESIGN.md 6.2)', () => {
  const source = 'public class T { void m(Account a, Map<String, String> lookup) { Object v = a.get(f); String s = lookup.get(k); } }';

  it('applies dynamic-field taint when the receiver is an SObject', () => {
    const { taints } = resolve([
      apex('T', source),
      metadata('objects/Account/Account.object-meta.xml', [{ name: 'Account', kind: 'sobject' }]),
    ]);
    expect(taints.some((t) => t.domain === 'fieldAny')).toBe(true);
  });

  it('does not taint an ordinary Map.get, which would taint nearly every class', () => {
    const { taints } = resolve([apex('OnlyMap', 'public class OnlyMap { void m(Map<String,String> lookup) { String s = lookup.get(k); } }')]);
    expect(taints.filter((t) => t.domain === 'fieldAny')).toEqual([]);
  });

  it('treats a custom API name as an SObject even with no metadata file present', () => {
    const { taints } = resolve([apex('T2', 'public class T2 { void m(Invoice__c inv) { Object v = inv.get(f); } }')]);
    expect(taints.some((t) => t.domain === 'fieldAny')).toBe(true);
  });
});

describe('resolve — unresolvable static names do not taint', () => {
  it('creates a namespaced external node for a managed-package symbol', () => {
    // A static name we cannot resolve is a fixed symbol outside this repo. It can never
    // appear in our diff, so it cannot cause a false negative — tainting here would make
    // every org with a managed package permanently fully tainted and the tool useless.
    // A *dynamic* reference is different: it can resolve to a repo symbol at runtime.
    const { nodes, taints, unresolved } = resolve([
      apex('User3', 'public class User3 { void m() { npsp.TDTM_Runnable.go(); } }'),
    ]);
    expect(taints).toEqual([]);
    expect(unresolved.some((u) => u.disposition === 'external-symbol')).toBe(true);
    const external = nodes.find((n) => n.namespace === 'npsp');
    expect(external?.name).toBe('TDTM_Runnable');
    expect(hasFlag(external?.flags ?? 0, NodeFlags.IS_EXTERNAL)).toBe(true);
  });

  it('does not mint a node for every platform primitive', () => {
    // `String`, `Integer` and friends are declared by no file, so they can never be in a
    // change set. A node each would add thousands of inert entries to every graph.
    const { nodes } = resolve([
      apex('Prims', 'public class Prims { void m() { String s = null; Integer i = 0; Datetime d = null; } }'),
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['Prims']);
  });

  it('still taints a genuinely dynamic reference', () => {
    const { taints } = resolve([apex('Dyn', "public class Dyn { void m() { Type t = Type.forName('X'); } }")]);
    expect(taints.some((t) => t.domain === 'apexType')).toBe(true);
  });
});

describe('resolve — parse failures', () => {
  it('keeps the declaration resolvable so other files still bind to it', () => {
    const { edges, nodes } = resolve([
      apex('Broken', 'public class Broken { void m( { } }'),
      apex('Caller', 'public class Caller { void m() { Broken.go(); } }'),
    ]);
    const broken = nodes.find((n) => n.name === 'Broken');
    expect(hasFlag(broken?.flags ?? 0, NodeFlags.PARSE_FAILED)).toBe(true);
    expect(targets(edges, key('apex', 'c', 'Caller'))).toContain(key('apex', 'c', 'Broken'));
  });

  it('taints the unparseable class in every domain', () => {
    const { taints } = resolve([apex('Broken', 'public class Broken { void m( { } }')]);
    expect(taints.map((t) => t.domain).sort()).toEqual(['apexType', 'fieldAny', 'sobjectAny']);
  });
});

describe('resolve — edge ownership', () => {
  it('attributes every edge to the file that emitted it', () => {
    // This invariant is what makes incremental re-indexing sound (DESIGN.md 4.4).
    const { edges } = resolve([
      apex('A', 'public class A { void m() { B.go(); } }'),
      apex('B', 'public class B { public static void go() {} }'),
    ]);
    for (const edge of edges) {
      expect(edge.ownerFile).toMatch(/\.cls$/);
    }
    expect(edgeFrom(edges, key('apex', 'c', 'A'))[0]?.ownerFile).toBe('force-app/main/default/classes/A.cls');
  });
});

describe('SymbolTable', () => {
  it('finds all transitive subtypes without looping on a malformed cycle', () => {
    const table = new SymbolTable([
      apex('A', 'public class A extends B {}'),
      apex('B', 'public class B extends A {}'),
    ]);
    expect(() => table.allSubtypes('A')).not.toThrow();
  });

  it('indexes fields by bare name across objects', () => {
    const table = new SymbolTable([
      metadata('a.xml', [{ name: 'Account.Rating__c', kind: 'field' }]),
      metadata('b.xml', [{ name: 'Lead.Rating__c', kind: 'field' }]),
    ]);
    expect(table.lookupFieldsByName('Rating__c')).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { APEX_EXTRACTOR_ID, extractApex } from '../../src/extract/apex.js';
import { NodeFlags, hasFlag, type FileFacts, type RawReference } from '../../src/types.js';

const CLS = 'force-app/main/default/classes/T.cls';

function extract(source: string, path = CLS): FileFacts {
  return extractApex(path, source);
}

/** Reference texts of a given kind, for concise assertions. */
function refs(facts: FileFacts, kind: RawReference['kind']): string[] {
  return facts.references.filter((r) => r.kind === kind).map((r) => r.text);
}

function decl(facts: FileFacts, name: string) {
  const found = facts.declarations.find((d) => d.name === name);
  if (found === undefined) {
    throw new Error(`no declaration ${name}; got ${facts.declarations.map((d) => d.name).join(', ')}`);
  }
  return found;
}

describe('extractApex — declarations', () => {
  it('records the extractor identity so a stale index is detectable', () => {
    expect(extract('public class T {}').extractor).toBe(APEX_EXTRACTOR_ID);
  });

  it('extracts a class with its superclass and interfaces', () => {
    const facts = extract('public class T extends Base implements I1, I2 {}');
    const t = decl(facts, 'T');
    expect(t.kind).toBe('apex');
    expect(t.superType).toBe('Base');
    expect(t.interfaces).toEqual(['I1', 'I2']);
  });

  it('qualifies inner types with their outer type', () => {
    const facts = extract('public class T { public class Inner { public class Deep {} } }');
    expect(facts.declarations.map((d) => d.name).sort()).toEqual(['T', 'T.Inner', 'T.Inner.Deep']);
    expect(decl(facts, 'T.Inner').kind).toBe('apexInner');
  });

  it('flags @IsTest classes and collects both test method spellings', () => {
    const facts = extract(`@IsTest
public class T {
  @IsTest static void modern() {}
  static testMethod void legacy() {}
  static void notATest() {}
}`);
    const t = decl(facts, 'T');
    expect(hasFlag(t.flags, NodeFlags.IS_TEST)).toBe(true);
    expect([...t.testMethods].sort()).toEqual(['legacy', 'modern']);
  });

  it('flags SeeAllData tests, which must always run', () => {
    const facts = extract('@IsTest(SeeAllData=true)\npublic class T { @IsTest static void a() {} }');
    expect(hasFlag(decl(facts, 'T').flags, NodeFlags.SEE_ALL_DATA)).toBe(true);
  });

  it('does not flag SeeAllData when it is false', () => {
    const facts = extract('@IsTest(SeeAllData=false)\npublic class T {}');
    expect(hasFlag(decl(facts, 'T').flags, NodeFlags.SEE_ALL_DATA)).toBe(false);
  });

  it('flags abstract classes and interfaces for hierarchy widening', () => {
    expect(hasFlag(decl(extract('public abstract class T {}'), 'T').flags, NodeFlags.IS_ABSTRACT)).toBe(true);
    expect(hasFlag(decl(extract('public interface T {}'), 'T').flags, NodeFlags.IS_INTERFACE)).toBe(true);
  });

  it.each([
    ['global class', 'global class T {}'],
    ['@RestResource', '@RestResource(urlMapping=\'/x\')\npublic class T {}'],
    ['Schedulable', 'public class T implements Schedulable {}'],
    ['Queueable', 'public class T implements Queueable {}'],
    ['@AuraEnabled method', 'public class T { @AuraEnabled public static void go() {} }'],
    ['@InvocableMethod', 'public class T { @InvocableMethod public static void go() {} }'],
    ['global method', 'public class T { global static void go() {} }'],
  ])('flags %s as an entry point', (_label, source) => {
    // Entry points have incomplete inbound edges: callers may not be in this repo at all.
    expect(hasFlag(decl(extract(source), 'T').flags, NodeFlags.ENTRY_POINT)).toBe(true);
  });

  it('does not flag an ordinary class as an entry point', () => {
    expect(hasFlag(decl(extract('public class T { void go() {} }'), 'T').flags, NodeFlags.ENTRY_POINT)).toBe(false);
  });

  it('extracts a trigger and the object it fires on', () => {
    const facts = extractApex(
      'force-app/main/default/triggers/AccountTrigger.trigger',
      'trigger AccountTrigger on Account (before insert, after update) { Integer x = 1; }',
    );
    const t = decl(facts, 'AccountTrigger');
    expect(t.kind).toBe('trigger');
    // A trigger is invoked by the platform, never by repository code.
    expect(hasFlag(t.flags, NodeFlags.ENTRY_POINT)).toBe(true);
    expect(refs(facts, 'triggerObject')).toEqual(['Account']);
  });
});

describe('extractApex — type references', () => {
  it('decomposes generic type arguments into separate references', () => {
    const facts = extract('public class T { void m() { Map<String, Account> m2 = new Map<String, Account>(); } }');
    const types = refs(facts, 'type');
    expect(types).toContain('Map');
    expect(types).toContain('String');
    expect(types).toContain('Account');
  });

  it('captures a static call on another class', () => {
    const facts = extract('public class T { void m() { ContactService.doThing(); } }');
    expect(refs(facts, 'type')).toContain('ContactService');
  });

  it('keeps the whole dotted chain so the resolver can bind every prefix', () => {
    // `Outer.Inner.run()` may mean Outer or Outer.Inner. Deciding here would be guessing.
    const facts = extract('public class T { void m() { Outer.Inner.run(); } }');
    expect(refs(facts, 'type')).toContain('Outer.Inner');
  });

  it('captures a dotted call nested in another call’s arguments', () => {
    // Regression: a nesting-depth guard treated an argument as a continuation of the outer
    // dotted chain and dropped it. `System.assertEquals(0, X.y())` is the shape of nearly
    // every Apex assertion, so this silently removed most edges out of most test classes.
    const facts = extract("public class T { void m() { System.assertEquals(0, PricingService.rate(a), 'msg'); } }");
    expect(refs(facts, 'type')).toContain('PricingService');
  });

  it('captures both sides of a binary expression', () => {
    const facts = extract('public class T { void m() { Boolean b = LeftService.get() == RightService.get(); } }');
    expect(refs(facts, 'type')).toEqual(expect.arrayContaining(['LeftService', 'RightService']));
  });

  it('does not emit the intermediate links of a single dotted chain', () => {
    const facts = extract('public class T { void m() { Outer.Inner.Deep.run(); } }');
    const types = refs(facts, 'type').filter((t) => t.startsWith('Outer'));
    expect(types).toEqual(['Outer.Inner.Deep']);
  });

  it('captures constructor references', () => {
    const facts = extract('public class T { void m() { Object o = new PricingService(); } }');
    expect(refs(facts, 'type')).toContain('PricingService');
  });
});

describe('extractApex — scope tracking', () => {
  it('does not treat a local variable as a type reference', () => {
    const facts = extract('public class T { void m() { Helper helper = new Helper(); helper.run(); } }');
    // The edge to Helper comes from the declaration, so dropping the call site loses nothing.
    expect(refs(facts, 'type')).toContain('Helper');
    expect(facts.unresolved.some((u) => u.disposition === 'ignored-local-variable')).toBe(true);
  });

  it('does not treat a method parameter as a type reference', () => {
    const facts = extract('public class T { void m(Helper helper) { helper.run(); } }');
    expect(facts.unresolved.some((u) => u.text === 'helper' && u.disposition === 'ignored-local-variable')).toBe(true);
  });

  it('does not treat a class field as a type reference', () => {
    const facts = extract('public class T { private Helper helper; void m() { helper.run(); } }');
    expect(facts.unresolved.some((u) => u.disposition === 'ignored-class-member')).toBe(true);
  });

  it('honours block scope: a local in a sibling block does not shadow a class name', () => {
    // The failure this guards against is a flat per-method name set, which would drop the
    // real `Foo.bar()` type reference because an unrelated block declares a variable `Foo`.
    const facts = extract(`public class T {
  void m() {
    Foo.bar();
    { String Foo = 'x'; System.debug(Foo); }
  }
}`);
    expect(refs(facts, 'type')).toContain('Foo');
  });

  it('scopes a for-loop variable to its loop', () => {
    const facts = extract(`public class T {
  void m() {
    for (Account acct : items) { acct.toString(); }
    Acct.staticThing();
  }
}`);
    // `acct` inside the loop is a variable; `Acct` afterwards is not the same binding.
    expect(refs(facts, 'type')).toContain('Acct');
  });

  it('scopes a catch variable to its clause', () => {
    const facts = extract('public class T { void m() { try { x(); } catch (DmlException e) { e.getMessage(); } } }');
    expect(refs(facts, 'type')).toContain('DmlException');
    expect(facts.unresolved.some((u) => u.text.startsWith('e'))).toBe(true);
  });
});

describe('extractApex — SOQL', () => {
  it('extracts the FROM object and simple selected fields', () => {
    const facts = extract("public class T { void m() { List<Account> a = [SELECT Id, Rating__c FROM Account]; } }");
    expect(refs(facts, 'soqlObject')).toContain('Account');
    expect(refs(facts, 'soqlField')).toContain('Account.Rating__c');
  });

  it('widens a relationship traversal to an unknown owning object', () => {
    // `Owner.Custom__c` lives on User, not Account, and we have no relationship metadata.
    // Marking it `*` lets the resolver widen; dropping it would be an under-approximation.
    const facts = extract("public class T { void m() { List<Account> a = [SELECT Owner.Custom__c FROM Account]; } }");
    expect(refs(facts, 'soqlField')).toContain('*.Custom__c');
  });

  it('handles multiple objects in a FROM clause', () => {
    const facts = extract("public class T { void m() { List<Account> a = [SELECT Id FROM Account, Contact]; } }");
    expect(refs(facts, 'soqlObject')).toEqual(expect.arrayContaining(['Account', 'Contact']));
  });

  it('ignores aggregate functions rather than inventing a field', () => {
    const facts = extract('public class T { void m() { Integer c = [SELECT COUNT() FROM Lead]; } }');
    expect(refs(facts, 'soqlObject')).toContain('Lead');
    expect(refs(facts, 'soqlField')).toEqual([]);
  });
});

describe('extractApex — taint detection', () => {
  const taintOf = (source: string) => extract(source).taints;

  it('taints apexType on Type.forName', () => {
    const taints = taintOf("public class T { void m() { Type t = Type.forName('Foo'); } }");
    expect(taints).toContainEqual(expect.objectContaining({ domain: 'apexType', cause: 'Type.forName' }));
  });

  it.each([
    ['Database.query', "Database.query('SELECT Id FROM Account');"],
    ['Database.countQuery', "Database.countQuery('SELECT COUNT() FROM Account');"],
    ['Database.getQueryLocator', "Database.getQueryLocator('SELECT Id FROM Account');"],
    ['Search.query', "Search.query('FIND ...');"],
    ['Schema.getGlobalDescribe', 'Schema.getGlobalDescribe();'],
  ])('taints sobjectAny on %s', (cause, statement) => {
    const taints = taintOf(`public class T { void m() { ${statement} } }`);
    expect(taints.some((t) => t.domain === 'sobjectAny' && t.cause === cause)).toBe(true);
  });

  it('taints fieldAny on getPopulatedFieldsAsMap', () => {
    const taints = taintOf('public class T { void m(Account a) { a.getPopulatedFieldsAsMap(); } }');
    expect(taints.some((t) => t.domain === 'fieldAny')).toBe(true);
  });

  it('makes dynamic field access conditional on the receiver being an SObject', () => {
    // `.get()` on a Map is not dynamic field access. Tainting every `.get()` would taint
    // nearly every class in an org and make the tool worthless, so the resolver decides.
    const taints = taintOf('public class T { void m(Account a) { Object v = a.get(fieldName); } }');
    const conditional = taints.find((t) => t.domain === 'fieldAny' && t.conditionalOnType !== undefined);
    expect(conditional?.conditionalOnType).toBe('Account');
  });

  it('taints apexType on Callable.call', () => {
    const taints = taintOf("public class T { void m(Callable c) { c.call('x', null); } }");
    expect(taints.some((t) => t.domain === 'apexType' && t.cause === 'Callable.call')).toBe(true);
  });

  it('taints sobjectAny on SOSL, whose RETURNING clause we do not model', () => {
    const taints = taintOf('public class T { void m() { List<List<SObject>> r = [FIND :q IN ALL FIELDS RETURNING Account(Id)]; } }');
    expect(taints.some((t) => t.domain === 'sobjectAny' && t.cause === 'SOSL FIND')).toBe(true);
  });

  it('does not taint an ordinary class', () => {
    expect(taintOf('public class T { void m() { ContactService.doThing(); } }')).toEqual([]);
  });
});

describe('extractApex — labels and custom permissions', () => {
  it('extracts System.Label references', () => {
    const facts = extract('public class T { void m() { String s = System.Label.Welcome_Banner; } }');
    expect(refs(facts, 'label')).toContain('Welcome_Banner');
  });

  it('extracts bare Label references', () => {
    const facts = extract('public class T { void m() { String s = Label.Welcome_Banner; } }');
    expect(refs(facts, 'label')).toContain('Welcome_Banner');
  });

  it('resolves a literal custom permission name', () => {
    const facts = extract("public class T { void m() { Boolean b = FeatureManagement.checkPermission('Approve_Refunds'); } }");
    expect(refs(facts, 'customPermission')).toContain('Approve_Refunds');
  });

  it('taints when the custom permission name is computed', () => {
    const facts = extract('public class T { void m(String p) { Boolean b = FeatureManagement.checkPermission(p); } }');
    expect(refs(facts, 'customPermission')).toEqual([]);
    expect(facts.taints.some((t) => t.cause.includes('checkPermission'))).toBe(true);
  });
});

describe('extractApex — parse failures', () => {
  const broken = () => extract('public class T { void m( { } }');

  it('never throws, and reports the failure', () => {
    const facts = broken();
    expect(facts.parsedOk).toBe(false);
    expect(facts.diagnostics.length).toBeGreaterThan(0);
    expect(facts.diagnostics[0]?.severity).toBe('error');
  });

  it('still declares the type, using the filename', () => {
    // Other files referencing this class must still resolve, or their edges vanish too.
    expect(broken().declarations.map((d) => d.name)).toEqual(['T']);
    expect(broken().declarations[0]?.flags).toBe(NodeFlags.PARSE_FAILED);
  });

  it('taints every domain, because we cannot see its outgoing references', () => {
    const domains = broken().taints.map((t) => t.domain).sort();
    expect(domains).toEqual(['apexType', 'fieldAny', 'sobjectAny']);
  });
});

describe('extractApex — case insensitivity', () => {
  it('preserves display casing on declarations', () => {
    // Identity is normalised downstream; the extractor must not pre-lowercase or the
    // reports become unreadable.
    expect(decl(extract('public class T { }'), 'T').name).toBe('T');
    const facts = extract('public class T { void m() { CONTACTSERVICE.doThing(); } }');
    expect(refs(facts, 'type')).toContain('CONTACTSERVICE');
  });
});

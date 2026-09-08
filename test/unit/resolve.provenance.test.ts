/**
 * References from non-Apex sources must become edges.
 *
 * Regression: the resolver built its source-node lookup with `lookupApexType` only, so a
 * reference emitted by a field, permission set, flow or UI extractor found no `from` node
 * and was dropped. There was no error and no diagnostic — the graph simply had no `xml` or
 * `regex` edges at all, and the ablation in DESIGN.md 11.2 reported those classes as
 * contributing nothing because they did not exist.
 *
 * The extractor tests passed throughout: they assert that the extractors emit *references*.
 * Nothing asserted those references survived resolution into *edges*. That is the gap these
 * tests close.
 */

import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/extract/index.js';
import { resolve } from '../../src/resolve/resolver.js';
import { type FileFacts, type Provenance } from '../../src/types.js';

const FILES: Array<[string, string]> = [
  [
    'force-app/main/default/objects/Account/Account.object-meta.xml',
    '<CustomObject><sharingModel>Private</sharingModel></CustomObject>',
  ],
  [
    'force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml',
    '<CustomField><fullName>Rating__c</fullName></CustomField>',
  ],
  [
    'force-app/main/default/objects/Account/fields/Total__c.field-meta.xml',
    '<CustomField><fullName>Total__c</fullName><formula>Rating__c * 2</formula></CustomField>',
  ],
  [
    'force-app/main/default/permissionsets/Ops.permissionset-meta.xml',
    `<PermissionSet><fullName>Ops</fullName>
       <classAccesses><apexClass>ApiService</apexClass></classAccesses>
       <fieldPermissions><field>Account.Rating__c</field></fieldPermissions>
     </PermissionSet>`,
  ],
  [
    'force-app/main/default/flows/Rate_Account.flow-meta.xml',
    `<Flow><fullName>Rate_Account</fullName>
       <actionCalls><actionType>apex</actionType><actionName>ApiService</actionName></actionCalls>
       <recordLookups><object>Account</object><queriedFields>Rating__c</queriedFields></recordLookups>
     </Flow>`,
  ],
  [
    'force-app/main/default/classes/ApiService.cls',
    'public class ApiService { public static Integer fetch() { return 7; } }',
  ],
  [
    'force-app/main/default/classes/PricingService.cls',
    'public class PricingService { public static Decimal rate() { List<Account> r = [SELECT Rating__c FROM Account]; return 0; } }',
  ],
];

const facts: FileFacts[] = FILES.map(([path, contents]) => {
  const extracted = extractFile(path, contents);
  if (extracted === null) throw new Error(`no extractor for ${path}`);
  return extracted;
});

const graph = resolve(facts);
const byProvenance = (p: Provenance) => graph.edges.filter((e) => e.provenance === p);
const has = (from: string, to: string): boolean =>
  graph.edges.some((e) => e.from === from && e.to === to);

describe('every provenance class produces real edges', () => {
  it.each<Provenance>(['ast', 'xml'])('emits at least one %s edge', (provenance) => {
    // Without this, the DESIGN.md 11.2 ablation silently measures an empty set and reports
    // "this class contributes nothing" for a class that was never resolved in the first place.
    expect(byProvenance(provenance).length).toBeGreaterThan(0);
  });

  it('does not lose a whole provenance class', () => {
    const present = new Set(graph.edges.map((e) => e.provenance));
    // `regex` is absent by design: the LWC/Aura extractor was deleted after the DESIGN.md
    // 11.2 ablation measured its contribution at exactly zero on a real repository.
    expect([...present].sort()).toEqual(['ast', 'xml']);
  });
});

describe('edges out of non-Apex source nodes', () => {
  it('links a field to its owning object', () => {
    expect(has('field:c.account.rating__c', 'sobject:standard.account')).toBe(true);
  });

  it('links a formula field to the field it reads', () => {
    expect(has('field:c.account.total__c', 'field:c.account.rating__c')).toBe(true);
  });

  it('links a permission set to the class and field it grants', () => {
    expect(has('permset:c.ops', 'apex:c.apiservice')).toBe(true);
    expect(has('permset:c.ops', 'field:c.account.rating__c')).toBe(true);
  });

  it('links a flow to the Apex it invokes and the data it touches', () => {
    expect(has('flow:c.rate_account', 'apex:c.apiservice')).toBe(true);
    expect(has('flow:c.rate_account', 'sobject:standard.account')).toBe(true);
    expect(has('flow:c.rate_account', 'field:c.account.rating__c')).toBe(true);
  });

  it('attributes each edge to the file that emitted it', () => {
    const permsetEdge = graph.edges.find((e) => e.from === 'permset:c.ops');
    expect(permsetEdge?.ownerFile).toBe('force-app/main/default/permissionsets/Ops.permissionset-meta.xml');
  });
});

describe('an object change reaches field consumers through the xml layer', () => {
  it('has the memberOf edge the reverse closure needs', () => {
    // Reversed during a query, `field -> object` is what makes a change to
    // Account.object-meta.xml reach Rating__c and therefore PricingService. Without the xml
    // edges this path does not exist and an object-level change selects nothing.
    expect(has('field:c.account.rating__c', 'sobject:standard.account')).toBe(true);
    expect(has('apex:c.pricingservice', 'field:c.account.rating__c')).toBe(true);
  });
});

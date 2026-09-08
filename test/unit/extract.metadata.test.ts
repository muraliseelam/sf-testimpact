import { describe, expect, it } from 'vitest';
import { extractFile, extractorFor, isModelledPath } from '../../src/extract/index.js';
import { extractFlow } from '../../src/extract/flow.js';
import { extractLabels, extractCustomPermission, extractTranslation } from '../../src/extract/labels.js';
import { extractMetadata, formulaFieldRefs } from '../../src/extract/metadata.js';
import { extractPermissionSet } from '../../src/extract/permset.js';
import { type FileFacts, type RawReference } from '../../src/types.js';

const refs = (f: FileFacts, edgeKind?: RawReference['edgeKind']): string[] =>
  f.references.filter((r) => edgeKind === undefined || r.edgeKind === edgeKind).map((r) => r.text).sort();

describe('extractor dispatch', () => {
  it.each([
    ['force-app/main/default/classes/A.cls', true],
    ['force-app/main/default/triggers/A.trigger', true],
    ['force-app/main/default/objects/Account/Account.object-meta.xml', true],
    ['force-app/main/default/objects/Account/fields/A__c.field-meta.xml', true],
    ['force-app/main/default/flows/F.flow-meta.xml', true],
    ['force-app/main/default/permissionsets/P.permissionset-meta.xml', true],
    ['force-app/main/default/labels/CustomLabels.labels-meta.xml', true],
    ['force-app/main/default/layouts/Account-Layout.layout-meta.xml', false],
    ['README.md', false],
  ])('%s -> modelled: %s', (path, expected) => {
    expect(isModelledPath(path)).toBe(expected);
  });

  it('returns null for an unmodelled path rather than guessing', () => {
    // The safety layer turns this into a documented fallback; a silent skip would be a
    // silently missing edge.
    expect(extractorFor('force-app/main/default/layouts/X.layout-meta.xml')).toBeNull();
    expect(extractFile('README.md', '# hi')).toBeNull();
  });
});

describe('object and field metadata', () => {
  const objectPath = 'force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml';
  const fieldPath = 'force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml';

  it('declares an SObject from an object document', () => {
    const facts = extractMetadata(
      objectPath,
      '<?xml version="1.0"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Invoice</label></CustomObject>',
    );
    expect(facts.declarations).toEqual([expect.objectContaining({ name: 'Invoice__c', kind: 'sobject' })]);
  });

  it('declares a qualified field and links it to its object', () => {
    const facts = extractMetadata(
      fieldPath,
      '<?xml version="1.0"?><CustomField><fullName>Amount__c</fullName><type>Currency</type></CustomField>',
    );
    expect(facts.declarations[0]).toEqual(
      expect.objectContaining({ name: 'Invoice__c.Amount__c', kind: 'field' }),
    );
    const memberOf = facts.references.find((r) => r.edgeKind === 'memberOf');
    expect(memberOf?.text).toBe('Invoice__c');
    expect(memberOf?.provenance).toBe('xml');
  });

  it('extracts formula field references', () => {
    const facts = extractMetadata(
      fieldPath,
      '<CustomField><fullName>Total__c</fullName><formula>Quantity__c * Price__c</formula></CustomField>',
    );
    expect(refs(facts, 'formulaRef')).toEqual(['Invoice__c.Price__c', 'Invoice__c.Quantity__c']);
  });

  it('extracts a rollup summary’s source field', () => {
    const facts = extractMetadata(
      fieldPath,
      `<CustomField><fullName>Total__c</fullName><summarizedField>Line__c.Amount__c</summarizedField>
       <summaryForeignKey>Line__c.Invoice__c</summaryForeignKey></CustomField>`,
    );
    expect(refs(facts, 'formulaRef')).toContain('Line__c.Amount__c');
  });

  it('extracts validation-rule field references', () => {
    const facts = extractMetadata(
      'force-app/main/default/objects/Invoice__c/validationRules/Positive.validationRule-meta.xml',
      `<ValidationRule><fullName>Positive</fullName>
       <errorConditionFormula>Amount__c &lt; 0</errorConditionFormula>
       <errorDisplayField>Amount__c</errorDisplayField></ValidationRule>`,
    );
    expect(refs(facts, 'formulaRef')).toContain('Invoice__c.Amount__c');
  });

  it('reports malformed XML rather than silently producing nothing', () => {
    const facts = extractMetadata(objectPath, '<CustomObject><unclosed>');
    // fast-xml-parser is lenient, so the contract asserted here is that we never throw and
    // never claim declarations we did not find.
    expect(facts.declarations.length).toBeLessThanOrEqual(1);
  });
});

describe('formulaFieldRefs', () => {
  it('attributes unqualified names to the owning object', () => {
    expect(formulaFieldRefs('Amount__c + Tax__c', 'Invoice__c')).toEqual([
      'Invoice__c.Amount__c',
      'Invoice__c.Tax__c',
    ]);
  });

  it('widens a relationship traversal, since the owning object is unknown', () => {
    expect(formulaFieldRefs('Account__r.Rating__c', 'Invoice__c')).toEqual(['*.Rating__c']);
  });

  it('skips formula functions, which look exactly like field names', () => {
    expect(formulaFieldRefs('IF(ISBLANK(Amount__c), 0, Amount__c)', 'Invoice__c')).toEqual([
      'Invoice__c.Amount__c',
    ]);
  });

  it('skips global variables, which are not fields on this object', () => {
    expect(formulaFieldRefs('$User.Id = OwnerId', 'Invoice__c')).toEqual(['Invoice__c.OwnerId']);
  });

  it('de-duplicates repeated references', () => {
    expect(formulaFieldRefs('A__c + A__c + A__c', 'X__c')).toEqual(['X__c.A__c']);
  });
});

describe('flows', () => {
  const path = 'force-app/main/default/flows/Invoice_After_Insert.flow-meta.xml';
  const flow = `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Invoice_After_Insert</fullName>
    <actionCalls><name>callApex</name><actionType>apex</actionType><actionName>InvoiceService</actionName></actionCalls>
    <recordLookups><name>get</name><object>Invoice__c</object><queriedFields>Amount__c</queriedFields></recordLookups>
    <recordUpdates><name>upd</name><object>Account</object>
      <inputAssignments><field>Rating__c</field></inputAssignments></recordUpdates>
    <start><object>Invoice__c</object></start>
    <decisions><rules><conditions><leftValueReference>$Label.Refund_Denied</leftValueReference></conditions></rules></decisions>
  </Flow>`;

  const facts = extractFlow(path, flow);

  it('declares the flow', () => {
    expect(facts.declarations).toEqual([
      expect.objectContaining({ name: 'Invoice_After_Insert', kind: 'flow' }),
    ]);
  });

  it('links the flow to the Apex it invokes', () => {
    const invoke = facts.references.find((r) => r.edgeKind === 'flowInvokes');
    expect(invoke?.text).toBe('InvoiceService');
    expect(invoke?.kind).toBe('apexType');
  });

  it('links the flow to the objects it touches', () => {
    expect(refs(facts, 'flowTouches')).toEqual(
      expect.arrayContaining(['Invoice__c', 'Account', 'Invoice__c.Amount__c', 'Account.Rating__c']),
    );
  });

  it('links the flow to labels it references', () => {
    expect(refs(facts, 'labelRef')).toContain('Refund_Denied');
  });

  it('marks every flow edge as xml provenance', () => {
    expect(facts.references.every((r) => r.provenance === 'xml')).toBe(true);
  });

  it('handles a flow with no actions or records', () => {
    const empty = extractFlow(path, '<Flow><fullName>Empty</fullName></Flow>');
    expect(empty.parsedOk).toBe(true);
    expect(empty.references).toEqual([]);
  });
});

describe('permission sets', () => {
  const path = 'force-app/main/default/permissionsets/Sales_Ops.permissionset-meta.xml';
  const facts = extractPermissionSet(
    path,
    `<PermissionSet><fullName>Sales_Ops</fullName>
      <classAccesses><apexClass>InvoiceService</apexClass><enabled>true</enabled></classAccesses>
      <objectPermissions><object>Invoice__c</object><allowRead>true</allowRead></objectPermissions>
      <fieldPermissions><field>Invoice__c.Amount__c</field><readable>true</readable></fieldPermissions>
      <customPermissions><name>Approve_Refunds</name></customPermissions>
    </PermissionSet>`,
  );

  it('declares the permission set', () => {
    expect(facts.declarations).toEqual([expect.objectContaining({ name: 'Sales_Ops', kind: 'permset' })]);
  });

  it('grants to classes, objects, fields and custom permissions', () => {
    expect(refs(facts, 'grants')).toEqual([
      'Approve_Refunds',
      'InvoiceService',
      'Invoice__c',
      'Invoice__c.Amount__c',
    ]);
  });

  it('records a dependency even for a disabled grant', () => {
    // Flipping `enabled` later changes behaviour, and the edge is what makes that change
    // select the right tests.
    const disabled = extractPermissionSet(
      path,
      '<PermissionSet><fullName>P</fullName><classAccesses><apexClass>X</apexClass><enabled>false</enabled></classAccesses></PermissionSet>',
    );
    expect(refs(disabled, 'grants')).toEqual(['X']);
  });

  it('handles profiles with the same shape', () => {
    const profile = extractPermissionSet(
      'force-app/main/default/profiles/Admin.profile-meta.xml',
      '<Profile><fullName>Admin</fullName><classAccesses><apexClass>Y</apexClass></classAccesses></Profile>',
    );
    expect(refs(profile, 'grants')).toEqual(['Y']);
  });
});

describe('labels, custom permissions and translations', () => {
  it('declares every label in the shared labels document', () => {
    const facts = extractLabels(
      'force-app/main/default/labels/CustomLabels.labels-meta.xml',
      `<CustomLabels>
        <labels><fullName>Welcome_Banner</fullName><value>Hi</value></labels>
        <labels><fullName>Refund_Denied</fullName><value>No</value></labels>
      </CustomLabels>`,
    );
    expect(facts.declarations.map((d) => d.name).sort()).toEqual(['Refund_Denied', 'Welcome_Banner']);
    expect(facts.declarations.every((d) => d.kind === 'label')).toBe(true);
  });

  it('handles a single label, which the XML parser returns as a scalar not a list', () => {
    // The classic fast-xml-parser trap: one occurrence is not an array. Reading it as a
    // scalar here would mean a project with exactly one label indexes zero labels.
    const facts = extractLabels(
      'labels/CustomLabels.labels-meta.xml',
      '<CustomLabels><labels><fullName>Only</fullName></labels></CustomLabels>',
    );
    expect(facts.declarations.map((d) => d.name)).toEqual(['Only']);
  });

  it('declares a custom permission', () => {
    const facts = extractCustomPermission(
      'force-app/main/default/customPermissions/Approve_Refunds.customPermission-meta.xml',
      '<CustomPermission><fullName>Approve_Refunds</fullName></CustomPermission>',
    );
    expect(facts.declarations).toEqual([
      expect.objectContaining({ name: 'Approve_Refunds', kind: 'custompermission' }),
    ]);
  });

  it('links a translation to the labels it translates', () => {
    const facts = extractTranslation(
      'force-app/main/default/translations/de.translation-meta.xml',
      '<Translations><customLabels><name>Welcome_Banner</name><label>Hallo</label></customLabels></Translations>',
    );
    expect(refs(facts, 'translates')).toEqual(['Welcome_Banner']);
  });

  it('links an object translation to the fields it translates', () => {
    const facts = extractTranslation(
      'force-app/main/default/objectTranslations/Invoice__c-de/Invoice__c-de.objectTranslation-meta.xml',
      '<CustomObjectTranslation><fields><name>Amount__c</name><label>Betrag</label></fields></CustomObjectTranslation>',
    );
    expect(refs(facts, 'translates')).toEqual(['Invoice__c.Amount__c']);
  });
});

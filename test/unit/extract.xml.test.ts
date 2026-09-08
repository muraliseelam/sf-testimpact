/**
 * XML accessor helpers.
 *
 * `fast-xml-parser` returns a scalar, an array, or nothing for the same element depending
 * on how many times it appears. Every one of those shapes is exercised here, because a
 * single-element list read as a scalar is how an extractor quietly stops emitting edges.
 */

import { describe, expect, it } from 'vitest';
import { apiNameFromPath, many, objectFromPath, parseXml, root, text, texts } from '../../src/extract/xml.js';
import { extractFlow } from '../../src/extract/flow.js';
import { extractPermissionSet } from '../../src/extract/permset.js';
import { extractCustomPermission, extractLabels, extractTranslation } from '../../src/extract/labels.js';
import { extractMetadata } from '../../src/extract/metadata.js';

describe('many', () => {
  it('returns a one-element array for a single occurrence', () => {
    expect(many(root(parseXml('<r><a><b>1</b></a></r>')), 'a')).toHaveLength(1);
  });

  it('returns every occurrence for a repeated element', () => {
    expect(many(root(parseXml('<r><a><b>1</b></a><a><b>2</b></a></r>')), 'a')).toHaveLength(2);
  });

  it('returns an empty array when the element is absent', () => {
    expect(many(root(parseXml('<r/>')), 'missing')).toEqual([]);
  });

  it('returns an empty array for a non-record input', () => {
    expect(many(null, 'a')).toEqual([]);
    expect(many('string', 'a')).toEqual([]);
  });

  it('filters out non-record entries', () => {
    expect(many(root(parseXml('<r><a>text</a></r>')), 'a')).toEqual([]);
  });
});

describe('text', () => {
  it('reads a scalar child', () => {
    expect(text(root(parseXml('<r><a>hello</a></r>')), 'a')).toBe('hello');
  });

  it('returns null for an absent child', () => {
    expect(text(root(parseXml('<r/>')), 'a')).toBeNull();
  });

  it('returns null for an empty element rather than an empty string', () => {
    expect(text(root(parseXml('<r><a></a></r>')), 'a')).toBeNull();
  });

  it('reads the first entry when the element repeats', () => {
    expect(text(root(parseXml('<r><a>one</a><a>two</a></r>')), 'a')).toBe('one');
  });

  it('returns null for a non-record input', () => {
    expect(text(undefined, 'a')).toBeNull();
  });

  it('returns null when the child is an element rather than text', () => {
    expect(text(root(parseXml('<r><a><b/></a></r>')), 'a')).toBeNull();
  });
});

describe('texts', () => {
  it('reads a single occurrence as a one-element list', () => {
    expect(texts(root(parseXml('<r><a>one</a></r>')), 'a')).toEqual(['one']);
  });

  it('reads every occurrence', () => {
    expect(texts(root(parseXml('<r><a>one</a><a>two</a></r>')), 'a')).toEqual(['one', 'two']);
  });

  it('returns an empty list for an absent element or a non-record', () => {
    expect(texts(root(parseXml('<r/>')), 'a')).toEqual([]);
    expect(texts(null, 'a')).toEqual([]);
  });

  it('drops non-string entries', () => {
    expect(texts(root(parseXml('<r><a>one</a><a><b/></a></r>')), 'a')).toEqual(['one']);
  });
});

describe('root', () => {
  it('finds the single root element past the XML declaration', () => {
    expect(root(parseXml('<?xml version="1.0"?><CustomObject><a>1</a></CustomObject>'))).toEqual({ a: '1' });
  });

  it('returns an empty object for a document with no element root', () => {
    expect(root(parseXml(''))).toEqual({});
  });
});

describe('path helpers', () => {
  it.each([
    ['force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml', 'Rating__c'],
    ['force-app/main/default/flows/My_Flow.flow-meta.xml', 'My_Flow'],
    ['a\\b\\Windows_Path.permissionset-meta.xml', 'Windows_Path'],
  ])('apiNameFromPath(%s) -> %s', (path, expected) => {
    expect(apiNameFromPath(path)).toBe(expected);
  });

  it('finds the owning object folder', () => {
    expect(objectFromPath('force-app/main/default/objects/Invoice__c/fields/A__c.field-meta.xml')).toBe(
      'Invoice__c',
    );
    expect(objectFromPath('force-app/main/default/classes/A.cls')).toBeNull();
  });
});

describe('extractor edge cases', () => {
  it('a flow with no elements at all yields just its declaration', () => {
    const facts = extractFlow('flows/Empty.flow-meta.xml', '<Flow/>');
    expect(facts.declarations).toHaveLength(1);
    expect(facts.references).toEqual([]);
  });

  it('a flow action that is not Apex produces no invoke edge', () => {
    const facts = extractFlow(
      'flows/F.flow-meta.xml',
      '<Flow><fullName>F</fullName><actionCalls><actionType>emailSimple</actionType><actionName>Send</actionName></actionCalls></Flow>',
    );
    expect(facts.references.filter((r) => r.edgeKind === 'flowInvokes')).toEqual([]);
  });

  it('a flow record element with no object widens its fields', () => {
    const facts = extractFlow(
      'flows/F.flow-meta.xml',
      '<Flow><fullName>F</fullName><recordUpdates><inputAssignments><field>Rating__c</field></inputAssignments></recordUpdates></Flow>',
    );
    expect(facts.references.map((r) => r.text)).toContain('*.Rating__c');
  });

  it('a permission set with no grants yields just its declaration', () => {
    const facts = extractPermissionSet('permissionsets/P.permissionset-meta.xml', '<PermissionSet/>');
    expect(facts.references).toEqual([]);
    expect(facts.declarations).toHaveLength(1);
  });

  it('a labels document with no labels yields no declarations', () => {
    expect(extractLabels('labels/CustomLabels.labels-meta.xml', '<CustomLabels/>').declarations).toEqual([]);
  });

  it('a custom permission falls back to its filename when fullName is absent', () => {
    const facts = extractCustomPermission(
      'customPermissions/Approve.customPermission-meta.xml',
      '<CustomPermission/>',
    );
    expect(facts.declarations[0]?.name).toBe('Approve');
  });

  it('a translation with nothing to translate yields no references', () => {
    expect(extractTranslation('translations/de.translation-meta.xml', '<Translations/>').references).toEqual(
      [],
    );
  });

  it('a field document with no formula yields only its memberOf edge', () => {
    const facts = extractMetadata(
      'objects/A__c/fields/B__c.field-meta.xml',
      '<CustomField><fullName>B__c</fullName></CustomField>',
    );
    expect(facts.references).toHaveLength(1);
    expect(facts.references[0]?.edgeKind).toBe('memberOf');
  });

  it('a field outside an objects folder still resolves an owning name', () => {
    const facts = extractMetadata('somewhere/B__c.field-meta.xml', '<CustomField><fullName>B__c</fullName></CustomField>');
    expect(facts.declarations[0]?.name).toBe('Unknown.B__c');
  });

});

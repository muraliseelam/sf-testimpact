/**
 * Flows (DESIGN.md 4.3).
 *
 * A Flow is a first-class caller of Apex: `flowInvokes` edges mean that changing an
 * `@InvocableMethod` class selects the tests of anything the Flow touches, and that
 * changing the Flow selects the tests of the Apex it calls.
 */

import { type EdgeKind, type FileFacts, type RawReference, type SourceLoc } from '../types.js';
import { emptyFacts, failedFacts } from './facts.js';
import { apiNameFromPath, many, parseXml, root, text, texts, type XmlNode } from './xml.js';

export const FLOW_EXTRACTOR_ID = 'flow@1';

export function isFlowPath(path: string): boolean {
  return /\.flow-meta\.xml$/i.test(path);
}

/** Elements that name an SObject directly. */
const RECORD_ELEMENTS = [
  'recordLookups',
  'recordCreates',
  'recordUpdates',
  'recordDeletes',
  'recordRollbacks',
] as const;

export function extractFlow(path: string, contents: string): FileFacts {
  const base = emptyFacts(path, FLOW_EXTRACTOR_ID);
  const loc: SourceLoc = { file: path, line: 1, column: 0 };

  let doc: XmlNode;
  try {
    doc = root(parseXml(contents));
  } catch (cause) {
    return failedFacts(
      path,
      FLOW_EXTRACTOR_ID,
      `Could not parse Flow XML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const name = text(doc, 'fullName') ?? apiNameFromPath(path);
  const references: RawReference[] = [];
  const ref = (target: string, kind: RawReference['kind'], edgeKind: EdgeKind): void => {
    if (target.length === 0) return;
    references.push({ from: name, text: target, kind, edgeKind, at: loc, provenance: 'xml' });
  };

  // Apex invoked through an action call.
  for (const action of many(doc, 'actionCalls')) {
    const type = text(action, 'actionType');
    const actionName = text(action, 'actionName');
    if (actionName === null) continue;
    if (type === 'apex' || type === 'apexInvocableAction') ref(actionName, 'apexType', 'flowInvokes');
  }

  // Apex referenced directly, and Apex-defined data types used by variables.
  for (const key of ['apexClass', 'apexName']) {
    for (const value of texts(doc, key)) ref(value, 'apexType', 'flowInvokes');
  }
  for (const variable of many(doc, 'variables')) {
    const apexClass = text(variable, 'apexClass');
    if (apexClass !== null) ref(apexClass, 'apexType', 'flowInvokes');
  }

  // The object a record-triggered flow fires on.
  for (const start of many(doc, 'start')) {
    const object = text(start, 'object');
    if (object !== null) ref(object, 'sobject', 'flowTouches');
    collectFieldRefs(start, object, ref);
  }
  const startObject = text(doc, 'start');
  if (startObject !== null) ref(startObject, 'sobject', 'flowTouches');

  // Objects and fields touched by record elements.
  for (const elementName of RECORD_ELEMENTS) {
    for (const element of many(doc, elementName)) {
      const object = text(element, 'object');
      if (object !== null) ref(object, 'sobject', 'flowTouches');
      collectFieldRefs(element, object, ref);
    }
  }

  // Custom labels referenced as `$Label.Name` anywhere in the document.
  for (const label of contents.match(/\$Label\.([A-Za-z_][A-Za-z0-9_]*)/g) ?? []) {
    ref(label.slice('$Label.'.length), 'label', 'labelRef');
  }

  return {
    ...base,
    declarations: [
      {
        name,
        kind: 'flow',
        flags: 0,
        superType: null,
        interfaces: [],
        testMethods: [],
        entryPoints: [],
        loc,
      },
    ],
    references,
  };
}

type RefFn = (target: string, kind: RawReference['kind'], edgeKind: EdgeKind) => void;

/**
 * Fields named by a record element.
 *
 * When the element's object is unknown the field is widened with `*`, exactly as an
 * unresolvable SOQL relationship traversal is: the resolver then binds it to every object
 * declaring a field of that name rather than dropping it.
 */
function collectFieldRefs(element: XmlNode, object: string | null, ref: RefFn): void {
  const owner = object ?? '*';
  const add = (field: string): void => {
    if (field.length === 0) return;
    ref(field.includes('.') ? field : `${owner}.${field}`, 'field', 'flowTouches');
  };

  for (const field of texts(element, 'queriedFields')) add(field);
  for (const field of texts(element, 'field')) add(field);
  for (const assignment of many(element, 'inputAssignments')) {
    const field = text(assignment, 'field');
    if (field !== null) add(field);
  }
  for (const assignment of many(element, 'outputAssignments')) {
    const field = text(assignment, 'field');
    if (field !== null) add(field);
  }
  for (const filter of many(element, 'filters')) {
    const field = text(filter, 'field');
    if (field !== null) add(field);
  }
  for (const condition of many(element, 'filterLogic')) {
    const field = text(condition, 'field');
    if (field !== null) add(field);
  }
}

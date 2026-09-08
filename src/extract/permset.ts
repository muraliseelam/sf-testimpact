/**
 * Permission sets and profiles (DESIGN.md 4.3).
 *
 * Field-level security and object permissions change what a test's running user can see, so
 * a permission change genuinely affects test outcomes. These edges are why item 8 in
 * DESIGN.md §12 is mitigated rather than a known gap.
 */

import { type FileFacts, type RawReference, type SourceLoc } from '../types.js';
import { emptyFacts, failedFacts } from './facts.js';
import { apiNameFromPath, many, parseXml, root, text, type XmlNode } from './xml.js';

export const PERMSET_EXTRACTOR_ID = 'permset@1';

export function isPermissionPath(path: string): boolean {
  return /\.(permissionset|profile|permissionsetgroup)-meta\.xml$/i.test(path);
}

export function extractPermissionSet(path: string, contents: string): FileFacts {
  const base = emptyFacts(path, PERMSET_EXTRACTOR_ID);
  const loc: SourceLoc = { file: path, line: 1, column: 0 };

  let doc: XmlNode;
  try {
    doc = root(parseXml(contents));
  } catch (cause) {
    return failedFacts(
      path,
      PERMSET_EXTRACTOR_ID,
      `Could not parse permission XML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const name = text(doc, 'fullName') ?? apiNameFromPath(path);
  const references: RawReference[] = [];
  const grant = (target: string | null, kind: RawReference['kind']): void => {
    if (target === null || target.length === 0) return;
    references.push({ from: name, text: target, kind, edgeKind: 'grants', at: loc, provenance: 'xml' });
  };

  for (const access of many(doc, 'classAccesses')) {
    // `enabled: false` still creates a dependency: flipping it later changes behaviour, and
    // the edge is what makes that change select the right tests.
    grant(text(access, 'apexClass'), 'apexType');
  }
  for (const permission of many(doc, 'objectPermissions')) {
    grant(text(permission, 'object'), 'sobject');
  }
  for (const permission of many(doc, 'fieldPermissions')) {
    grant(text(permission, 'field'), 'field');
  }
  for (const permission of many(doc, 'customPermissions')) {
    grant(text(permission, 'name'), 'customPermission');
  }
  for (const access of many(doc, 'pageAccesses')) {
    grant(text(access, 'apexPage'), 'apexType');
  }

  return {
    ...base,
    declarations: [
      {
        name,
        kind: 'permset',
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

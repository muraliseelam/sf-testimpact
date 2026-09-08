/**
 * Custom labels, custom permissions and translations (DESIGN.md 5.6).
 *
 * Note the shape of the labels document: **one file declares every label in the project**.
 * The ownership invariant still holds (each node has exactly one owning file), but the
 * consequence is real and is recorded as DESIGN.md §12 item 11 — touching any label
 * invalidates all of them, so a one-label change impacts every label consumer.
 */

import { type FileFacts, type RawReference, type SourceLoc } from '../types.js';
import { emptyFacts, failedFacts } from './facts.js';
import { apiNameFromPath, many, parseXml, root, text, type XmlNode } from './xml.js';

export const LABELS_EXTRACTOR_ID = 'labels@1';

export function isLabelsPath(path: string): boolean {
  return /\.labels-meta\.xml$/i.test(path);
}

export function isCustomPermissionPath(path: string): boolean {
  return /\.customPermission-meta\.xml$/i.test(path);
}

export function isTranslationPath(path: string): boolean {
  return /\.(translation|objectTranslation)-meta\.xml$/i.test(path);
}

function parseOrFail(path: string, contents: string): XmlNode | FileFacts {
  try {
    return root(parseXml(contents));
  } catch (cause) {
    return failedFacts(
      path,
      LABELS_EXTRACTOR_ID,
      `Could not parse XML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function isFacts(value: XmlNode | FileFacts): value is FileFacts {
  return 'extractor' in value && 'declarations' in value;
}

/** `labels/CustomLabels.labels-meta.xml` — declares every label in the project. */
export function extractLabels(path: string, contents: string): FileFacts {
  const parsed = parseOrFail(path, contents);
  if (isFacts(parsed)) return parsed;
  const loc: SourceLoc = { file: path, line: 1, column: 0 };

  const names = many(parsed, 'labels')
    .map((label) => text(label, 'fullName'))
    .filter((n): n is string => n !== null);

  return {
    ...emptyFacts(path, LABELS_EXTRACTOR_ID),
    declarations: names.map((name) => ({
      name,
      kind: 'label' as const,
      flags: 0,
      superType: null,
      interfaces: [],
      testMethods: [],
      entryPoints: [],
      loc,
    })),
  };
}

/** `customPermissions/Approve_Refunds.customPermission-meta.xml`. */
export function extractCustomPermission(path: string, contents: string): FileFacts {
  const parsed = parseOrFail(path, contents);
  if (isFacts(parsed)) return parsed;
  const loc: SourceLoc = { file: path, line: 1, column: 0 };
  const name = text(parsed, 'fullName') ?? apiNameFromPath(path);

  return {
    ...emptyFacts(path, LABELS_EXTRACTOR_ID),
    declarations: [
      {
        name,
        kind: 'custompermission',
        flags: 0,
        superType: null,
        interfaces: [],
        testMethods: [],
        entryPoints: [],
        loc,
      },
    ],
  };
}

/**
 * `translations/de.translation-meta.xml` and `objectTranslations/**`.
 *
 * A translation is modelled as a permission-set-like node pointing at what it translates.
 * Tests that assert on user-visible text depend on these, so omitting them would be a
 * genuine false-negative source rather than a harmless simplification (DESIGN.md 5.6).
 */
export function extractTranslation(path: string, contents: string): FileFacts {
  const parsed = parseOrFail(path, contents);
  if (isFacts(parsed)) return parsed;
  const loc: SourceLoc = { file: path, line: 1, column: 0 };

  const name = text(parsed, 'fullName') ?? apiNameFromPath(path);
  const references: RawReference[] = [];
  const translates = (target: string | null, kind: RawReference['kind']): void => {
    if (target === null || target.length === 0) return;
    references.push({ from: name, text: target, kind, edgeKind: 'translates', at: loc, provenance: 'xml' });
  };

  for (const label of many(parsed, 'customLabels')) {
    translates(text(label, 'name'), 'label');
  }
  for (const field of many(parsed, 'fields')) {
    // Object translations sit in a folder named `<Object>-<locale>`.
    const object = /([^\\/]+)-[a-z]{2}(?:_[A-Z]{2})?[\\/]?[^\\/]*$/.exec(path)?.[1] ?? '*';
    const fieldName = text(field, 'name');
    if (fieldName !== null) translates(`${object}.${fieldName}`, 'field');
  }

  return {
    ...emptyFacts(path, LABELS_EXTRACTOR_ID),
    declarations: [
      {
        name: `translation.${name}`,
        kind: 'permset',
        flags: 0,
        superType: null,
        interfaces: [],
        testMethods: [],
        entryPoints: [],
        loc,
      },
    ],
    references: references.map((r) => ({ ...r, from: `translation.${name}` })),
  };
}

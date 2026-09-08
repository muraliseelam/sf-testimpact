/**
 * Objects, fields and validation rules (DESIGN.md 4.3).
 *
 * Formula and validation-rule references are real dependencies: a test asserting on a
 * rollup or a validation message depends on the formula that produces it. Omitting them
 * would be a false-negative source, not a harmless simplification.
 */

import {
  UNKNOWN_OBJECT,
  type Diagnostic,
  type FileFacts,
  type RawReference,
  type SourceLoc,
} from '../types.js';
import { apiNameFromPath, many, objectFromPath, parseXml, root, text, texts } from './xml.js';
import { emptyFacts, type ExtractorContext } from './facts.js';

export const METADATA_EXTRACTOR_ID = 'metadata@1';

/**
 * Formula function names and literals, which look exactly like field references.
 *
 * Over-including here would only cost inert nodes, but the list keeps the graph readable.
 * A name missing from this list becomes a field node nothing declares, which is harmless.
 */
const FORMULA_KEYWORDS = new Set(
  [
    'AND', 'OR', 'NOT', 'IF', 'CASE', 'ISBLANK', 'ISNULL', 'ISPICKVAL', 'ISNEW', 'ISCHANGED',
    'PRIORVALUE', 'TEXT', 'VALUE', 'LEN', 'LEFT', 'RIGHT', 'MID', 'TRIM', 'UPPER', 'LOWER',
    'SUBSTITUTE', 'BEGINS', 'CONTAINS', 'INCLUDES', 'FIND', 'ABS', 'ROUND', 'FLOOR', 'CEILING',
    'MAX', 'MIN', 'MOD', 'SQRT', 'TODAY', 'NOW', 'DATE', 'DATEVALUE', 'DATETIMEVALUE', 'YEAR',
    'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'WEEKDAY', 'ADDMONTHS', 'BLANKVALUE',
    'NULLVALUE', 'HYPERLINK', 'IMAGE', 'BR', 'TRUE', 'FALSE', 'NULL', 'RECORDTYPE', 'OWNER',
    'CURRENCYRATE', 'CASESAFEID', 'GETSESSIONID', 'REGEX', 'MCEILING', 'MFLOOR', 'EXP', 'LN',
    'LOG', 'ISNUMBER', 'DISTANCE', 'GEOLOCATION', 'TIMEVALUE', 'TIMENOW', 'ISOWEEK', 'ISOYEAR',
    'FLOOR', 'PICKLISTCOUNT', 'JSENCODE', 'HTMLENCODE', 'URLENCODE', 'JSINHTMLENCODE',
  ].map((k) => k.toUpperCase()),
);

const IDENTIFIER_PATH = /\$?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

/**
 * Field references inside a formula or validation-rule expression.
 *
 * Unqualified names belong to the owning object. A dotted name is a relationship traversal
 * whose owning object we cannot determine without relationship metadata, so it is widened
 * with `*` exactly as a SOQL traversal is (DESIGN.md 5.2).
 */
export function formulaFieldRefs(formula: string, ownerObject: string): string[] {
  const found = new Set<string>();
  for (const raw of formula.match(IDENTIFIER_PATH) ?? []) {
    // `$User.Id`, `$Setup.X__c.Y__c` and friends are global variables, not fields on this
    // object. They are skipped rather than mis-attributed.
    if (raw.startsWith('$')) continue;

    const parts = raw.split('.');
    const head = parts[0] ?? '';
    if (parts.length === 1) {
      if (FORMULA_KEYWORDS.has(head.toUpperCase())) continue;
      found.add(`${ownerObject}.${head}`);
      continue;
    }
    const last = parts[parts.length - 1] ?? '';
    if (FORMULA_KEYWORDS.has(last.toUpperCase())) continue;
    found.add(`${UNKNOWN_OBJECT}.${last}`);
  }
  return [...found];
}

/** Does this path look like an object, field or validation-rule document? */
export function isMetadataPath(path: string): boolean {
  return /\.(object|field|validationRule)-meta\.xml$/i.test(path);
}

export function extractMetadata(path: string, contents: string, ctx: ExtractorContext = {}): FileFacts {
  const base = emptyFacts(path, METADATA_EXTRACTOR_ID);
  const loc: SourceLoc = { file: path, line: 1, column: 0 };
  const diagnostics: Diagnostic[] = [];

  let doc;
  try {
    doc = root(parseXml(contents));
  } catch (cause) {
    return {
      ...base,
      parsedOk: false,
      diagnostics: [
        {
          severity: 'error',
          message: `Could not parse XML: ${cause instanceof Error ? cause.message : String(cause)}`,
          at: loc,
        },
      ],
    };
  }

  if (/\.object-meta\.xml$/i.test(path)) return extractObject(path, doc, loc, base);
  if (/\.field-meta\.xml$/i.test(path)) return extractField(path, doc, loc, base, ctx);
  if (/\.validationRule-meta\.xml$/i.test(path)) return extractValidationRule(path, doc, loc, base);

  return { ...base, diagnostics };
}

function extractObject(
  path: string,
  doc: ReturnType<typeof root>,
  loc: SourceLoc,
  base: FileFacts,
): FileFacts {
  const name = text(doc, 'fullName') ?? apiNameFromPath(path);
  return {
    ...base,
    declarations: [
      {
        name,
        kind: 'sobject',
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

function extractField(
  path: string,
  doc: ReturnType<typeof root>,
  loc: SourceLoc,
  base: FileFacts,
  ctx: ExtractorContext,
): FileFacts {
  const object = objectFromPath(path) ?? ctx.objectName ?? 'Unknown';
  const fieldName = text(doc, 'fullName') ?? apiNameFromPath(path);
  const qualified = `${object}.${fieldName}`;
  const references: RawReference[] = [];

  // A field belongs to its object. Reversed during a query, this makes an object-level
  // change reach every field and therefore every field consumer — deliberately broad,
  // because record types and the sharing model can affect any consumer (DESIGN.md 4.3).
  references.push({
    from: qualified,
    text: object,
    kind: 'sobject',
    edgeKind: 'memberOf',
    at: loc,
    provenance: 'xml',
  });

  const formula = text(doc, 'formula');
  if (formula !== null) {
    for (const target of formulaFieldRefs(formula, object)) {
      references.push({
        from: qualified,
        text: target,
        kind: 'field',
        edgeKind: 'formulaRef',
        at: loc,
        provenance: 'xml',
      });
    }
  }

  // A rollup summary reads a field on a different object entirely.
  const summarised = text(doc, 'summarizedField');
  const summaryObject = text(doc, 'summaryForeignKey');
  if (summarised !== null) {
    const owner = summaryObject === null ? UNKNOWN_OBJECT : (summaryObject.split('.')[0] ?? UNKNOWN_OBJECT);
    references.push({
      from: qualified,
      text: summarised.includes('.') ? summarised : `${owner}.${summarised}`,
      kind: 'field',
      edgeKind: 'formulaRef',
      at: loc,
      provenance: 'xml',
    });
  }

  return {
    ...base,
    declarations: [
      {
        name: qualified,
        kind: 'field',
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

function extractValidationRule(
  path: string,
  doc: ReturnType<typeof root>,
  loc: SourceLoc,
  base: FileFacts,
): FileFacts {
  const object = objectFromPath(path) ?? 'Unknown';
  const name = `${object}.${text(doc, 'fullName') ?? apiNameFromPath(path)}`;
  const formula = text(doc, 'errorConditionFormula') ?? '';
  const errorField = text(doc, 'errorDisplayField');

  const targets = new Set(formulaFieldRefs(formula, object));
  if (errorField !== null) targets.add(`${object}.${errorField}`);

  // A validation rule is modelled as a field-like node on its object so that changing the
  // rule reaches everything that touches the fields it guards.
  return {
    ...base,
    declarations: [
      {
        name,
        kind: 'field',
        flags: 0,
        superType: null,
        interfaces: [],
        testMethods: [],
        entryPoints: [],
        loc,
      },
    ],
    references: [
      { from: name, text: object, kind: 'sobject', edgeKind: 'memberOf', at: loc, provenance: 'xml' },
      ...[...targets].map(
        (target): RawReference => ({
          from: name,
          text: target,
          kind: 'field',
          edgeKind: 'formulaRef',
          at: loc,
          provenance: 'xml',
        }),
      ),
    ],
  };
}

/** Every element under a repeated container, for callers that need raw access. */
export const childElements = many;
export const childTexts = texts;

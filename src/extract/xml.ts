/**
 * Shared XML helpers for the metadata extractors.
 *
 * `fast-xml-parser` returns a value, an array of values, or nothing at all for the same
 * element depending on how many times it appears. Every accessor here normalises that away,
 * because a single-element list silently read as a scalar is how an extractor quietly stops
 * emitting edges.
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

export type XmlNode = Record<string, unknown>;

export function parseXml(contents: string): XmlNode {
  const parsed: unknown = parser.parse(contents);
  return isRecord(parsed) ? parsed : {};
}

export function isRecord(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every occurrence of a child element, whether the parser gave us one, many or none. */
export function many(node: unknown, key: string): XmlNode[] {
  if (!isRecord(node)) return [];
  const value = node[key];
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter(isRecord);
}

/** The text of a child element, or null. */
export function text(node: unknown, key: string): string | null {
  if (!isRecord(node)) return null;
  const value = node[key];
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // `Array.isArray` on an `unknown` narrows to `any[]`, so the element is re-widened to
  // `unknown` before it is inspected.
  if (Array.isArray(value)) {
    const first: unknown = (value as readonly unknown[])[0];
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
}

/** Text of every occurrence of a repeated scalar element. */
export function texts(node: unknown, key: string): string[] {
  if (!isRecord(node)) return [];
  const value = node[key];
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** The document's single root element, whatever it is called. */
export function root(doc: XmlNode): XmlNode {
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('?')) continue; // XML declaration
    if (isRecord(value)) return value;
  }
  return {};
}

/** `force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml` -> `Rating__c`. */
export function apiNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[a-zA-Z]+-meta\.xml$/i, '').replace(/\.xml$/i, '');
}

/** The object folder a metadata file sits under, or null. */
export function objectFromPath(path: string): string | null {
  const match = /(?:^|[\\/])objects[\\/]([^\\/]+)[\\/]/.exec(path);
  return match?.[1] ?? null;
}

/**
 * Extractor dispatch: a path decides which extractor runs.
 *
 * A path that matches nothing here returns `null`, and the safety layer turns that into a
 * documented fallback rather than a silent skip (DESIGN.md 6.5). Adding a metadata type
 * means adding a matcher here and bumping that extractor's identity.
 */

import { type FileFacts } from '../types.js';
import { APEX_EXTRACTOR_ID, extractApex } from './apex.js';
import {
  LABELS_EXTRACTOR_ID,
  extractCustomPermission,
  extractLabels,
  extractTranslation,
  isCustomPermissionPath,
  isLabelsPath,
  isTranslationPath,
} from './labels.js';
import { FLOW_EXTRACTOR_ID, extractFlow, isFlowPath } from './flow.js';
import { METADATA_EXTRACTOR_ID, extractMetadata, isMetadataPath } from './metadata.js';
import { PERMSET_EXTRACTOR_ID, extractPermissionSet, isPermissionPath } from './permset.js';
import {
  STATIC_RESOURCE_EXTRACTOR_ID,
  extractStaticResource,
  isStaticResourcePath,
} from './staticresource.js';

export { APEX_EXTRACTOR_ID, extractApex } from './apex.js';
export { FLOW_EXTRACTOR_ID } from './flow.js';
export { LABELS_EXTRACTOR_ID } from './labels.js';
export { METADATA_EXTRACTOR_ID } from './metadata.js';
export { PERMSET_EXTRACTOR_ID } from './permset.js';
export {
  STATIC_RESOURCE_EXTRACTOR_ID,
  isStaticResourcePath,
  staticResourceOwnerOf,
} from './staticresource.js';

/** Every extractor identity this build emits, for staleness detection (DESIGN.md 7.3). */
export const ALL_EXTRACTOR_IDS: readonly string[] = [
  APEX_EXTRACTOR_ID,
  METADATA_EXTRACTOR_ID,
  FLOW_EXTRACTOR_ID,
  PERMSET_EXTRACTOR_ID,
  LABELS_EXTRACTOR_ID,
  STATIC_RESOURCE_EXTRACTOR_ID,
];

export type Extractor = (path: string, contents: string) => FileFacts;

interface Rule {
  readonly matches: (path: string) => boolean;
  readonly extract: Extractor;
}

const RULES: readonly Rule[] = [
  { matches: (p) => /\.(cls|trigger)$/i.test(p), extract: extractApex },
  { matches: isMetadataPath, extract: (p, c) => extractMetadata(p, c) },
  { matches: isFlowPath, extract: extractFlow },
  { matches: isPermissionPath, extract: extractPermissionSet },
  { matches: isLabelsPath, extract: extractLabels },
  { matches: isCustomPermissionPath, extract: extractCustomPermission },
  { matches: isTranslationPath, extract: extractTranslation },
  { matches: isStaticResourcePath, extract: extractStaticResource },
];

/** The extractor for a path, or null if we do not model this file type. */
export function extractorFor(path: string): Extractor | null {
  return RULES.find((r) => r.matches(path))?.extract ?? null;
}

export function isModelledPath(path: string): boolean {
  return extractorFor(path) !== null;
}

/** Extract one file, or null when the path is not modelled. */
export function extractFile(path: string, contents: string): FileFacts | null {
  const extractor = extractorFor(path);
  return extractor === null ? null : extractor(path, contents);
}

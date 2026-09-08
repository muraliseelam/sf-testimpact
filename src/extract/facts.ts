/** Shared scaffolding for extractors. */

import { type FileFacts } from '../types.js';

/** Optional context an extractor may use when the path alone is ambiguous. */
export interface ExtractorContext {
  /** Owning object, when it cannot be derived from the path. */
  readonly objectName?: string;
}

/** An empty, successful result for `path`, to be spread and extended. */
export function emptyFacts(path: string, extractor: string): FileFacts {
  return {
    path,
    extractor,
    parsedOk: true,
    declarations: [],
    references: [],
    taints: [],
    unresolved: [],
    diagnostics: [],
  };
}

/** A failed parse, which forces the safe behaviour for whatever the file was. */
export function failedFacts(path: string, extractor: string, message: string): FileFacts {
  return {
    ...emptyFacts(path, extractor),
    parsedOk: false,
    diagnostics: [{ severity: 'error', message, at: { file: path, line: 1, column: 0 } }],
  };
}

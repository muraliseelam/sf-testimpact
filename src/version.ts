/**
 * Versions that participate in staleness detection (DESIGN.md 7.3).
 *
 * A graph built by a different tool, format or parser is not safe to query: the extractors
 * may have changed what they emit, and silently mixing old and new facts is precisely the
 * class of bug that produces a confident, wrong answer. Each of these is compared on load,
 * and a mismatch forces a full test run rather than a best-effort query.
 */

import { createRequire } from 'node:module';

/** Bumped whenever the on-disk layout changes. */
export const GRAPH_FORMAT_VERSION = 1;

/**
 * The plugin version, read from package.json rather than duplicated here.
 *
 * This was a hand-maintained literal, and semantic-release bumps package.json without
 * touching this file. The unit test that pins the two together then fails on the *next*
 * release run - and because the workflow runs the test suite before semantic-release, that
 * failure blocks every subsequent release. Exactly that happened after 0.1.1: the constant
 * still said 0.1.0.
 *
 * Deriving it removes the class of bug instead of resetting the clock on it. `../package.json`
 * resolves to the package root from `src/` under vitest and from `lib/` once compiled, and
 * package.json ships in the tarball, so the same path is correct in all three.
 */
export const TOOL_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/**
 * The `@apexdevtools/apex-parser` version this build was compiled against.
 *
 * Kept in sync with package.json by a unit test rather than by discipline: a parser upgrade
 * can change what the Apex extractor sees, so it must invalidate every existing index.
 */
export const APEX_PARSER_VERSION = '5.2.0';

/** Major version only — a patch bump does not change what we extract. */
export function majorVersion(version: string): string {
  return version.split('.')[0] ?? version;
}

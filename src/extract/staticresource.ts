/**
 * Static resources.
 *
 * Modelled rather than ignored, because a static resource genuinely can change an Apex
 * test's outcome: `Test.loadData` seeds records from one, and `StaticResourceCalloutMock`
 * serves a canned HTTP response from one. Excluding them would hide a real signal.
 *
 * Modelling them and then finding that no Apex references a given bundle is a *measured*
 * "no dependency", which is a different and much safer statement than "we chose not to look".
 *
 * A bundle is one node, declared by its `.resource-meta.xml`. The files inside the bundle
 * directory are members, not declarations — a change to any of them is resolved to the
 * bundle by `componentPathFor` in the query layer, which keeps the one-node-one-declaring-
 * file invariant intact.
 */

import { type FileFacts, type SourceLoc } from '../types.js';
import { emptyFacts } from './facts.js';
import { apiNameFromPath } from './xml.js';

export const STATIC_RESOURCE_EXTRACTOR_ID = 'staticresource@1';

export function isStaticResourcePath(path: string): boolean {
  return /\.resource-meta\.xml$/i.test(path);
}

/**
 * The `.resource-meta.xml` that owns a static resource payload file.
 *
 * Two layouts, and both are ordinary:
 *
 * - A **bundle**, where the payload is a directory:
 *   `.../staticresources/documentation/Foo.md` -> `.../staticresources/documentation.resource-meta.xml`
 * - A **single file** beside its own descriptor, which is what `sf` writes for a `.csv`,
 *   `.json`, `.zip` or image resource:
 *   `.../staticresources/SeedAccounts.csv` -> `.../staticresources/SeedAccounts.resource-meta.xml`
 *
 * Only the first was handled. The second is the more common of the two, and because the
 * payload resolved to nothing the changed file was classified as an unmodelled type, which
 * forces a full test run. Safe, but it silently undid the static-resource modelling for
 * exactly the resources most projects have.
 *
 * Returns null for paths that are not a static resource payload.
 */
export function staticResourceOwnerOf(path: string): string | null {
  const bundle = /^(.*[\\/]staticresources)[\\/]([^\\/]+)[\\/].+$/.exec(path);
  if (bundle !== null) {
    const [, dir, name] = bundle;
    if (dir === undefined || name === undefined) return null;
    return `${dir}/${name}.resource-meta.xml`;
  }

  // A descriptor is not a payload, and must not be reported as owning itself.
  if (isStaticResourcePath(path)) return null;

  const single = /^(.*[\\/]staticresources)[\\/]([^\\/]+?)\.[^.\\/]+$/.exec(path);
  if (single === null) return null;
  const [, dir, name] = single;
  if (dir === undefined || name === undefined) return null;
  return `${dir}/${name}.resource-meta.xml`;
}

export function extractStaticResource(path: string, _contents: string): FileFacts {
  const loc: SourceLoc = { file: path, line: 1, column: 0 };
  return {
    ...emptyFacts(path, STATIC_RESOURCE_EXTRACTOR_ID),
    declarations: [
      {
        name: apiNameFromPath(path),
        kind: 'staticresource',
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

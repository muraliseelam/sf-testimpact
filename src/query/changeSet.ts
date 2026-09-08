/**
 * Mapping changed file paths to graph nodes (DESIGN.md 7.1).
 *
 * Git is injected as a plain function so tests never shell out.
 */

import picomatch from 'picomatch';
import { type Config } from '../config/schema.js';
import { isModelledPath, staticResourceOwnerOf } from '../extract/index.js';
import { TestImpactError } from '../errors.js';
import { type ImpactGraph } from '../graph/model.js';
import { type NodeKey } from '../types.js';

/** How a file changed between two refs. Renames are decomposed into a delete and an add. */
export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  readonly path: string;
  readonly kind: ChangeKind;
}

/** Runs a git command and returns stdout. Injected so tests need no repository. */
export type GitRunner = (args: readonly string[]) => string;

/**
 * Files changed between two refs.
 *
 * `--name-status` rather than `--name-only`, because a rename must become a delete of the
 * old path plus an add of the new one: the old path's nodes have to be seeded as changed or
 * everything that depended on them is missed, and the new path's nodes are genuinely new.
 * `--name-only` reports only the destination and would silently drop the first half.
 */
export function gitChangedFiles(run: GitRunner, base: string, head = 'HEAD'): ChangedFile[] {
  let output: string;
  try {
    output = run(['diff', '--name-status', '--find-renames', `${base}...${head}`]);
  } catch (cause) {
    throw new TestImpactError('GIT_FAILED', `Could not diff ${base}...${head}.`, {
      subject: `${base}...${head}`,
      // Names the CI cause first: a depth-1 checkout is the single most common way this
      // fails, and "check that both refs exist" sends the reader looking for a typo instead.
      remedy:
        'Check that both refs exist here. In CI this usually means the clone is shallow: ' +
        'actions/checkout defaults to fetch-depth 1, which has neither the base branch nor ' +
        'a merge base. Set fetch-depth: 0, or fetch the base ref unshallowed.',
      cause,
    });
  }

  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    const first = parts[1];
    if (first === undefined) continue;

    if (status.startsWith('R') || status.startsWith('C')) {
      const second = parts[2];
      if (second === undefined) continue;
      files.push({ path: first, kind: 'deleted' });
      files.push({ path: second, kind: 'added' });
      continue;
    }
    if (status.startsWith('D')) files.push({ path: first, kind: 'deleted' });
    else if (status.startsWith('A')) files.push({ path: first, kind: 'added' });
    else files.push({ path: first, kind: 'modified' });
  }
  return files;
}

/** A path that could not be mapped to graph nodes, and why. */
export interface UnmappedFile {
  readonly path: string;
  readonly reason: 'not-in-index' | 'parse-failed' | 'project-config';
}

export interface ChangeSet {
  readonly seeds: readonly NodeKey[];
  /** Paths matched by `excludeFromImpact`, ignored deliberately. */
  readonly excluded: readonly string[];
  readonly unmapped: readonly UnmappedFile[];
  readonly changed: readonly ChangedFile[];
  /** Paths outside every configured source path, so not project metadata at all. */
  readonly outsideSourcePaths: readonly string[];
}

/**
 * The indexed component a changed path belongs to, when the path is not itself indexed.
 *
 * Salesforce components are frequently more than one file, and only one of those files is
 * the one we index:
 *
 *  - **`-meta.xml` companions.** Every `.cls` has a `.cls-meta.xml` holding its apiVersion
 *    and status. An apiVersion bump changes how the class *executes*, so this is a real
 *    change to the class, not noise — it resolves to the class's own nodes and selects the
 *    same tests a body change would. Ignoring it would hide a genuine signal; treating it as
 *    an unknown file type forced a full run on every commit that touched one.
 *  - **Static resource bundle members.** `staticresources/docs/x.md` belongs to the bundle
 *    declared by `staticresources/docs.resource-meta.xml`.
 *
 * Returns null when the path is not a member of some other component.
 */
export function componentPathFor(path: string): string | null {
  if (path.endsWith('-meta.xml')) {
    const base = path.replace(/-meta\.xml$/, '');
    if (isModelledPath(base)) return base;
  }
  return staticResourceOwnerOf(path);
}

/** Files whose contents change what indexing itself would produce. */
const PROJECT_CONFIG_FILES = ['sfdx-project.json', '.sf-testimpact.yml', '.sf-testimpact.yaml'];

function isProjectConfig(path: string): boolean {
  return PROJECT_CONFIG_FILES.some((name) => path === name || path.endsWith(`/${name}`));
}

/**
 * Map changed paths onto graph nodes.
 *
 * A deleted file's nodes are seeded exactly like a modified file's: everything that
 * depended on them must be retested, and the nodes are still in the index because the index
 * describes the base revision.
 */
export function resolveChangeSet(
  graph: ImpactGraph,
  changed: readonly ChangedFile[],
  config: Config,
): ChangeSet {
  const isExcluded =
    config.excludeFromImpact.length === 0
      ? (): boolean => false
      : picomatch(config.excludeFromImpact as string[]);

  const seeds: NodeKey[] = [];
  const excluded: string[] = [];
  const unmapped: UnmappedFile[] = [];
  const outsideSourcePaths: string[] = [];

  const sourcePaths = graph.project.sourcePaths;
  const inSourcePaths = (path: string): boolean =>
    sourcePaths.length === 0 ||
    sourcePaths.some((sp) => {
      const clean = sp.replace(/^\.\//, '').replace(/\/+$/, '');
      return clean === '' || clean === '.' || path === clean || path.startsWith(`${clean}/`);
    });

  for (const file of changed) {
    if (isProjectConfig(file.path)) {
      unmapped.push({ path: file.path, reason: 'project-config' });
      continue;
    }
    if (isExcluded(file.path)) {
      excluded.push(file.path);
      continue;
    }
    // A path outside every configured source path is not project metadata. The indexer never
    // walked it, so it cannot be deployed and cannot change Apex behaviour — CI workflow
    // files, repository docs, build scripts. Treating these as "unknown metadata" and
    // running the whole suite was the single largest source of pointless full runs.
    if (!inSourcePaths(file.path)) {
      outsideSourcePaths.push(file.path);
      continue;
    }

    const own = graph.nodesDeclaredIn(file.path);
    const component = own.length === 0 ? componentPathFor(file.path) : null;
    const nodes = component === null ? own : graph.nodesDeclaredIn(component);
    if (nodes.length > 0) {
      seeds.push(...nodes);
      const indexed = graph.fileAt(file.path);
      if (indexed?.parsedOk === false) {
        unmapped.push({ path: file.path, reason: 'parse-failed' });
      }
      continue;
    }

    // An added file will not be in an index built at the base revision. That is expected,
    // not an error — but it does mean the index cannot tell us what the file references, so
    // it is reported for the safety layer to act on.
    unmapped.push({ path: file.path, reason: 'not-in-index' });
  }

  return { seeds, excluded, unmapped, changed, outsideSourcePaths };
}

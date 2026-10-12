/**
 * Shared real-I/O helpers for the bench entry points.
 *
 * Everything here reads a git repository and reconstructs trees from blobs, which is the
 * same replay `docs/measurements/measure.mjs` used for every published figure: index the
 * tree at a commit without checking it out, diff it against its first parent, analyze. The
 * harness logic stays in `src/bench/` where it is type-checked and unit-tested; this file is
 * the plumbing that feeds it.
 */

import { execFileSync } from 'node:child_process';

import { buildGraph, currentGenerator, hashContents } from '../lib/graph/store.js';
import { extractFile, isModelledPath } from '../lib/extract/index.js';
import { analyze } from '../lib/query/analyze.js';
import { gitChangedFiles } from '../lib/query/changeSet.js';
import { DEFAULT_CONFIG } from '../lib/config/schema.js';
import { toSelection } from '../lib/bench/sfCli.js';

/**
 * `--key value` pairs plus bare `--flag` booleans.
 *
 * A value never starts with `--`, so `--dry-run --store x` reads as the boolean `dry-run`
 * followed by the pair `store x` rather than swallowing `--store` as dry-run's value.
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** A git runner bound to one repository, with stderr kept so failures are explainable. */
export function makeGit(repo) {
  return (gitArgs) =>
    execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

/** The commit's first parent, or null for a root commit. */
export function parentOf(repo, commit) {
  try {
    // stdio 'pipe' keeps git's "Needed a single revision" off our stderr: a root commit is
    // an expected input here, not an error worth showing.
    return execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Source paths and namespace as `sfdx-project.json` declared them AT THAT COMMIT.
 *
 * Read from the blob rather than the working tree, because a window can span a change to
 * `packageDirectories`, and indexing a commit under a later layout would report files the
 * tool could never have seen as missing from the index.
 */
export function projectAt(git, commit, overrideSourcePaths) {
  let sourcePaths = overrideSourcePaths ?? [];
  let namespace = 'c';
  if (sourcePaths.length === 0 || overrideSourcePaths === undefined) {
    let raw;
    try {
      raw = git(['show', `${commit}:sfdx-project.json`]);
    } catch {
      raw = null;
    }
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (sourcePaths.length === 0) {
        sourcePaths = (parsed.packageDirectories ?? [])
          .map((d) => d.path)
          .filter((p) => typeof p === 'string' && p.length > 0);
      }
      if (typeof parsed.namespace === 'string' && parsed.namespace.length > 0) namespace = parsed.namespace;
    }
  }
  if (sourcePaths.length === 0) {
    throw new Error(
      `No source paths for ${commit.slice(0, 10)}: sfdx-project.json has no packageDirectories at that commit. Pass --source-paths.`,
    );
  }
  return { sourcePaths: sourcePaths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')), namespace };
}

function underSourcePaths(path, sourcePaths) {
  return sourcePaths.some((sp) => sp === '.' || sp === '' || path === sp || path.startsWith(`${sp}/`));
}

/**
 * Index the tree at a commit from git blobs, restricted to the project's source paths.
 *
 * Restricting to `sourcePaths` matches what `sf testimpact index` walks. Indexing every
 * modelled path in the repository would include `datasets/` scripts and sample code that the
 * real command never sees, and the selection measured here must be the one a user would get.
 */
export function makeIndexer(repo, overrideSourcePaths) {
  const git = makeGit(repo);
  const cache = new Map();
  return (commit) => {
    const cached = cache.get(commit);
    if (cached !== undefined) return cached;

    const { sourcePaths, namespace } = projectAt(git, commit, overrideSourcePaths);
    const facts = [];
    const files = [];
    for (const line of git(['ls-tree', '-r', '--name-only', commit]).split('\n')) {
      const path = line.trim();
      if (path === '' || !underSourcePaths(path, sourcePaths) || !isModelledPath(path)) continue;
      let contents;
      try {
        contents = git(['show', `${commit}:${path}`]);
      } catch {
        continue; // Listed but unreadable at this revision; skip rather than abort the window.
      }
      const extracted = extractFile(path, contents);
      if (extracted === null) continue;
      facts.push(extracted);
      files.push({ path, hash: hashContents(contents), parsedOk: extracted.parsedOk, extractor: extracted.extractor });
    }
    const graph = buildGraph(
      files,
      facts,
      { root: repo, sourcePaths, namespace },
      currentGenerator(),
      new Date(0).toISOString(),
    );
    // One graph per commit is enough for the three policies the report scores; keeping more
    // than a couple around on a large repository would exhaust memory for no benefit.
    if (cache.size >= 2) cache.clear();
    cache.set(commit, graph);
    return graph;
  };
}

/**
 * What `analyze` selects for `c^..c` under one `entryPointPolicy`.
 *
 * The index is built at `c` itself, not `c^`: real usage indexes the branch tip and diffs
 * against a base, so files added by the commit ARE in the index. This is the `--indexAt
 * head` convention every published selection-quality figure uses.
 */
export function makeSelector(repo, indexAt) {
  const git = makeGit(repo);
  return (commit, policy) => {
    const parent = parentOf(repo, commit);
    if (parent === null) {
      throw new Error(`${commit.slice(0, 10)} has no parent, so it has no change set to analyze.`);
    }
    const graph = indexAt(commit);
    const changed = gitChangedFiles(git, parent, commit);
    const config = { ...DEFAULT_CONFIG, entryPointPolicy: policy ?? DEFAULT_CONFIG.entryPointPolicy };
    return toSelection(analyze(graph, changed, config));
  };
}

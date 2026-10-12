#!/usr/bin/env node
/**
 * Stage 3 of the false-negative harness: run the FULL Apex suite at every commit of a window
 * against a real org, recording per-test outcomes to a resumable store.
 *
 * This is the only entry point in the repository that needs an org. It is deliberately
 * thin: the driver (`src/bench/execute.ts`) and the interpretation of `sf` output
 * (`src/bench/sfCli.ts`) are type-checked and unit-tested; this file supplies real
 * processes, a real git worktree and a real file for the store.
 *
 *   node bench/execute.js --repo <path> --worktree <path> --target-org <alias>
 *                         --base <sha> [--head <sha>] [--store <file>]
 *                         [--policy full|widen|strict] [--source-paths a,b]
 *                         [--deploy-mode tracking|source-dir]
 *                         [--deploy-wait <min>] [--test-wait <min>]
 *                         [--only-source-changes] [--max-commits <n>] [--no-recheck] [--dry-run]
 *
 *   --repo         the repository whose history is the window; never checked out or modified
 *   --worktree     a separate checkout the harness owns. Created with `git worktree add` if
 *                  absent; checked out to each commit in turn, so NEVER your working copy
 *   --target-org   an authenticated `sf` alias. Credentials stay in the CLI's own store;
 *                  this script never reads them and anything credential-shaped that leaks
 *                  into a failure message is redacted before it is written anywhere
 *   --base/--head  the window is `base..head`, first-parent, oldest first; `base` itself is
 *                  executed first as the baseline the first commit's failures are scored
 *                  against. --head defaults to the repository's HEAD
 *   --store        NDJSON observation store. Default docs/measurements/fn-observations.ndjson,
 *                  because the store IS the evidence and belongs with the other artifacts
 *   --policy       entryPointPolicy recorded with each commit's selection. The report step
 *                  re-scores every policy offline, so this only sets what is logged here
 *   --deploy-mode  `tracking` (default) runs `sf project deploy start` with no source flags
 *                  on a source-tracked org, which deploys changed files AND removes deleted
 *                  ones: the sf docs for `project delete source` say "to remove deleted items
 *                  from orgs that have source tracking enabled, delete the files locally and
 *                  run sf project deploy start". `source-dir` deploys each package directory
 *                  explicitly and does NOT propagate deletions, so a class deleted mid-window
 *                  lingers in the org. Use it only against an org without tracking, and read
 *                  the result knowing that
 *   --only-source-changes
 *                  skip commits whose diff from their first parent touches nothing under the
 *                  project's source paths (dependency bumps, CI, docs). Exact for the metric,
 *                  not an approximation: such a commit deploys nothing, so the org state and
 *                  every test outcome at it are those of the last source-changing commit, and
 *                  the scorer's "previous observation" therefore has the same deployed source
 *                  as c^. On apex-recipes this removes about three quarters of a window
 *   --pre-deploy-dir <dir[,dir]>
 *                  deploy these directories (relative to the worktree, when present at the
 *                  commit) on their own BEFORE the main deploy. Needed where the platform
 *                  refuses to compile metadata in the same deploy as something it references:
 *                  Apex that uses a DataWeave script fails with "Invalid type:
 *                  DataWeaveScriptResource.<name>" unless the script already exists in the
 *                  org, even though source tracking puts both in one deploy. apex-recipes
 *                  needs `force-app/main/default/dw`. A pre-deploy failure is the commit's
 *                  exclusion reason, prefixed with the directory
 *   --retry-excluded
 *                  execute again every commit the store recorded as excluded. Their exclusion
 *                  records are removed from the store first (a copy of the store as it was
 *                  is kept under bench/results/) so an exclusion caused by the harness
 *                  environment rather than by the commit can be corrected. A commit that
 *                  fails again is recorded as excluded again. This is the one operation that
 *                  rewrites the store, it is logged, and it never touches a commit that has
 *                  outcomes
 *   --max-commits  stop after recording this many NEW commits. Resume by re-running: already
 *                  recorded commits are skipped. This is how a window is run in batches
 *                  across scratch-org limits
 *   --dry-run      compute the window and every commit's selection offline, print the exact
 *                  `sf` commands that would run, and touch neither the org nor the store
 *
 * Nothing printed here is a measurement. The measurement is produced by `bench/fn-report.js`
 * from the store this writes.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';

import { executeWindow, makeCliTestRunner, redactSecrets } from '../lib/bench/execute.js';
import { WindowMismatchError, openStore } from '../lib/bench/observationStore.js';
import { deployResultFromProcess, parseRevList, testRunStdoutFromProcess, windowFor } from '../lib/bench/sfCli.js';
import { makeGit, makeIndexer, makeSelector, parentOf, parseArgs, projectAt, touchesSourcePaths } from './replay.js';

const args = parseArgs(process.argv);
const log = (message) => process.stderr.write(`${redactSecrets(message)}\n`);
/** Paths are shown relative to the working directory so a saved transcript stays readable. */
const shown = (p) => relative(process.cwd(), p) || '.';

function usage(problem) {
  if (problem !== undefined) log(`error: ${problem}`);
  log('usage: node bench/execute.js --repo <path> --worktree <path> --target-org <alias> --base <sha>');
  log('       [--head <sha>] [--store <file>] [--policy full|widen|strict] [--source-paths a,b]');
  log('       [--deploy-mode tracking|source-dir] [--deploy-wait <min>] [--test-wait <min>]');
  log('       [--only-source-changes] [--pre-deploy-dir <dir[,dir]>] [--retry-excluded]');
  log('       [--max-commits <n>] [--no-recheck] [--dry-run]');
  process.exit(2);
}

const repo = typeof args.repo === 'string' ? resolvePath(args.repo) : undefined;
const worktree = typeof args.worktree === 'string' ? resolvePath(args.worktree) : undefined;
const targetOrg = typeof args['target-org'] === 'string' ? args['target-org'] : undefined;
const dryRun = args['dry-run'] === true;

if (repo === undefined) usage('--repo is required');
if (typeof args.base !== 'string') usage('--base is required');
if (!dryRun && worktree === undefined) usage('--worktree is required (a checkout this harness owns)');
if (!dryRun && targetOrg === undefined) usage('--target-org is required');
if (worktree !== undefined && worktree === repo) usage('--worktree must not be the repository itself');

const policy = typeof args.policy === 'string' ? args.policy : 'full';
if (!['full', 'widen', 'strict'].includes(policy)) usage(`--policy must be full, widen or strict, not ${policy}`);
const deployMode = typeof args['deploy-mode'] === 'string' ? args['deploy-mode'] : 'tracking';
if (!['tracking', 'source-dir'].includes(deployMode)) usage(`--deploy-mode must be tracking or source-dir`);
const deployWait = String(Number(args['deploy-wait'] ?? 60));
const testWait = Number(args['test-wait'] ?? 120);
const maxCommits = args['max-commits'] === undefined ? Infinity : Number(args['max-commits']);
const sourcePathsOverride =
  typeof args['source-paths'] === 'string' ? args['source-paths'].split(',').filter(Boolean) : undefined;
const storePath = resolvePath(typeof args.store === 'string' ? args.store : 'docs/measurements/fn-observations.ndjson');
const preDeployDirs =
  typeof args['pre-deploy-dir'] === 'string' ? args['pre-deploy-dir'].split(',').filter(Boolean) : [];
const retryExcluded = args['retry-excluded'] === true;

// ---------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------

const git = makeGit(repo);
const baseSha = git(['rev-parse', '--verify', `${args.base}^{commit}`]).trim();
const headSha = git(['rev-parse', '--verify', `${typeof args.head === 'string' ? args.head : 'HEAD'}^{commit}`]).trim();
const revList = parseRevList(git(['rev-list', '--reverse', '--first-parent', `${baseSha}..${headSha}`]));
if (revList.length === 0) usage(`${baseSha.slice(0, 10)}..${headSha.slice(0, 10)} contains no commits`);

let repoName = repo;
try {
  repoName = git(['remote', 'get-url', 'origin']).trim() || repo;
} catch {
  // No remote: the path is the only name there is.
}
const onlySourceChanges = args['only-source-changes'] === true;
const scoped = onlySourceChanges
  ? revList.filter((c) => {
      const parent = parentOf(repo, c);
      if (parent === null) return true;
      return touchesSourcePaths(git, c, parent, projectAt(git, c, sourcePathsOverride).sourcePaths);
    })
  : revList;
const { identity, commits } = windowFor(repoName, baseSha, headSha, scoped);

log(`window: ${identity.repo}`);
log(`  ${baseSha.slice(0, 10)}..${headSha.slice(0, 10)}: ${revList.length} commit(s), plus the base as baseline`);
if (onlySourceChanges) {
  log(`  --only-source-changes: ${scoped.length} of ${revList.length} change something under the source paths; the rest deploy nothing and are skipped`);
}

// ---------------------------------------------------------------------------------------
// Offline half: selection at each commit, from git blobs
// ---------------------------------------------------------------------------------------

const indexAt = makeIndexer(repo, sourcePathsOverride);
const selectAt = makeSelector(repo, indexAt);
const select = (commit) => selectAt(commit, policy);

// ---------------------------------------------------------------------------------------
// Org half: checkout, deploy, run
// ---------------------------------------------------------------------------------------

/**
 * On Windows `sf` is `sf.cmd`, which Node will only spawn through a shell, and a shell
 * concatenates arguments with spaces. Anything that could contain one is quoted here so a
 * source path with a space stays one argument.
 */
const useShell = process.platform === 'win32';
const shellSafe = (arg) => (useShell && /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

function runSf(argv, cwd) {
  const result = spawnSync('sf', useShell ? argv.map(shellSafe) : argv, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    shell: useShell,
    env: { ...process.env, SF_AUTOUPDATE_DISABLE: 'true', SF_DISABLE_TELEMETRY: 'true' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error.message }),
  };
}

function deployArgv(commit) {
  const argv = ['project', 'deploy', 'start', '--target-org', targetOrg ?? '<alias>', '--json', '--wait', deployWait, '--ignore-conflicts'];
  if (deployMode === 'source-dir') {
    for (const path of projectAt(git, commit, sourcePathsOverride).sourcePaths) argv.push('--source-dir', path);
  }
  return argv;
}

function ensureWorktree() {
  if (existsSync(worktree)) {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      usage(`${worktree} exists but is not a git working tree`);
    }
    return;
  }
  mkdirSync(dirname(worktree), { recursive: true });
  log(`creating worktree ${worktree} at ${baseSha.slice(0, 10)}`);
  git(['worktree', 'add', '--detach', worktree, baseSha]);
}

function deploy(commit) {
  try {
    execFileSync('git', ['checkout', '--detach', '--force', commit], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, reason: redactSecrets(`checkout failed: ${error instanceof Error ? error.message : String(error)}`) };
  }
  for (const dir of preDeployDirs) {
    if (!existsSync(join(worktree, dir))) continue;
    const pre = deployResultFromProcess(
      runSf(['project', 'deploy', 'start', '--target-org', targetOrg, '--json', '--wait', deployWait, '--ignore-conflicts', '--source-dir', dir], worktree),
    );
    if (!pre.ok) return { ok: false, reason: `pre-deploy ${dir}: ${pre.reason ?? 'no reason reported'}` };
  }
  return deployResultFromProcess(runSf(deployArgv(commit), worktree));
}

const runTests = makeCliTestRunner(
  (argv) => testRunStdoutFromProcess(runSf([...argv, '--target-org', targetOrg], worktree)),
  { waitMinutes: testWait },
);

// ---------------------------------------------------------------------------------------
// Dry run: everything except the org and the store
// ---------------------------------------------------------------------------------------

if (dryRun) {
  log('');
  log('dry run: no org is contacted and nothing is written.');
  for (const dir of preDeployDirs) log(`  pre-deploy:         sf project deploy start --source-dir ${dir} ...   (when ${dir} exists at the commit)`);
  log(`  deploy per commit:  sf ${deployArgv(commits[commits.length - 1]).join(' ')}   (cwd: worktree)`);
  log(`  full suite:         sf apex run test --result-format json --wait ${testWait} --test-level RunLocalTests --target-org ${targetOrg ?? '<alias>'}`);
  log(`  flake re-check:     sf apex run test ... --test-level RunSpecifiedTests --tests <each failure>`);
  log(`  store:              ${shown(storePath)}${existsSync(storePath) ? ' (exists; would resume)' : ' (would be created)'}`);
  log(`  worktree:           ${worktree === undefined ? '(not given)' : shown(worktree)}${worktree !== undefined && existsSync(worktree) ? ' (exists)' : ''}`);
  log('');
  log(`selection under entryPointPolicy: ${policy}, index at each commit, diff against first parent`);
  for (const [i, commit] of commits.entries()) {
    if (i === 0) {
      log(`  ${commit.slice(0, 10)}  baseline (outcomes only, no selection scored)`);
      continue;
    }
    const s = select(commit);
    log(`  ${commit.slice(0, 10)}  ${s.fellBack ? `FALLBACK  ${s.totalTests} tests` : `selected ${s.selected.length} of ${s.totalTests}`}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------

const fs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  appendFile: (p, c) => appendFileSync(p, c, 'utf8'),
  exists: (p) => existsSync(p),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
};

if (retryExcluded && existsSync(storePath)) {
  // The only operation that rewrites the store. Exclusion records are removed so the driver
  // executes those commits again; everything with outcomes is kept byte for byte, and the
  // store as it was is copied aside first.
  const raw = readFileSync(storePath, 'utf8').split('\n');
  const lastNonEmpty = raw.reduce((last, line, i) => (line.trim() === '' ? last : i), -1);
  const kept = [];
  const dropped = [];
  for (const [i, line] of raw.entries()) {
    const text = line.trim();
    if (text === '') continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      if (i === lastNonEmpty) continue; // A truncated tail from an interrupted run; openStore drops it too.
      throw new Error(`${storePath} is corrupt at line ${i + 1}; refusing to rewrite it.`);
    }
    if (record.kind === 'commit' && record.excluded !== undefined) {
      dropped.push(record.commit);
      continue;
    }
    kept.push(text);
  }
  if (dropped.length > 0) {
    const backupDir = resolvePath('bench/results');
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${basename(storePath)}.before-retry-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    copyFileSync(storePath, backup);
    writeFileSync(storePath, `${kept.join('\n')}\n`, 'utf8');
    log(
      `--retry-excluded: removed ${dropped.length} exclusion record(s) so those commits run again ` +
        `(${dropped.map((c) => c.slice(0, 10)).join(', ')}); the store as it was is at ${shown(backup)}`,
    );
  }
}

let opened;
try {
  opened = openStore(fs, storePath, identity);
} catch (error) {
  if (error instanceof WindowMismatchError) {
    log(error.message);
    process.exit(2);
  }
  throw error;
}
const { store } = opened;
if (opened.recorded.length > 0) log(`store: ${shown(storePath)} already holds ${opened.recorded.length} commit(s); resuming`);
if (opened.resumedAfterInterruption) log('store: a truncated final line from an interrupted run was discarded; that commit is redone');

const firstNew = commits.findIndex((c) => !store.has(c));
if (firstNew === -1) {
  log('every commit in the window is already recorded. Run bench/fn-report.js to score it.');
  process.exit(0);
}
const toRun = Number.isFinite(maxCommits) ? commits.slice(0, firstNew + maxCommits) : commits;
if (toRun.length < commits.length) log(`--max-commits ${maxCommits}: stopping after ${toRun.length - firstNew} new commit(s)`);

ensureWorktree();
log(`target org: ${targetOrg}; deploy mode: ${deployMode}; test wait: ${testWait} min`);
log('');

const report = executeWindow({ deploy, runTests, select, log }, store, toRun, {
  recheckFailures: args['no-recheck'] !== true,
  firstCommitIsBaseline: true,
});

console.log('');
console.log(`attempted ${report.attempted}, recorded ${report.recorded}, already recorded ${report.skippedAlreadyRecorded}`);
console.log(`excluded ${report.excluded.length}, flaky observed ${report.flakyObserved.length}`);
for (const e of report.excluded) console.log(`  excluded ${e.commit.slice(0, 10)}: ${e.reason}`);
const remaining = commits.filter((c) => !store.has(c)).length;
console.log(
  remaining === 0
    ? `window complete. Score it with: node bench/fn-report.js --repo ${shown(repo)} --store ${shown(storePath)}`
    : `${remaining} commit(s) remaining. Re-run the same command to continue.`,
);

#!/usr/bin/env node
/**
 * Benchmark CLI.
 *
 * The harness *logic* lives in `src/bench/` so it is compiled, type-checked and unit-tested
 * with the rest of the tool; this file is the thin entry point that supplies real I/O.
 *
 * Usage:
 *   node bench/run.js --repo <path> --commits <file> --results <dir> [--adapter sf-json]
 *                     [--max-flips 2] [--out bench/results]
 *
 *   --commits   file with one commit sha per line, oldest first
 *   --results   directory holding <sha>.json or <sha>.xml test results
 *
 * Every number it prints comes from the repository and the result files. Nothing is
 * estimated or defaulted: a run with no timings reports test counts and says so.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { runBenchmark } from '../lib/bench/run.js';
import { renderReport, toReportJson } from '../lib/bench/report.js';
import { buildGraph, currentGenerator, hashContents } from '../lib/graph/store.js';
import { extractFile, isModelledPath } from '../lib/extract/index.js';
import { DEFAULT_CONFIG } from '../lib/config/schema.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key === undefined) continue;
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);
const repo = args.repo;
const commitsFile = args.commits;
const resultsDir = args.results;

if (repo === undefined || commitsFile === undefined || resultsDir === undefined) {
  console.error('usage: node bench/run.js --repo <path> --commits <file> --results <dir>');
  console.error('       [--adapter sf-json|junit-xml] [--max-flips 2] [--out bench/results]');
  process.exit(2);
}

const git = (gitArgs) =>
  execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Files tracked at a commit, as repo-relative paths. */
function filesAt(commit) {
  return git(['ls-tree', '-r', '--name-only', commit]).split('\n').filter((p) => p.trim() !== '');
}

/** Index the tree at a commit, reading blobs from git rather than checking anything out. */
function indexAt(commit) {
  const facts = [];
  const files = [];
  for (const path of filesAt(commit)) {
    if (!isModelledPath(path)) continue;
    let contents;
    try {
      contents = git(['show', `${commit}:${path}`]);
    } catch {
      continue; // Path present in the listing but unreadable at this rev; skip it.
    }
    const extracted = extractFile(path, contents);
    if (extracted === null) continue;
    facts.push(extracted);
    files.push({
      path,
      hash: hashContents(contents),
      parsedOk: extracted.parsedOk,
      extractor: extracted.extractor,
    });
  }
  return buildGraph(
    files,
    facts,
    { root: repo, sourcePaths: ['.'], namespace: 'c' },
    currentGenerator(),
    new Date(0).toISOString(),
  );
}

/** The commit's first parent, or null when it is a root commit. */
function parentOf(commit) {
  try {
    // stdio 'pipe' keeps git's "Needed a single revision" off our stderr: a root commit is
    // an expected input here, not an error worth showing the user.
    return execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Historical results for a commit, if a file for it exists. */
function resultsFor(commit) {
  for (const ext of ['.json', '.xml']) {
    const path = join(resultsDir, `${commit}${ext}`);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  const short = commit.slice(0, 7);
  if (!existsSync(resultsDir)) return null;
  const match = readdirSync(resultsDir).find((n) => n.startsWith(short));
  return match === undefined ? null : readFileSync(join(resultsDir, match), 'utf8');
}

const commits = readFileSync(commitsFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

console.error(`Benchmarking ${commits.length} commits from ${repo} ...`);

const run = runBenchmark(
  { indexAt, git, resultsFor, parentOf },
  {
    commits,
    config: DEFAULT_CONFIG,
    ...(args.adapter === undefined ? {} : { adapterId: args.adapter }),
    ...(args['max-flips'] === undefined ? {} : { maxFlips: Number(args['max-flips']) }),
    onProgress: (done, total, commit) => {
      process.stderr.write(`\r  ${done}/${total}  ${commit.slice(0, 10)}   `);
    },
  },
);
process.stderr.write('\n\n');

console.log(renderReport(run.summary, relative(process.cwd(), repo) || repo));
if (run.skipped.length > 0) {
  console.log('');
  console.log(`Skipped ${run.skipped.length} commit(s) with no usable results.`);
}

const outDir = args.out ?? 'bench/results';
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(outDir, `bench-${stamp}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ ...toReportJson(run.summary, repo), adapter: run.adapterId, skipped: run.skipped }, null, 2),
);
console.log(`\nWrote ${outPath}`);

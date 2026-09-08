#!/usr/bin/env node
/**
 * Provenance ablation CLI (DESIGN.md 11.2).
 *
 * Same inputs as bench/run.js. Reports what each provenance class prevents and what it
 * costs, by re-running the benchmark with that class of edge removed.
 *
 *   node bench/ablate.js --repo <path> --commits <file> --results <dir>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { runAblation, renderAblation } from '../lib/bench/ablation.js';
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
  console.error('usage: node bench/ablate.js --repo <path> --commits <file> --results <dir>');
  process.exit(2);
}

const git = (gitArgs) =>
  execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Indexing a tree is repeated across ablation runs, so results are memoised. */
const graphCache = new Map();

function indexAt(commit) {
  const cached = graphCache.get(commit);
  if (cached !== undefined) return cached;

  const facts = [];
  const files = [];
  for (const path of git(['ls-tree', '-r', '--name-only', commit]).split('\n')) {
    const trimmed = path.trim();
    if (trimmed === '' || !isModelledPath(trimmed)) continue;
    let contents;
    try {
      contents = git(['show', `${commit}:${trimmed}`]);
    } catch {
      continue;
    }
    const extracted = extractFile(trimmed, contents);
    if (extracted === null) continue;
    facts.push(extracted);
    files.push({
      path: trimmed,
      hash: hashContents(contents),
      parsedOk: extracted.parsedOk,
      extractor: extracted.extractor,
    });
  }
  const graph = buildGraph(
    files,
    facts,
    { root: repo, sourcePaths: ['.'], namespace: 'c' },
    currentGenerator(),
    new Date(0).toISOString(),
  );
  graphCache.set(commit, graph);
  return graph;
}

function parentOf(commit) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resultsFor(commit) {
  for (const ext of ['.json', '.xml']) {
    const path = join(resultsDir, `${commit}${ext}`);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  if (!existsSync(resultsDir)) return null;
  const match = readdirSync(resultsDir).find((n) => n.startsWith(commit.slice(0, 7)));
  return match === undefined ? null : readFileSync(join(resultsDir, match), 'utf8');
}

const commits = readFileSync(commitsFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

// entryPointPolicy dominates the measurement when left at its default: with `full`, any
// commit touching an entry point degrades to a full run and no graph edge can matter.
// `--policy strict` isolates what the graph itself contributes.
const config = {
  ...DEFAULT_CONFIG,
  entryPointPolicy: args.policy ?? DEFAULT_CONFIG.entryPointPolicy,
  maxReductionPercent: 100,
};
console.log(`entryPointPolicy: ${config.entryPointPolicy}`);
console.log('');
const result = runAblation({ indexAt, git, resultsFor, parentOf }, { commits, config });
console.log(renderAblation(result));

// Edge census for the most recent indexed tree, so the reader can see what was available
// to ablate rather than inferring it from the table.
const head = commits[commits.length - 1];
const parent = head === undefined ? null : parentOf(head);
if (parent !== null) {
  const counts = {};
  for (const edge of indexAt(parent).edges) counts[edge.provenance] = (counts[edge.provenance] ?? 0) + 1;
  console.log('');
  console.log(`Edge census at ${parent.slice(0, 10)}: ${JSON.stringify(counts)}`);
}

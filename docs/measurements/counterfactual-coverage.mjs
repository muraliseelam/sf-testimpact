#!/usr/bin/env node
/**
 * How often the policy counterfactual can actually help.
 *
 * The shipped default falls back on every commit in the measured window, so a user's first
 * experience is a full test run. `analyze` now reports what `entryPointPolicy: widen` would
 * have selected, but only when `entry-point-policy-full` was the *sole* cause of the
 * fallback — offering it otherwise would point someone at a setting that cannot help.
 *
 * This measures that narrowness against the same 30-commit apex-recipes window the rest of
 * the README uses, so the result is comparable with the existing selection-quality numbers:
 * on how many commits is the counterfactual offered, on how many is it correctly withheld,
 * and when offered, does its predicted number match a real `widen` run?
 *
 *   node counterfactual-coverage.mjs --repo <path> --commits 30 --sourcePaths force-app
 */

import { execFileSync } from 'node:child_process';

const LIB = 'file:///C:/EB1A/repos/sf-testimpact/lib';
const { buildGraph, currentGenerator, hashContents } = await import(`${LIB}/graph/store.js`);
const { extractFile, isModelledPath } = await import(`${LIB}/extract/index.js`);
const { analyze } = await import(`${LIB}/query/analyze.js`);
const { gitChangedFiles } = await import(`${LIB}/query/changeSet.js`);
const { DEFAULT_CONFIG } = await import(`${LIB}/config/schema.js`);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const repo = args.repo;
const windowSize = Number(args.commits ?? 30);
const project = { root: repo, sourcePaths: (args.sourcePaths ?? 'force-app').split(','), namespace: 'c' };

const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

// maxReductionPercent is raised so the reduction circuit-breaker does not mask the policy
// behaviour under study. Everything else is the shipped default.
const DEFAULTS = { ...DEFAULT_CONFIG, maxReductionPercent: 100 };
const WIDEN = { ...DEFAULTS, entryPointPolicy: 'widen' };

function indexAt(commit) {
  const facts = [], files = [];
  for (const path of git(['ls-tree', '-r', '--name-only', commit]).split('\n')) {
    const p = path.trim();
    if (p === '' || !isModelledPath(p)) continue;
    let c;
    try { c = git(['show', `${commit}:${p}`]); } catch { continue; }
    const f = extractFile(p, c);
    if (f === null) continue;
    facts.push(f);
    files.push({ path: p, hash: hashContents(c), parsedOk: f.parsedOk, extractor: f.extractor });
  }
  return buildGraph(files, facts, project, currentGenerator(), new Date(0).toISOString());
}

const commits = git(['log', '--format=%H', '-n', String(windowSize * 6), '--', '*.cls', '*.trigger'])
  .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, windowSize).reverse();

const rows = [];
for (const commit of commits) {
  let parent;
  try { parent = execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
  catch { continue; }
  let graph, changed;
  // Index the commit itself: real usage indexes the branch tip and diffs against a base.
  try { graph = indexAt(commit); changed = gitChangedFiles(git, parent, commit); } catch { continue; }

  const def = analyze(graph, changed, DEFAULTS);
  const wid = analyze(graph, changed, WIDEN);
  const rules = [...new Set(def.decisions.filter((d) => d.level === 'fallback').map((d) => d.rule))];

  rows.push({
    commit: commit.slice(0, 8),
    defaultOutcome: def.outcome,
    fallbackRules: rules,
    offered: def.counterfactual !== undefined,
    predicted: def.counterfactual?.wouldSelect ?? null,
    totalTests: def.totalTests,
    actualWiden: wid.outcome === 'selected' ? wid.tests.length : null,
    widenOutcome: wid.outcome,
    namedEntryPoints: def.counterfactual?.assumesNoExternalCallerOf.length ?? 0,
  });
}

const fellBack = rows.filter((r) => r.defaultOutcome === 'full');
const offered = rows.filter((r) => r.offered);
const withheld = fellBack.filter((r) => !r.offered);
// The offer is only useful if the number it quotes is the number the user would get.
const mismatched = offered.filter((r) => r.predicted !== r.actualWiden);
// Withholding is correct exactly when widen would ALSO have fallen back.
const wronglyWithheld = withheld.filter((r) => r.widenOutcome === 'selected');

console.log(JSON.stringify({
  repo,
  commits: rows.length,
  defaultFallbacks: fellBack.length,
  counterfactualOffered: offered.length,
  counterfactualWithheld: withheld.length,
  predictionMismatches: mismatched.length,
  withheldButWidenWouldHaveHelped: wronglyWithheld.length,
  whenOffered: offered.length === 0 ? null : (() => {
    const widenTotal = offered.reduce((s, r) => s + (r.predicted ?? 0), 0);
    const fullTotal = offered.reduce((s, r) => s + r.totalTests, 0);
    return {
      testsTheDefaultRuns: fullTotal,
      testsWidenWouldRun: widenTotal,
      reductionPercent: fullTotal === 0 ? null : Math.round(((fullTotal - widenTotal) / fullTotal) * 1000) / 10,
    };
  })(),
  withheldRules: [...new Set(withheld.flatMap((r) => r.fallbackRules))],
  rows,
}, null, 2));

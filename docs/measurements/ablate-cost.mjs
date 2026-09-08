#!/usr/bin/env node
/**
 * Provenance ablation, cost side only, against a real repository.
 *
 * The full DESIGN.md 11.2 ablation reports both what a provenance class PREVENTS (false
 * negatives) and what it COSTS (extra tests). The prevention side needs per-commit
 * historical test results, which no public repo publishes, so this measures only the cost:
 * how many tests each class causes to be selected, and how many edges it contributes.
 *
 * That half is still decisive for one question: a class that costs nothing AND contributes
 * no edges to any selection cannot be preventing anything either.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LIB = 'file:///C:/EB1A/repos/sf-testimpact/lib';
const { ImpactGraph } = await import(`${LIB}/graph/model.js`);
const { buildGraph, currentGenerator, hashContents } = await import(`${LIB}/graph/store.js`);
const { extractFile, isModelledPath } = await import(`${LIB}/extract/index.js`);
const { analyze } = await import(`${LIB}/query/analyze.js`);
const { gitChangedFiles } = await import(`${LIB}/query/changeSet.js`);
const { DEFAULT_CONFIG } = await import(`${LIB}/config/schema.js`);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const repo = args.repo;
const windowSize = Number(args.commits ?? 20);
const EXCLUDES = (args.exclude ?? '').split(',').filter(Boolean);
const CONFIG = {
  ...DEFAULT_CONFIG,
  excludeFromImpact: EXCLUDES,
  entryPointPolicy: args.policy ?? 'widen',
  maxReductionPercent: 100,
};

const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
// Source paths must match the project's own sfdx-project.json, as every other measurement
// here does. Walking the repository root instead classifies CI config and documentation as
// unmodelled project metadata, which inflates the fallback count this ablation reports.
const project = { root: repo, sourcePaths: (args.sourcePaths ?? '.').split(','), namespace: 'c' };

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

const withoutEdges = (g, keep) =>
  new ImpactGraph({
    nodes: g.nodes,
    edges: g.edges.filter(keep),
    taints: g.taints, unresolved: g.unresolved, files: g.files, facts: g.facts,
    project: g.project, generator: g.generator, createdAt: g.createdAt,
  });

const without = (g, provenance) => withoutEdges(g, (e) => e.provenance !== provenance);

// Ablating by edge KIND as well as provenance. Provenance answers "was parsing Apex worth
// it"; every Apex-derived edge shares `ast`, so it cannot price one relationship against
// another. Kind can: it is how the cost of, say, DML edges is measured rather than argued.
const withoutKind = (g, kind) => withoutEdges(g, (e) => e.kind !== kind);

const commits = git(['log', '--format=%H', '-n', String(windowSize * 6), '--', '*.cls', '*.trigger'])
  .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, windowSize).reverse();

const CLASSES = ['ast', 'xml', 'regex', 'widened'];
// The EdgeKind union from src/types.ts, in full. Kinds that contribute no edge in the
// window are dropped from the report rather than listed as zeroes.
const KINDS = ['extends', 'implements', 'refType', 'soqlRead', 'dml', 'describe', 'triggerOn',
  'memberOf', 'formulaRef', 'flowInvokes', 'flowTouches', 'grants', 'labelRef', 'permRef',
  'translates', 'usesResource'];
const totals = { baselineSelected: 0, baselineFallbacks: 0, commits: 0, edges: {}, kindEdges: {} };
for (const c of CLASSES) totals[c] = { selected: 0, fallbacks: 0 };
for (const k of KINDS) totals[`kind:${k}`] = { selected: 0, fallbacks: 0 };

for (const commit of commits) {
  let parent;
  try { parent = execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
  catch { continue; }
  let g, changed;
  try { g = indexAt(parent); changed = gitChangedFiles(git, parent, commit); } catch { continue; }

  for (const e of g.edges) {
    totals.edges[e.provenance] = (totals.edges[e.provenance] ?? 0) + 1;
    totals.kindEdges[e.kind] = (totals.kindEdges[e.kind] ?? 0) + 1;
  }

  const base = analyze(g, changed, CONFIG);
  totals.commits++;
  totals.baselineSelected += base.outcome === 'full' ? base.totalTests : base.tests.length;
  if (base.outcome === 'full') totals.baselineFallbacks++;

  for (const cls of CLASSES) {
    const r = analyze(without(g, cls), changed, CONFIG);
    totals[cls].selected += r.outcome === 'full' ? r.totalTests : r.tests.length;
    if (r.outcome === 'full') totals[cls].fallbacks++;
  }
  for (const k of KINDS) {
    const r = analyze(withoutKind(g, k), changed, CONFIG);
    totals[`kind:${k}`].selected += r.outcome === 'full' ? r.totalTests : r.tests.length;
    if (r.outcome === 'full') totals[`kind:${k}`].fallbacks++;
  }
}

const rows = CLASSES.map((c) => ({
  provenance: c,
  edgesAcrossWindow: totals.edges[c] ?? 0,
  selectedWithout: totals[c].selected,
  extraTestsCost: totals.baselineSelected - totals[c].selected,
  fallbacksWithout: totals[c].fallbacks,
}));

const kindRows = KINDS.map((k) => ({
  kind: k,
  edgesAcrossWindow: totals.kindEdges[k] ?? 0,
  selectedWithout: totals[`kind:${k}`].selected,
  extraTestsCost: totals.baselineSelected - totals[`kind:${k}`].selected,
  fallbacksWithout: totals[`kind:${k}`].fallbacks,
})).filter((r) => r.edgesAcrossWindow > 0);

console.log(JSON.stringify({
  repo, commits: totals.commits, policy: CONFIG.entryPointPolicy,
  baselineSelected: totals.baselineSelected, baselineFallbacks: totals.baselineFallbacks,
  rows, kindRows,
  falseNegativesPrevented: null,
  falseNegativesReason: 'Requires per-commit historical Apex test results, which no public repository publishes.',
}, null, 2));

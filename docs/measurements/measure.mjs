#!/usr/bin/env node
/**
 * Measurement harness for README figures.
 *
 * Every number printed is observed from a real run against a real repository. Nothing is
 * estimated. Where a figure cannot be measured, it is reported as unmeasurable with the
 * reason, never filled in.
 *
 *   node measure.mjs --repo <path> --label <name> [--commits N]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { gunzipSync } from 'node:zlib';

const LIB = 'file:///C:/EB1A/repos/sf-testimpact/lib';
const { runIndex } = await import(`${LIB}/pipeline/index.js`);
const { graphPath, loadGraph, hashContents, buildGraph, currentGenerator } = await import(`${LIB}/graph/store.js`);
const { extractFile, isModelledPath } = await import(`${LIB}/extract/index.js`);
const { analyze } = await import(`${LIB}/query/analyze.js`);
const { gitChangedFiles } = await import(`${LIB}/query/changeSet.js`);
const { DEFAULT_CONFIG } = await import(`${LIB}/config/schema.js`);

let out_excludes = [];
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const repo = args.repo;
const label = args.label ?? repo;
const windowSize = Number(args.commits ?? 40);

const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

// Same convention as the shipped command: repo-relative walker paths and root-joined store
// paths both resolve against the project root.
const at = (p) => resolvePath(repo, p);
// The adapter must expose the SAME capabilities as the shipped command. An adapter without
// `writeBytes`/`rename` silently measures the fallback paths (plain JSON, copy-instead-of-
// rename) that no real user hits, and would report an uncompressed graph size for a project
// that ships a gzipped one.
const nodeFs = {
  readFile: (p) => readFileSync(at(p), 'utf8'),
  readBytes: (p) => readFileSync(at(p)),
  writeFile: (p, c) => writeFileSync(at(p), c, 'utf8'),
  writeBytes: (p, b) => writeFileSync(at(p), b),
  rename: (from, to) => renameSync(at(from), at(to)),
  remove: (p) => rmSync(at(p), { force: true }),
  mkdirp: (p) => mkdirSync(at(p), { recursive: true }),
  exists: (p) => existsSync(at(p)),
};

function walker(root) {
  const skip = new Set(['node_modules', '.git', '.sf-testimpact', '.sfdx', '.sf']);
  return () => {
    const out = [];
    const visit = (dir) => {
      let entries;
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (skip.has(e)) continue;
        const full = join(dir, e);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) visit(full);
        else out.push(relative(root, full).replace(/\\/g, '/'));
      }
    };
    for (const sp of project.sourcePaths) visit(join(root, sp));
    return out;
  };
}

const project = { root: repo, sourcePaths: (args.sourcePaths ?? '.').split(','), namespace: 'c' };
const EXCLUDES = (args.exclude ?? '').split(',').filter(Boolean);
const CONFIG = { ...DEFAULT_CONFIG, excludeFromImpact: EXCLUDES,
  entryPointPolicy: args.policy ?? DEFAULT_CONFIG.entryPointPolicy,
  maxReductionPercent: 100 };
out_excludes = EXCLUDES;
const out = { label, repo, hardware: { cpus: cpus().length, model: cpus()[0]?.model?.trim(), memGB: Math.round(totalmem() / 1e9) } };
out.head = git(['rev-parse', 'HEAD']).trim();
out.headDate = git(['log', '-1', '--format=%cI']).trim();

// ---- full index ------------------------------------------------------------------------
rmSync(join(repo, '.sf-testimpact'), { recursive: true, force: true });
let t = process.hrtime.bigint();
const full = runIndex({ fs: nodeFs, walk: walker(repo), now: () => new Date(0) }, { root: repo, project, force: true });
out.fullIndexMs = Number(process.hrtime.bigint() - t) / 1e6;
out.indexedFiles = full.graph.files.length;
out.extracted = full.extracted;
out.nodes = full.graph.nodes.length;
out.edges = full.graph.edges.length;
out.taints = full.graph.taints.length;
out.unparseable = full.graph.files.filter((f) => !f.parsedOk).length;
// `full.path` is the form actually written; above 8 MB that is `graph.json.gz`.
out.graphPath = full.path;
out.graphGzipped = full.path.endsWith('.gz');
out.graphBytes = statSync(full.path).size;
out.graphBytesUncompressed = Buffer.byteLength(
  out.graphGzipped ? gunzipSync(readFileSync(full.path)) : readFileSync(graphPath(repo)),
);

const prov = {};
for (const e of full.graph.edges) prov[e.provenance] = (prov[e.provenance] ?? 0) + 1;
out.edgesByProvenance = prov;
const kinds = {};
for (const n of full.graph.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
out.nodesByKind = kinds;
out.testClasses = full.graph.nodes.filter((n) => (n.flags & 1) !== 0).length;

// ---- incremental index (touch one class) ------------------------------------------------
const someClass = full.graph.files.find((f) => f.path.endsWith('.cls'));
if (someClass) {
  const p = join(repo, someClass.path);
  const original = readFileSync(p, 'utf8');
  writeFileSync(p, `${original}\n// measurement touch\n`, 'utf8');
  t = process.hrtime.bigint();
  const inc = runIndex({ fs: nodeFs, walk: walker(repo), now: () => new Date(0) }, { root: repo, project });
  out.incrementalIndexMs = Number(process.hrtime.bigint() - t) / 1e6;
  out.incrementalReExtracted = inc.extracted;
  out.incrementalReused = inc.reused;
  writeFileSync(p, original, 'utf8');
  runIndex({ fs: nodeFs, walk: walker(repo), now: () => new Date(0) }, { root: repo, project });
}

// ---- load + analyze -----------------------------------------------------------------------
t = process.hrtime.bigint();
const loaded = loadGraph(nodeFs, repo);
out.loadMs = Number(process.hrtime.bigint() - t) / 1e6;

// ---- reduction / fallback over a window of real commits ------------------------------------
// Index at c^ from git blobs (no checkout), then analyze c^..c. This is the harness path.
const cache = new Map();
function indexAt(commit) {
  if (cache.has(commit)) return cache.get(commit);
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
  const g = buildGraph(files, facts, project, currentGenerator(), new Date(0).toISOString());
  cache.set(commit, g);
  return g;
}

const touching = git(['log', '--format=%H', '-n', String(windowSize * 6), '--', '*.cls', '*.trigger'])
  .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, windowSize).reverse();

const rows = [];
let analyzeTotalMs = 0, analyzeCount = 0;
for (const commit of touching) {
  let parent;
  try { parent = execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
  catch { continue; }
  // Which tree to index matters and is easy to get wrong. Real usage indexes the CURRENT
  // branch tip and then diffs against a base, so files added on the branch ARE in the index.
  // Indexing the parent instead simulates "what could the tool have known beforehand", which
  // reports every added file as missing from the index. Both are measured; `--indexAt head`
  // is the one that matches how the tool is actually run.
  const indexRev = (args.indexAt ?? 'parent') === 'head' ? commit : parent;
  let g, changed;
  try { g = indexAt(indexRev); changed = gitChangedFiles(git, parent, commit); }
  catch { continue; }
  const a0 = process.hrtime.bigint();
  const r = analyze(g, changed, CONFIG);
  analyzeTotalMs += Number(process.hrtime.bigint() - a0) / 1e6;
  analyzeCount++;
  const fb = r.decisions.find((d) => d.level === 'fallback');
  rows.push({ commit, changedFiles: changed.length, outcome: r.outcome, selected: r.tests.length, total: r.totalTests,
              reduction: r.outcome === 'full' ? 0 : r.reductionPercent,
              rule: fb?.rule ?? null, subject: fb?.subject ?? null });
  cache.clear(); // bound memory
}

out.window = { commits: rows.length, analyzeMeanMs: analyzeCount ? analyzeTotalMs / analyzeCount : null };
const selectedRows = rows.filter((r) => r.outcome === 'selected');
out.window.fallbacks = rows.length - selectedRows.length;
out.window.fallbackRatePercent = rows.length ? ((rows.length - selectedRows.length) / rows.length) * 100 : null;
out.window.meanReductionSelectedOnly = selectedRows.length
  ? selectedRows.reduce((s, r) => s + r.reduction, 0) / selectedRows.length : null;
const totalSel = rows.reduce((s, r) => s + (r.outcome === 'full' ? r.total : r.selected), 0);
const totalAvail = rows.reduce((s, r) => s + r.total, 0);
out.window.overallReductionPercent = totalAvail ? ((totalAvail - totalSel) / totalAvail) * 100 : null;
out.window.totalSelected = totalSel;
out.window.totalAvailable = totalAvail;
const ruleCounts = {};
for (const r of rows) if (r.rule) ruleCounts[r.rule] = (ruleCounts[r.rule] ?? 0) + 1;
out.window.fallbackRules = ruleCounts;
out.excludeFromImpact = out_excludes;
out.entryPointPolicy = CONFIG.entryPointPolicy;
out.indexAt = args.indexAt ?? 'parent';
const subjExt = {};
for (const r of rows) {
  if (r.rule !== 'unmodelled-file-type' || !r.subject) continue;
  const base = r.subject.split('/').pop() ?? r.subject;
  const m = /(\.[A-Za-z0-9]+(?:-meta\.xml)?)$/.exec(base);
  const k = m ? m[1] : base;
  subjExt[k] = (subjExt[k] ?? 0) + 1;
}
out.window.unmodelledExtensions = subjExt;
out.window.fallbackSubjects = rows.filter((r) => r.rule).slice(0, 12).map((r) => `${r.rule}: ${r.subject}`);

out.falseNegatives = null;
out.falseNegativesReason =
  'Not measurable: computing it requires per-commit historical Apex test results ' +
  '(passed at c^, failed at c). No public Salesforce repository publishes those, and ' +
  'producing them would require running each commit against a real org.';

console.log(JSON.stringify(out, null, 2));

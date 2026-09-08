#!/usr/bin/env node
/**
 * Index timing, repeated, one fresh process per timed run.
 *
 * A single stopwatch reading is not a measurement. The README previously quoted one
 * full-index and one incremental-index time per repository, which made ordinary run-to-run
 * variance look like a property of the code.
 *
 * Each timed run happens in a NEW node process, because that is how the tool is actually
 * invoked: `sf testimpact index` pays module load, ANTLR parser construction and a cold JIT
 * every time. Timing repeated calls inside one warm process is a different measurement
 * entirely — on apex-recipes it reports ~0.5 s against ~2 s for a fresh process — and
 * quoting the warm figure would understate what a user waits for by a factor of four.
 *
 * The filesystem cache is NOT dropped between runs; doing so needs privileges this harness
 * does not assume. So these figures are warm-disk, cold-process, and the README says so.
 *
 *   node timing-variance.mjs --repo <path> --label <name> --sourcePaths force-app [--runs 5]
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve as resolvePath } from 'node:path';
import { cpus, totalmem } from 'node:os';

const LIB = 'file:///C:/EB1A/repos/sf-testimpact/lib';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const repo = args.repo;
const project = { root: repo, sourcePaths: (args.sourcePaths ?? '.').split(','), namespace: 'c' };

const at = (p) => resolvePath(repo, p);
/** Same capability set as the shipped command, so the measured path is the shipped path. */
const makeFs = () => ({
  readFile: (p) => readFileSync(at(p), 'utf8'),
  readBytes: (p) => readFileSync(at(p)),
  writeFile: (p, c) => writeFileSync(at(p), c, 'utf8'),
  writeBytes: (p, b) => writeFileSync(at(p), b),
  rename: (from, to) => renameSync(at(from), at(to)),
  remove: (p) => rmSync(at(p), { force: true }),
  mkdirp: (p) => mkdirSync(at(p), { recursive: true }),
  exists: (p) => existsSync(at(p)),
});

const skip = new Set(['node_modules', '.git', '.sf-testimpact', '.sfdx', '.sf']);
const makeWalk = () => () => {
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
      else out.push(relative(repo, full).replace(/\\/g, '/'));
    }
  };
  for (const sp of project.sourcePaths) visit(join(repo, sp));
  return out;
};

// ---- child mode: perform exactly one timed operation and print a JSON line ----------------
if (args.phase !== undefined) {
  const { runIndex } = await import(`${LIB}/pipeline/index.js`);
  const { loadGraph } = await import(`${LIB}/graph/store.js`);
  const fs = makeFs();
  const walk = makeWalk();
  const opts = { root: repo, project };

  if (args.phase === 'full') rmSync(join(repo, '.sf-testimpact'), { recursive: true, force: true });

  const t = process.hrtime.bigint();
  const value = args.phase === 'load'
    ? loadGraph(fs, repo)
    : runIndex({ fs, walk, now: () => new Date(0) }, args.phase === 'full' ? { ...opts, force: true } : opts);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;

  const detail = args.phase === 'load'
    ? { nodes: value.nodes.length, edges: value.edges.length }
    : {
        nodes: value.graph.nodes.length,
        edges: value.graph.edges.length,
        files: value.graph.files.length,
        extracted: value.extracted,
        reused: value.reused,
        path: value.path,
      };
  console.log(JSON.stringify({ ms, ...detail }));
  process.exit(0);
}

// ---- parent mode -------------------------------------------------------------------------
const runs = Number(args.runs ?? 5);
const self = fileURLToPath(import.meta.url);
const child = (phase) => JSON.parse(execFileSync(
  process.execPath,
  [self, '--repo', repo, '--sourcePaths', project.sourcePaths.join(','), '--phase', phase],
  { encoding: 'utf8' },
).trim());

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    runs: s.length,
    minMs: +s[0].toFixed(1),
    medianMs: +s[(s.length - 1) >> 1].toFixed(1),
    maxMs: +s[s.length - 1].toFixed(1),
    spreadPercent: +(((s[s.length - 1] - s[0]) / s[0]) * 100).toFixed(1),
  };
};

const out = {
  label: args.label ?? repo,
  repo,
  note: 'One fresh node process per timed run. Warm filesystem cache; the cache is not dropped between runs.',
  hardware: { cpus: cpus().length, model: cpus()[0]?.model?.trim(), memGB: Math.round(totalmem() / 1e9) },
  nodeVersion: process.version,
};

const fullMs = [];
for (let i = 0; i < runs; i++) {
  const r = child('full');
  fullMs.push(r.ms);
  out.indexedFiles = r.files;
  out.nodes = r.nodes;
  out.edges = r.edges;
  out.graphPath = r.path;
  out.graphBytes = statSync(r.path).size;
}
out.fullIndex = stats(fullMs);

// Incremental: touch one class before each run so exactly one file is genuinely re-extracted.
const { loadGraph } = await import(`${LIB}/graph/store.js`);
const graph = loadGraph(makeFs(), repo);
const relTarget = graph.files.find((f) => f.path.endsWith('.cls')).path;
const target = join(repo, relTarget);
const original = readFileSync(target, 'utf8');
const incMs = [];
try {
  for (let i = 0; i < runs; i++) {
    writeFileSync(target, `${original}\n// timing touch ${i}\n`, 'utf8');
    const r = child('incremental');
    incMs.push(r.ms);
    out.incrementalTouched = relTarget;
    out.incrementalReExtracted = r.extracted;
    out.incrementalReused = r.reused;
  }
} finally {
  writeFileSync(target, original, 'utf8');
  child('incremental');
}
out.incrementalIndex = stats(incMs);

const loadMs = [];
for (let i = 0; i < runs; i++) loadMs.push(child('load').ms);
out.loadGraph = stats(loadMs);

console.log(JSON.stringify(out, null, 2));

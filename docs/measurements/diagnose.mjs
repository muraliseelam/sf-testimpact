#!/usr/bin/env node
/**
 * Diagnose WHY commits fall back. Enumerates every changed path across a commit window and
 * classifies it, rather than recording only the first fallback decision per commit.
 *
 *   node diagnose.mjs --repo <path> --commits N [--sourcePaths force-app]
 */

import { execFileSync } from 'node:child_process';

const LIB = 'file:///C:/EB1A/repos/sf-testimpact/lib';
const { isModelledPath } = await import(`${LIB}/extract/index.js`);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const repo = args.repo;
const windowSize = Number(args.commits ?? 30);
const sourcePaths = (args.sourcePaths ?? 'force-app').split(',');

const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

const commits = git(['log', '--format=%H', '-n', String(windowSize * 6), '--', '*.cls', '*.trigger'])
  .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, windowSize).reverse();

const inSource = (p) => sourcePaths.some((sp) => p === sp || p.startsWith(`${sp}/`));
const extOf = (p) => {
  const base = p.split('/').pop() ?? p;
  const m = /(\.[A-Za-z0-9]+(?:-meta\.xml)?)$/.exec(base);
  return m ? m[1] : `(no ext) ${base}`;
};

const stats = {
  commits: 0,
  paths: 0,
  modelled: 0,
  unmodelledInSource: {},
  outsideSource: {},
  companionMetaWithIndexedBase: {},
  commitsWithAnyUnmodelledInSource: 0,
  commitsWithOnlyOutsideSourceNoise: 0,
};

for (const commit of commits) {
  let parent;
  try {
    parent = execFileSync('git', ['rev-parse', '--verify', `${commit}^1`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { continue; }

  let names;
  try { names = git(['diff', '--name-only', `${parent}...${commit}`]); } catch { continue; }
  const paths = names.split('\n').map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) continue;

  stats.commits++;
  let anyUnmodelledInSource = false;
  let anyRelevant = false;

  for (const p of paths) {
    stats.paths++;
    const ext = extOf(p);

    if (!inSource(p)) {
      stats.outsideSource[ext] = (stats.outsideSource[ext] ?? 0) + 1;
      continue;
    }
    anyRelevant = true;

    if (isModelledPath(p)) { stats.modelled++; continue; }

    // Is it a `-meta.xml` companion whose base file IS modelled and present at the parent?
    if (p.endsWith('-meta.xml')) {
      const base = p.replace(/-meta\.xml$/, '');
      if (isModelledPath(base)) {
        let exists = true;
        try { git(['cat-file', '-e', `${parent}:${base}`]); } catch { exists = false; }
        if (exists) {
          stats.companionMetaWithIndexedBase[ext] = (stats.companionMetaWithIndexedBase[ext] ?? 0) + 1;
          continue;
        }
      }
    }

    stats.unmodelledInSource[ext] = (stats.unmodelledInSource[ext] ?? 0) + 1;
    anyUnmodelledInSource = true;
  }

  if (anyUnmodelledInSource) stats.commitsWithAnyUnmodelledInSource++;
  else if (!anyRelevant) stats.commitsWithOnlyOutsideSourceNoise++;
}

const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
stats.unmodelledInSource = sortDesc(stats.unmodelledInSource);
stats.outsideSource = sortDesc(stats.outsideSource);
stats.companionMetaWithIndexedBase = sortDesc(stats.companionMetaWithIndexedBase);

console.log(JSON.stringify(stats, null, 2));

#!/usr/bin/env node
/**
 * Stage 4 of the false-negative harness: score a store written by `bench/execute.js`.
 *
 * Entirely offline. The store holds one outcome series; the selection under each
 * `entryPointPolicy` is recomputed here from git blobs, so the expensive half (the org runs)
 * is done once and scored three times. The scoring itself is `src/bench/falseNegatives.ts`
 * and the decision whether the data supports quoting a rate is `src/bench/fnReport.ts`;
 * neither is touched here.
 *
 *   node bench/fn-report.js --repo <path> --store <file>
 *                           [--out docs/measurements/false-negative-rate.json]
 *                           [--policies full,widen,strict] [--source-paths a,b]
 *                           [--min-denominator 30]
 *
 * The printed report and the JSON artifact say "not measurable from this data" when the
 * window produced fewer newly-failing pairs than `--min-denominator`. That output is correct
 * and complete; it is not a failure of the script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve as resolvePath } from 'node:path';

import { ObservationStore, loadStore } from '../lib/bench/observationStore.js';
import { renderFnReport, reportFromStore } from '../lib/bench/fnReport.js';
import { TOOL_VERSION } from '../lib/version.js';
import { makeIndexer, makeSelector, parseArgs } from './replay.js';

const args = parseArgs(process.argv);

function usage(problem) {
  if (problem !== undefined) console.error(`error: ${problem}`);
  console.error('usage: node bench/fn-report.js --repo <path> --store <file> [--out <file>]');
  console.error('       [--policies full,widen,strict] [--source-paths a,b] [--min-denominator 30]');
  process.exit(2);
}

const repo = typeof args.repo === 'string' ? resolvePath(args.repo) : undefined;
const storePath = typeof args.store === 'string' ? resolvePath(args.store) : undefined;
if (repo === undefined) usage('--repo is required');
if (storePath === undefined) usage('--store is required');
const outPath = resolvePath(typeof args.out === 'string' ? args.out : 'docs/measurements/false-negative-rate.json');
const policies = (typeof args.policies === 'string' ? args.policies : 'full,widen,strict').split(',').filter(Boolean);
for (const p of policies) if (!['full', 'widen', 'strict'].includes(p)) usage(`unknown policy ${p}`);
const minDenominator = args['min-denominator'] === undefined ? undefined : Number(args['min-denominator']);
const sourcePathsOverride =
  typeof args['source-paths'] === 'string' ? args['source-paths'].split(',').filter(Boolean) : undefined;

const fs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  appendFile: () => {
    throw new Error('fn-report.js never writes to the store');
  },
  exists: (p) => existsSync(p),
  mkdirp: () => undefined,
};

const contents = loadStore(fs, storePath);
if (contents === null) usage(`${storePath} does not exist`);
const store = new ObservationStore(fs, storePath, contents.window, contents.commits);
if (contents.truncatedTailDiscarded) {
  console.error('note: the store ends in a truncated line from an interrupted run; that commit is not scored.');
}

const scorable = contents.commits.filter((c) => c.excluded === undefined && c.baselineOnly !== true);
console.error(
  `store: ${contents.commits.length} commit(s) recorded, ${scorable.length} scorable, ` +
    `${contents.commits.filter((c) => c.excluded !== undefined).length} excluded, ` +
    `${contents.commits.filter((c) => c.baselineOnly === true).length} baseline-only`,
);

const indexAt = makeIndexer(repo, sourcePathsOverride);
const selectAt = makeSelector(repo, indexAt);

/** @type {Map<string, Map<string, {selected: readonly string[], fellBack: boolean, totalTests: number}>>} */
const selectionsByPolicy = new Map(policies.map((p) => [p, new Map()]));
for (const [i, commit] of scorable.entries()) {
  process.stderr.write(`\r  selecting ${i + 1}/${scorable.length}  ${commit.commit.slice(0, 10)}   `);
  for (const policy of policies) {
    selectionsByPolicy.get(policy).set(commit.commit, selectAt(commit.commit, policy));
  }
}
if (scorable.length > 0) process.stderr.write('\n');

const report = reportFromStore(store, selectionsByPolicy, minDenominator === undefined ? {} : { minDenominator });

console.log(renderFnReport(report));

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      toolVersion: TOOL_VERSION,
      store: relative(process.cwd(), storePath).replace(/\\/g, '/'),
      method: {
        execution: 'bench/execute.js: full RunLocalTests suite at every first-parent commit of the window, base executed as baseline',
        selection: 'bench/fn-report.js: index at each commit from git blobs, diff against first parent, analyze under each policy',
        scoring: 'src/bench/falseNegatives.ts via src/bench/fnReport.ts; rate withheld below minDenominator',
      },
      recorded: contents.commits.length,
      scorable: scorable.length,
      report,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);

#!/usr/bin/env node
/**
 * Search for a public Salesforce repository whose CI history contains real Apex test failures.
 *
 * The false-negative metric's numerator is built from tests that passed at `c^` and failed at
 * `c`. That requires a repository whose history actually contains failing Apex tests. This
 * script surveys candidate repositories' GitHub Actions history and reports, per repository:
 * how many recent runs contain a job that runs Apex tests, how often that job actually
 * executed rather than being skipped, and how many of those executions failed.
 *
 * It records a search, not a measurement. The output is evidence about data availability.
 *
 *   node fn-window-search.mjs --gh <path-to-gh> --limit 30
 *
 * Reproducing this needs `gh` authenticated against github.com. Every figure it prints comes
 * from `gh api repos/<owner>/<repo>/actions/runs[/<id>/jobs]`.
 */

import { execFileSync } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const GH = args.gh ?? 'gh';
const LIMIT = Number(args.limit ?? 30);

/**
 * Candidates: public repositories that contain Apex and run it in CI. Salesforce's own sample
 * gallery is the obvious pool, plus the two repositories this project already benchmarks.
 */
const CANDIDATES = [
  'trailheadapps/apex-recipes',
  'trailheadapps/dreamhouse-lwc',
  'trailheadapps/ebikes-lwc',
  'trailheadapps/lwc-recipes',
  'trailheadapps/coral-cloud',
  'trailheadapps/automation-components',
  'trailheadapps/easy-spaces-lwc',
  'SalesforceFoundation/NPSP',
];

/** A job that deploys to a scratch org and runs the Apex suite, by convention in these repos. */
const APEX_JOB = /scratch|apex|test/i;

function gh(pathAndQuery, jq) {
  const argv = ['api', pathAndQuery];
  if (jq !== undefined) argv.push('--jq', jq);
  try {
    return execFileSync(GH, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const results = [];

for (const repo of CANDIDATES) {
  const runsRaw = gh(`repos/${repo}/actions/runs?per_page=${LIMIT}`, '.workflow_runs[] | .id');
  if (runsRaw === null) {
    results.push({ repo, reachable: false, note: 'actions/runs not readable (no Actions, or no access)' });
    continue;
  }
  const runIds = runsRaw.split('\n').map((s) => s.trim()).filter(Boolean);

  let runsInspected = 0;
  let apexJobsPresent = 0;
  let apexJobsExecuted = 0;
  let apexJobsFailed = 0;
  const failedRunIds = [];

  for (const id of runIds) {
    const jobsRaw = gh(`repos/${repo}/actions/runs/${id}/jobs`, '.jobs[] | (.name + " :: " + (.conclusion // "null"))');
    if (jobsRaw === null) continue;
    runsInspected++;
    for (const line of jobsRaw.split('\n')) {
      const at = line.lastIndexOf(' :: ');
      if (at < 0) continue;
      const name = line.slice(0, at);
      const conclusion = line.slice(at + 4).trim();
      if (!APEX_JOB.test(name)) continue;
      apexJobsPresent++;
      if (conclusion === 'skipped') continue;
      apexJobsExecuted++;
      if (conclusion === 'failure') {
        apexJobsFailed++;
        if (failedRunIds.length < 10) failedRunIds.push({ runId: id, job: name });
      }
    }
  }

  results.push({
    repo,
    reachable: true,
    runsInspected,
    apexJobsPresent,
    apexJobsExecuted,
    apexJobsFailed,
    failedRunIds,
  });
}

console.log(JSON.stringify({
  queriedAt: new Date().toISOString(),
  runsPerRepo: LIMIT,
  method: 'gh api repos/<owner>/<repo>/actions/runs then .../jobs; job name matched /scratch|apex|test/i',
  caveat:
    'GitHub Actions retains run history for a limited window (90 days by default), so this ' +
    'observes only recent history. A job conclusion of "failure" is not by itself an Apex ' +
    'test failure: it can be a deploy error, an org-limit error or an infrastructure fault. ' +
    'Each failing run must be opened before it can be treated as a test failure.',
  results,
}, null, 2));

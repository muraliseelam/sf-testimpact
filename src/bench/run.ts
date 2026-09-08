/**
 * The benchmark orchestrator.
 *
 * For each historical commit `c`: index the tree at `c^`, analyze `c^..c`, and compare the
 * selection against what actually happened. All I/O is injected, so the loop itself is
 * unit-testable without cloning a repository.
 */

import { type Config } from '../config/schema.js';
import { type ImpactGraph } from '../graph/model.js';
import { analyze } from '../query/analyze.js';
import { gitChangedFiles, type GitRunner } from '../query/changeSet.js';
import { adapterById, detectAdapter, type TestResultAdapter, type TestOutcome } from './adapters.js';
import { summarise, type BenchmarkSummary, type CommitObservation } from './falseNegatives.js';

export interface BenchDeps {
  /** Checks out a commit and returns the graph indexed at that tree. */
  readonly indexAt: (commit: string) => ImpactGraph;
  readonly git: GitRunner;
  /** Historical results for a commit, as raw text, or null when none were recorded. */
  readonly resultsFor: (commit: string) => string | null;
  /** The commit's first parent, or null for a root commit. */
  readonly parentOf: (commit: string) => string | null;
}

export interface BenchOptions {
  readonly commits: readonly string[];
  readonly config: Config;
  /** Force a specific adapter instead of sniffing. */
  readonly adapterId?: string;
  readonly maxFlips?: number;
  /** Exclude edges of these provenance classes, for ablation (DESIGN.md 11.2). */
  readonly onProgress?: (done: number, total: number, commit: string) => void;
}

export interface BenchRun {
  readonly summary: BenchmarkSummary;
  readonly observations: readonly CommitObservation[];
  /** Commits skipped because no historical results were available. */
  readonly skipped: readonly string[];
  readonly adapterId: string | null;
}

function pickAdapter(contents: string, forced: string | undefined): TestResultAdapter | null {
  if (forced !== undefined) return adapterById(forced) ?? null;
  return detectAdapter(contents);
}

export function runBenchmark(deps: BenchDeps, options: BenchOptions): BenchRun {
  const observations: CommitObservation[] = [];
  const skipped: string[] = [];
  let adapterId: string | null = null;

  for (const [i, commit] of options.commits.entries()) {
    options.onProgress?.(i + 1, options.commits.length, commit);

    const raw = deps.resultsFor(commit);
    if (raw === null) {
      // Without results for a commit there is nothing to check the selection against. It is
      // recorded rather than dropped, so the report can say how much evidence it had.
      skipped.push(commit);
      continue;
    }

    const adapter = pickAdapter(raw, options.adapterId);
    if (adapter === null) {
      skipped.push(commit);
      continue;
    }
    adapterId ??= adapter.id;

    let results: readonly TestOutcome[];
    try {
      results = adapter.parse(raw).results;
    } catch {
      skipped.push(commit);
      continue;
    }

    const parent = deps.parentOf(commit);
    if (parent === null) {
      // A root commit has no `c^` to diff against, so there is no selection to evaluate.
      // Its outcomes are still recorded, because the *next* commit needs them as its
      // predecessor state — dropping it would silently stop that commit's regressions from
      // being counted at all.
      observations.push({
        commit,
        results,
        selected: [],
        fellBack: false,
        totalTests: 0,
        baselineOnly: true,
      });
      continue;
    }

    const graph = deps.indexAt(parent);
    const changed = gitChangedFiles(deps.git, parent, commit);
    const analysis = analyze(graph, changed, options.config);

    observations.push({
      commit,
      results,
      selected: analysis.tests.map((t) => t.name),
      fellBack: analysis.outcome === 'full',
      totalTests: analysis.totalTests,
    });
  }

  const summaryOptions = options.maxFlips === undefined ? {} : { maxFlips: options.maxFlips };
  return {
    summary: summarise(observations, summaryOptions),
    observations,
    skipped,
    adapterId,
  };
}

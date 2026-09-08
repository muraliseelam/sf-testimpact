/**
 * The `analyze --json` contract.
 *
 * **This shape is a public API.** CI pipelines gate deployments on it, so it is versioned:
 * `schemaVersion` is bumped on any breaking change, and fields are only ever added within a
 * version. A consumer that reads `schemaVersion` and finds a number it does not recognise
 * should refuse to interpret the rest rather than guess.
 */

import { type AnalysisResult } from '../query/analyze.js';
import { type ImpactGraph } from '../graph/model.js';

/** Bump on any removal or meaning change. Additions within a version are allowed. */
export const ANALYZE_SCHEMA_VERSION = 1;

export interface AnalyzeJsonTest {
  readonly name: string;
  readonly reason: 'impacted' | 'always-run' | 'see-all-data';
}

export interface AnalyzeJsonDecision {
  readonly level: 'fallback' | 'widen' | 'info';
  readonly rule: string;
  readonly subject: string;
  readonly message: string;
  readonly hint: string | null;
}

export interface AnalyzeJson {
  readonly schemaVersion: number;
  readonly toolVersion: string;
  /** `selected` means the test list is authoritative; `full` means run everything. */
  readonly outcome: 'selected' | 'full';
  /** The `--test-level` to deploy with. */
  readonly testLevel: string;
  readonly tests: readonly AnalyzeJsonTest[];
  readonly selectedCount: number;
  readonly totalTests: number;
  readonly reductionPercent: number;
  readonly decisions: readonly AnalyzeJsonDecision[];
  /** True when any decision forced a full run. The single field CI should branch on. */
  readonly fellBack: boolean;
  readonly activatedTaintDomains: readonly string[];
  /** Changed classes no test reaches — a deploy hazard whatever the selection. */
  readonly coverageGaps: readonly string[];
  readonly range: { readonly base: string; readonly head: string };
  readonly changedFiles: number;
  readonly graph: {
    readonly nodes: number;
    readonly edges: number;
    readonly createdAt: string;
    readonly indexedFiles: number;
  };
}

export interface AnalyzeJsonInput {
  readonly result: AnalysisResult;
  readonly graph: ImpactGraph;
  readonly base: string;
  readonly head: string;
  readonly changedFiles: number;
}

export function toAnalyzeJson(input: AnalyzeJsonInput): AnalyzeJson {
  const { result, graph } = input;
  return {
    schemaVersion: ANALYZE_SCHEMA_VERSION,
    toolVersion: graph.generator.toolVersion,
    outcome: result.outcome,
    testLevel: result.testLevel,
    tests: result.tests.map((t) => ({ name: t.name, reason: t.reason })),
    selectedCount: result.tests.length,
    totalTests: result.totalTests,
    // Rounded to two places: an unrounded float here produces noisy CI diffs and invites
    // consumers to compare it for equality.
    reductionPercent: Math.round(result.reductionPercent * 100) / 100,
    decisions: result.decisions.map((d) => ({
      level: d.level,
      rule: d.rule,
      subject: d.subject,
      message: d.message,
      hint: d.hint ?? null,
    })),
    fellBack: result.outcome === 'full',
    activatedTaintDomains: [...result.activatedDomains],
    coverageGaps: [...result.coverageGaps],
    range: { base: input.base, head: input.head },
    changedFiles: input.changedFiles,
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      createdAt: graph.createdAt,
      indexedFiles: graph.files.length,
    },
  };
}

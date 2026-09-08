/**
 * Public programmatic API.
 *
 * The package is primarily an `sf` CLI plugin — oclif loads the commands under
 * `lib/commands` directly and never imports this file. It exists so that `main`, `types`
 * and `exports` in package.json point at something real, and so a consumer can drive the
 * analysis from code without shelling out to the CLI.
 *
 * Deliberately does not re-export anything under `bench/`: the benchmark harness is
 * development tooling and is excluded from the published tarball.
 */

// -- Core domain types ------------------------------------------------------------------
export {
  DEFAULT_NAMESPACE,
  NodeFlags,
  STANDARD_NAMESPACE,
  UNKNOWN_OBJECT,
  formatLoc,
  hasFlag,
  makeNodeKey,
} from './types.js';
export type {
  DeclaredType,
  Diagnostic,
  EdgeKind,
  EntryPointKind,
  FileFacts,
  GraphEdge,
  GraphNode,
  NodeKey,
  NodeKind,
  Provenance,
  RawReference,
  RawReferenceKind,
  RawTaint,
  SourceLoc,
  TaintDomain,
  TaintRecord,
  UnresolvedDisposition,
  UnresolvedRef,
} from './types.js';

// -- Errors -----------------------------------------------------------------------------
export { ConfigError, ExtractorError, TestImpactError } from './errors.js';
export type { ErrorCode } from './errors.js';

// -- Configuration ----------------------------------------------------------------------
export { parseConfig } from './config/load.js';
export {
  DEFAULT_CONFIG,
  ENTRY_POINT_POLICIES,
  FULL_TEST_LEVELS,
  ON_EXCEED_VALUES,
  TAINT_ACTIONS,
} from './config/schema.js';
export type { Config, EntryPointPolicy, OnExceed, TaintAction, TaintConfig } from './config/schema.js';
export { loadConfig, loadProject } from './project.js';

// -- Extraction -------------------------------------------------------------------------
export {
  ALL_EXTRACTOR_IDS,
  extractApex,
  extractFile,
  extractorFor,
  isModelledPath,
  staticResourceOwnerOf,
} from './extract/index.js';
export type { Extractor } from './extract/index.js';

// -- Resolution and the graph -----------------------------------------------------------
export { resolve } from './resolve/resolver.js';
export type { ResolveOptions, ResolveResult } from './resolve/resolver.js';
export { SymbolTable, isCustomApiName, namespaceForMetadata } from './resolve/symbolTable.js';
export { ImpactGraph, domainsOf } from './graph/model.js';
export type { GraphGenerator, IndexedFile, ProjectInfo, ReverseAdjacency } from './graph/model.js';
export {
  buildGraph,
  checkStaleness,
  currentGenerator,
  graphPath,
  hashBytes,
  hashContents,
  loadGraph,
  saveGraph,
} from './graph/store.js';
export type { FileSystem, StalenessReason } from './graph/store.js';
export {
  filesToExtract,
  mergeFacts,
  mergeFiles,
  planReindex,
} from './graph/incremental.js';
export type { ReindexPlan, ScannedFile } from './graph/incremental.js';

// -- Indexing ---------------------------------------------------------------------------
export { runIndex } from './pipeline/index.js';
export type { FileWalker, IndexDeps, IndexOptions, IndexResult } from './pipeline/index.js';

// -- Query ------------------------------------------------------------------------------
export { analyze, formatDecisions } from './query/analyze.js';
export type { AnalysisResult, Outcome } from './query/analyze.js';
export { componentPathFor, gitChangedFiles, resolveChangeSet } from './query/changeSet.js';
export type { ChangeKind, ChangeSet, ChangedFile, GitRunner, UnmappedFile } from './query/changeSet.js';
export { computeImpacted, computeReachable } from './query/closure.js';
export type { ClosureResult } from './query/closure.js';
export { allTestClasses, coverageGaps, coveringTests, selectTests } from './query/selection.js';
export type { Selection, SelectedTest, SelectionReason } from './query/selection.js';
export { applyEntryPointPolicy, checkFallbacks, checkReduction } from './query/safety.js';
export type { Decision, DecisionLevel, EntryPointOutcome } from './query/safety.js';

// -- Deployment -------------------------------------------------------------------------
export { buildDeployPlan } from './deploy/plan.js';
export type { DeployPlan } from './deploy/plan.js';
export {
  COVERAGE_FLOOR_PERCENT,
  coveragePercent,
  findCoverageRegressions,
  payloadClasses,
  verifyCoverage,
} from './deploy/coverage.js';
export type { CoverageBlocker, CoverageClient, CoverageRow, VerifyCoverageResult } from './deploy/coverage.js';

// -- Reporting --------------------------------------------------------------------------
export { ANALYZE_SCHEMA_VERSION, toAnalyzeJson } from './report/json.js';
export type { AnalyzeJson, AnalyzeJsonDecision, AnalyzeJsonInput, AnalyzeJsonTest } from './report/json.js';

// -- Versioning -------------------------------------------------------------------------
export { APEX_PARSER_VERSION, GRAPH_FORMAT_VERSION, TOOL_VERSION, majorVersion } from './version.js';

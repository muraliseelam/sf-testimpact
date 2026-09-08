/**
 * `.sf-testimpact.yml` schema and defaults (DESIGN.md section 8).
 *
 * Validation is hand-written rather than delegated to a schema library. The config is small
 * and fixed, and hand-written checks let each message name the offending key and the legal
 * values — which is the whole point of validating.
 */

/** How to handle a class whose callers may live outside this repo (DESIGN.md 6.3). */
export type EntryPointPolicy = 'full' | 'widen' | 'strict';

/** What to do when selection would skip more than `maxReductionPercent` of tests. */
export type OnExceed = 'warn' | 'fail' | 'runAll';

/** How far to degrade for a given class of unknown (DESIGN.md 6.2, 6.5). */
export type TaintAction = 'full' | 'widen';

export interface TaintConfig {
  readonly onParseError: TaintAction;
  readonly dynamicApex: TaintAction;
  readonly dynamicSoql: TaintAction;
  readonly unmodelledFileType: TaintAction;
}

export interface Config {
  readonly version: 1;
  /** Defaults to the `packageDirectories` from sfdx-project.json. */
  readonly sourcePaths: readonly string[];
  readonly alwaysRun: readonly string[];
  readonly excludeFromImpact: readonly string[];
  readonly maxReductionPercent: number;
  readonly onExceed: OnExceed;
  readonly entryPointPolicy: EntryPointPolicy;
  readonly taint: TaintConfig;
  /** Test level used by every fallback path. */
  readonly fullTestLevel: string;
}

/**
 * `entryPointPolicy` defaults to `full` because a tool that skips tests has to earn that
 * right. A new user's first `analyze` should be visibly conservative; teams opt down to
 * `widen` once the benchmark has convinced them. See DESIGN.md 6.3.
 */
export const DEFAULT_CONFIG: Config = {
  version: 1,
  sourcePaths: [],
  alwaysRun: [],
  excludeFromImpact: [],
  maxReductionPercent: 95,
  onExceed: 'warn',
  entryPointPolicy: 'full',
  taint: {
    onParseError: 'full',
    dynamicApex: 'widen',
    dynamicSoql: 'widen',
    unmodelledFileType: 'full',
  },
  fullTestLevel: 'RunLocalTests',
};

export const ENTRY_POINT_POLICIES: readonly EntryPointPolicy[] = ['full', 'widen', 'strict'];
export const ON_EXCEED_VALUES: readonly OnExceed[] = ['warn', 'fail', 'runAll'];
export const TAINT_ACTIONS: readonly TaintAction[] = ['full', 'widen'];

/** Valid `--test-level` values accepted by `sf project deploy start` for a fallback run. */
export const FULL_TEST_LEVELS: readonly string[] = [
  'NoTestRun',
  'RunSpecifiedTests',
  'RunLocalTests',
  'RunAllTestsInOrg',
];

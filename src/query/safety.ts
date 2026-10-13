/**
 * The safety layer: fallbacks, entry-point policy and the reduction circuit breaker
 * (DESIGN.md 6.3, 6.5, 8).
 *
 * Every decision here produces a log entry naming the rule that fired and the file or node
 * that caused it. Silent degradation is a bug: if the tool decides to run everything, the
 * user must be able to see exactly why in one line.
 */

import { type Config, type TaintConfig } from '../config/schema.js';
import { PARSE_FAILURE_CAUSE } from '../extract/apex.js';
import { checkStaleness } from '../graph/store.js';
import { type ImpactGraph } from '../graph/model.js';
import { NodeFlags, hasFlag, type EntryPointKind, type NodeKey, type TaintDomain } from '../types.js';
import { type ChangeSet } from './changeSet.js';

export type DecisionLevel = 'fallback' | 'widen' | 'info';

export interface Decision {
  readonly level: DecisionLevel;
  /** Stable identifier for the rule, suitable for asserting on and for grep. */
  readonly rule: string;
  /** The file or node that triggered it. */
  readonly subject: string;
  readonly message: string;
  /** What the user could change, when there is a real trade to offer. */
  readonly hint?: string;
  /**
   * Every subject the rule fired on, when there is more than one.
   *
   * `subject` names only the first, which is enough to identify the rule but not enough to
   * act on it: a reader deciding whether to accept `entryPointPolicy: widen` needs the whole
   * list of entry points whose external callers they are being asked to rule out, not a
   * sample of one.
   */
  readonly subjects?: readonly string[];
}

/** Recognised extensions: anything else is metadata we do not model. */
const MODELLED_EXTENSIONS = /\.(cls|trigger|object-meta\.xml|field-meta\.xml|flow-meta\.xml|permissionset-meta\.xml|labels-meta\.xml|customPermission-meta\.xml|translation-meta\.xml|js|html)$/i;

/**
 * Reasons the whole run must degrade to the configured full test level.
 *
 * Checked before the closure runs, because none of them depend on it.
 */
export function checkFallbacks(
  graph: ImpactGraph,
  changeSet: ChangeSet,
  config: Config,
): Decision[] {
  const decisions: Decision[] = [];

  const stale = checkStaleness(graph);
  if (stale !== null) {
    decisions.push({
      level: 'fallback',
      rule: stale.rule,
      subject: '.sf-testimpact/graph.json',
      message: stale.message,
      hint: stale.remedy,
    });
  }

  for (const file of changeSet.unmapped) {
    switch (file.reason) {
      case 'project-config':
        decisions.push({
          level: 'fallback',
          rule: 'project-config-changed',
          subject: file.path,
          message:
            `${file.path} changed. It determines what gets indexed and how, so every ` +
            'assumption behind the existing index may no longer hold.',
          hint: 'Re-run `sf testimpact index` to rebuild under the new settings.',
        });
        break;

      case 'parse-failed':
        if (config.taint.onParseError === 'full') {
          decisions.push({
            level: 'fallback',
            rule: 'changed-file-parse-failed',
            subject: file.path,
            message:
              `${file.path} changed, but it could not be parsed, so we cannot see what it ` +
              'references.',
            hint:
              'Set `taint.onParseError: widen` to treat the class as depending on everything ' +
              'instead of running the full suite. That is still safe, and much faster.',
          });
        } else {
          decisions.push({
            level: 'widen',
            rule: 'changed-file-parse-failed-widened',
            subject: file.path,
            message:
              `${file.path} could not be parsed; it is treated as depending on every class, ` +
              'object and field rather than degrading the whole run.',
          });
        }
        break;

      case 'not-in-index':
        if (MODELLED_EXTENSIONS.test(file.path)) {
          decisions.push({
            level: 'fallback',
            rule: 'changed-file-not-in-index',
            subject: file.path,
            message:
              `${file.path} changed but is not in the index, so nothing is known about what ` +
              'depends on it.',
            hint: 'Re-run `sf testimpact index`, or add the path to `excludeFromImpact`.',
          });
        } else if (config.taint.unmodelledFileType === 'full') {
          decisions.push({
            level: 'fallback',
            rule: 'unmodelled-file-type',
            subject: file.path,
            message:
              `${file.path} changed. It is a metadata type sf-testimpact does not model, so ` +
              'its effect on tests is unknown.',
            hint:
              'Add it to `excludeFromImpact` if you are certain no test depends on it, or set ' +
              '`taint.unmodelledFileType: widen` to stop such files forcing a full run.',
          });
        } else {
          // `widen` cannot widen anything here: nothing in the graph depends on a file type
          // the tool does not model, so there is nothing to walk from. The setting means
          // "do not force a full run for these", which is a reduction in safety, and a
          // reduction in safety is never silent. This branch used to emit nothing at all.
          decisions.push({
            level: 'info',
            rule: 'unmodelled-file-type-ignored',
            subject: file.path,
            message:
              `${file.path} changed. It is a metadata type sf-testimpact does not model, and ` +
              '`taint.unmodelledFileType: widen` is set, so the change is not analysed and ' +
              'does not force a full run. Its effect on tests is unknown.',
            hint: 'Remove `taint.unmodelledFileType: widen` to run the full suite when such a file changes.',
          });
        }
        break;
    }
  }

  return decisions;
}

export interface EntryPointOutcome {
  /** Extra seeds to add before recomputing the closure. Empty unless policy is `widen`. */
  readonly extraSeeds: readonly NodeKey[];
  readonly decisions: readonly Decision[];
}

/**
 * Apply `entryPointPolicy` to the impacted set (DESIGN.md 6.3).
 *
 * An entry point's inbound edges are known to be incomplete — a scheduled job named in
 * `CronTrigger`, an external REST client, a Process Builder — so "only these tests depend on
 * it" is not a claim the graph can support.
 */
export function applyEntryPointPolicy(
  graph: ImpactGraph,
  impacted: ReadonlySet<NodeKey>,
  config: Config,
): EntryPointOutcome {
  const impactedEntryPoints = [...impacted]
    .map((key) => graph.nodeByKey(key))
    .filter((n) => n !== undefined && hasFlag(n.flags, NodeFlags.ENTRY_POINT));

  if (impactedEntryPoints.length === 0) return { extraSeeds: [], decisions: [] };

  const first = impactedEntryPoints[0];
  if (first === undefined) return { extraSeeds: [], decisions: [] };
  const categories = describeCategories(first.entryPoints ?? []);

  switch (config.entryPointPolicy) {
    case 'full': {
      const names = [...new Set(impactedEntryPoints.map((n) => n?.name ?? '').filter(Boolean))];
      const others = names.length - 1;
      return {
        extraSeeds: [],
        decisions: [
          {
            level: 'fallback',
            rule: 'entry-point-policy-full',
            subject: first.name,
            subjects: names,
            message:
              `${first.name} is ${categories}, so its callers may live outside this repository ` +
              'and the graph’s inbound edges to it are incomplete.' +
              (others > 0 ? ` ${others} other impacted entry point(s): ${summariseNames(names.slice(1))}` : ''),
            hint:
              '`entryPointPolicy: widen` selects only the tests that reach an entry point of the ' +
              'same kind. Faster, but it assumes no unindexed caller reaches ' +
              (names.length === 1 ? 'this class.' : 'these classes.'),
          },
        ],
      };
    }

    case 'widen': {
      const wanted = new Set<EntryPointKind>();
      for (const node of impactedEntryPoints) {
        for (const kind of node?.entryPoints ?? []) wanted.add(kind);
      }
      const extraSeeds = graph.nodes
        .filter(
          (n) =>
            hasFlag(n.flags, NodeFlags.ENTRY_POINT) &&
            !impacted.has(n.key) &&
            (n.entryPoints ?? []).some((k) => wanted.has(k)),
        )
        .map((n) => n.key);

      return {
        extraSeeds,
        decisions: [
          {
            level: 'widen',
            rule: 'entry-point-policy-widen',
            subject: first.name,
            message:
              `${first.name} is ${categories}. Widening to ${extraSeeds.length} other entry ` +
              `point(s) of the same kind (${[...wanted].join(', ')}), because an unindexed ` +
              'caller may reach the same subsystem through one of them.',
          },
        ],
      };
    }

    case 'strict':
      return {
        extraSeeds: [],
        decisions: [
          {
            level: 'info',
            rule: 'entry-point-policy-strict',
            subject: first.name,
            message:
              `${first.name} is ${categories}, and \`entryPointPolicy: strict\` is set, so the ` +
              'graph is trusted despite its inbound edges being incomplete. Any caller outside ' +
              'this repository is invisible to this selection.',
            hint: 'This is the only policy that can miss a test for a reason the tool can see.',
          },
        ],
      };
  }
}

/** The setting that decides how far a taint domain degrades, where one exists. */
const SETTING_FOR_DOMAIN: Partial<Record<TaintDomain, keyof Pick<TaintConfig, 'dynamicApex' | 'dynamicSoql'>>> = {
  apexType: 'dynamicApex',
  sobjectAny: 'dynamicSoql',
  fieldAny: 'dynamicSoql',
};

const RULE_FOR_SETTING = { dynamicApex: 'dynamic-apex-full', dynamicSoql: 'dynamic-soql-full' } as const;

/**
 * `taint.dynamicApex: full` and `taint.dynamicSoql: full` (DESIGN.md 6.2).
 *
 * By default a dynamic construct widens: when a change activates its taint domain, every
 * class holding a construct in that domain is pulled into the impacted set. `full` asks for
 * the conservative alternative — run everything instead — and this is where it happens.
 * These two settings were validated and documented from the start but read by nothing, so
 * setting either to `full` silently did nothing.
 *
 * Taint recorded for an unparseable file is not a dynamic construct; it is governed by
 * `taint.onParseError` and is excluded here, or an unrelated parse failure would decide
 * this setting.
 *
 * @param activated The domains the closure activated, each with the node that activated it.
 */
export function checkDynamicTaint(
  graph: ImpactGraph,
  activated: ReadonlyMap<TaintDomain, NodeKey>,
  config: Config,
): Decision[] {
  const decisions: Decision[] = [];
  const fired = new Set<string>();

  for (const [domain, cause] of activated) {
    const setting = SETTING_FOR_DOMAIN[domain];
    if (setting === undefined || config.taint[setting] !== 'full' || fired.has(setting)) continue;

    const dynamic = graph.taints.filter((t) => t.domain === domain && t.cause !== PARSE_FAILURE_CAUSE);
    const first = dynamic[0];
    if (first === undefined) continue;
    fired.add(setting);

    const holders = [...new Set(dynamic.map((t) => graph.nodeByKey(t.node)?.name ?? t.node))];
    const firstHolder = holders[0] ?? first.node;
    const activator = graph.nodeByKey(cause)?.name ?? cause;
    const reach = domain === 'apexType' ? 'may call any class' : 'may read any object or field';
    const others = holders.length - 1;

    decisions.push({
      level: 'fallback',
      rule: RULE_FOR_SETTING[setting],
      subject: firstHolder,
      subjects: holders,
      message:
        `${firstHolder} uses ${first.cause}, so it ${reach}, and this change activated the ` +
        `\`${domain}\` taint domain through ${activator}. \`taint.${setting}: full\` is set, so ` +
        'the full suite runs instead of the tests that reach the dynamic code.' +
        (others > 0 ? ` ${others} other class(es) hold a dynamic construct in this domain: ${summariseNames(holders.slice(1))}` : ''),
      hint:
        `\`taint.${setting}: widen\` (the default) selects the tests that reach these classes ` +
        'instead of running everything.',
    });
  }

  return decisions;
}

/**
 * How many names a message prints before summarising.
 *
 * The full list is what a reader needs to decide whether `entryPointPolicy: widen` is safe,
 * so it is never discarded - `decision.subjects` still carries every name, and `--json`
 * exposes it. But a large project has enough entry points to make the prose useless: NPSP
 * produced 131 in one line, which buried the rule and the count it was supposed to
 * communicate. The prose is capped; the data is not.
 */
const NAME_PREVIEW_LIMIT = 8;

function summariseNames(names: readonly string[]): string {
  if (names.length <= NAME_PREVIEW_LIMIT) return `${names.join(', ')}.`;
  const shown = names.slice(0, NAME_PREVIEW_LIMIT).join(', ');
  return `${shown}, and ${names.length - NAME_PREVIEW_LIMIT} more (full list in \`--json\`).`;
}

function describeCategories(kinds: readonly EntryPointKind[]): string {
  if (kinds.length === 0) return 'an entry point';
  return `an entry point (${kinds.join(', ')})`;
}

/**
 * The reduction circuit breaker (DESIGN.md 8).
 *
 * This is not an optimiser. It exists to catch the case where a resolver bug collapses the
 * graph and the tool cheerfully reports "2 tests needed" for a 300-file change set.
 */
export function checkReduction(
  reductionPercent: number,
  selectedCount: number,
  totalTests: number,
  config: Config,
): Decision[] {
  if (reductionPercent <= config.maxReductionPercent) return [];

  const message =
    `This selection skips ${reductionPercent.toFixed(1)}% of tests ` +
    `(${selectedCount} of ${totalTests} selected), above the configured ` +
    `maxReductionPercent of ${config.maxReductionPercent}%.`;

  switch (config.onExceed) {
    case 'warn':
      return [{ level: 'info', rule: 'max-reduction-exceeded-warn', subject: 'maxReductionPercent', message }];
    case 'fail':
      return [{ level: 'fallback', rule: 'max-reduction-exceeded-fail', subject: 'maxReductionPercent', message }];
    case 'runAll':
      return [
        {
          level: 'fallback',
          rule: 'max-reduction-exceeded-run-all',
          subject: 'maxReductionPercent',
          message: `${message} Running the full suite instead.`,
        },
      ];
  }
}

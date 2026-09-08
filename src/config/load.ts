/**
 * Parsing and validation of `.sf-testimpact.yml`.
 *
 * `parseConfig` is pure: it takes YAML text and returns a Config or throws. File reading is
 * the caller's job, so this is testable without touching a filesystem.
 */

import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../errors.js';
import {
  DEFAULT_CONFIG,
  ENTRY_POINT_POLICIES,
  FULL_TEST_LEVELS,
  ON_EXCEED_VALUES,
  TAINT_ACTIONS,
  type Config,
  type EntryPointPolicy,
  type OnExceed,
  type TaintAction,
  type TaintConfig,
} from './schema.js';

/** A YAML mapping, before we have checked anything about it. */
type RawObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, subject: string, remedy?: string): never {
  throw new ConfigError(message, remedy === undefined ? { subject } : { subject, remedy });
}

function requireStringArray(value: unknown, key: string, subject: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`\`${key}\` must be a list of glob strings, but it is ${describe(value)}.`, subject);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      fail(`\`${key}[${i}]\` must be a string, but it is ${describe(entry)}.`, subject);
    }
    return entry;
  });
}

function requireEnum<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  fallback: T,
  subject: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(
      `\`${key}\` must be one of ${allowed.map((a) => `\`${a}\``).join(', ')}, but it is ${describe(value)}.`,
      subject,
    );
  }
  return value as T;
}

/** Renders an unexpected value for an error message without dumping a whole document. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value} \`${String(value)}\``;
  }
  // A symbol, function or bigint from a YAML document is exotic enough that naming the
  // type is more useful than trying to render the value.
  return typeof value;
}

function parseTaint(value: unknown, subject: string): TaintConfig {
  if (value === undefined) return DEFAULT_CONFIG.taint;
  if (!isPlainObject(value)) {
    fail(`\`taint\` must be a mapping, but it is ${describe(value)}.`, subject);
  }
  const action = (key: keyof TaintConfig): TaintAction =>
    requireEnum(value[key], `taint.${key}`, TAINT_ACTIONS, DEFAULT_CONFIG.taint[key], subject);

  return {
    onParseError: action('onParseError'),
    dynamicApex: action('dynamicApex'),
    dynamicSoql: action('dynamicSoql'),
    unmodelledFileType: action('unmodelledFileType'),
  };
}

function parseMaxReduction(value: unknown, subject: string): number {
  if (value === undefined) return DEFAULT_CONFIG.maxReductionPercent;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`\`maxReductionPercent\` must be a number, but it is ${describe(value)}.`, subject);
  }
  if (value < 0 || value > 100) {
    fail(
      `\`maxReductionPercent\` must be between 0 and 100, but it is ${value}.`,
      subject,
      'It is the share of tests we may skip before the circuit breaker fires — 95 means ' +
        '"warn if we would skip more than 95% of tests".',
    );
  }
  return value;
}

/**
 * Parse and validate `.sf-testimpact.yml` contents.
 *
 * @param text     Raw YAML. An empty document is valid and yields the defaults.
 * @param subject  Path used in error messages so the user knows which file is wrong.
 */
export function parseConfig(text: string, subject = '.sf-testimpact.yml'): Config {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (cause) {
    throw new ConfigError(
      `Could not parse YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      { subject, cause },
    );
  }

  // An empty or comments-only file is a legitimate way to say "use the defaults".
  if (doc === null || doc === undefined) return DEFAULT_CONFIG;

  if (!isPlainObject(doc)) {
    fail(`The config must be a mapping at the top level, but it is ${describe(doc)}.`, subject);
  }

  const version = doc['version'];
  if (version !== undefined && version !== 1) {
    fail(
      `Unsupported config \`version\`: ${describe(version)}.`,
      subject,
      'This build understands version 1. Upgrade sf-testimpact, or set `version: 1`.',
    );
  }

  const known = new Set([
    'version',
    'sourcePaths',
    'alwaysRun',
    'excludeFromImpact',
    'maxReductionPercent',
    'onExceed',
    'entryPointPolicy',
    'taint',
    'fullTestLevel',
  ]);
  // A typo in a safety key silently disables the safety. Reject unknown keys rather than
  // ignoring them: `maxReductionPct: 50` must not read as "no limit configured".
  const unknown = Object.keys(doc).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    fail(
      `Unknown config ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.map((k) => `\`${k}\``).join(', ')}.`,
      subject,
      `Valid keys are ${[...known].map((k) => `\`${k}\``).join(', ')}. ` +
        'Unknown keys are rejected because a typo in a safety setting would otherwise disable it silently.',
    );
  }

  const fullTestLevel = requireEnum(
    doc['fullTestLevel'],
    'fullTestLevel',
    FULL_TEST_LEVELS,
    DEFAULT_CONFIG.fullTestLevel,
    subject,
  );

  return {
    version: 1,
    sourcePaths: requireStringArray(doc['sourcePaths'], 'sourcePaths', subject),
    alwaysRun: requireStringArray(doc['alwaysRun'], 'alwaysRun', subject),
    excludeFromImpact: requireStringArray(doc['excludeFromImpact'], 'excludeFromImpact', subject),
    maxReductionPercent: parseMaxReduction(doc['maxReductionPercent'], subject),
    onExceed: requireEnum<OnExceed>(
      doc['onExceed'],
      'onExceed',
      ON_EXCEED_VALUES,
      DEFAULT_CONFIG.onExceed,
      subject,
    ),
    entryPointPolicy: requireEnum<EntryPointPolicy>(
      doc['entryPointPolicy'],
      'entryPointPolicy',
      ENTRY_POINT_POLICIES,
      DEFAULT_CONFIG.entryPointPolicy,
      subject,
    ),
    taint: parseTaint(doc['taint'], subject),
    fullTestLevel,
  };
}

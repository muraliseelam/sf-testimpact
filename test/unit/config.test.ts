import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { ConfigError } from '../../src/errors.js';

describe('parseConfig', () => {
  it('returns defaults for an empty document', () => {
    expect(parseConfig('')).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for a comments-only document', () => {
    expect(parseConfig('# nothing here\n')).toEqual(DEFAULT_CONFIG);
  });

  it('defaults entryPointPolicy to full, not widen', () => {
    // The first run must be trustworthy before it is fast (DESIGN.md 6.3). If this ever
    // flips silently, every user's first analyze starts skipping tests on an unproven graph.
    expect(parseConfig('').entryPointPolicy).toBe('full');
  });

  it('reads a full config', () => {
    const config = parseConfig(`
version: 1
sourcePaths: [force-app/main/default]
alwaysRun:
  - "**/SecurityBaselineTest.cls"
excludeFromImpact:
  - "**/*.md"
maxReductionPercent: 80
onExceed: fail
entryPointPolicy: widen
taint:
  onParseError: widen
  dynamicSoql: full
fullTestLevel: RunAllTestsInOrg
`);
    expect(config.sourcePaths).toEqual(['force-app/main/default']);
    expect(config.alwaysRun).toEqual(['**/SecurityBaselineTest.cls']);
    expect(config.maxReductionPercent).toBe(80);
    expect(config.onExceed).toBe('fail');
    expect(config.entryPointPolicy).toBe('widen');
    expect(config.taint.onParseError).toBe('widen');
    expect(config.taint.dynamicSoql).toBe('full');
    // Unspecified taint keys keep their defaults rather than becoming undefined.
    expect(config.taint.dynamicApex).toBe('widen');
    expect(config.fullTestLevel).toBe('RunAllTestsInOrg');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo in a safety key must not read as "no limit configured".
    expect(() => parseConfig('maxReductionPct: 50')).toThrow(ConfigError);
    expect(() => parseConfig('maxReductionPct: 50')).toThrow(/maxReductionPct/);
  });

  it('names the offending key and the legal values for a bad enum', () => {
    try {
      parseConfig('entryPointPolicy: sometimes');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('entryPointPolicy');
      expect(message).toContain('`full`');
      expect(message).toContain('`widen`');
      expect(message).toContain('`strict`');
    }
  });

  it.each([
    ['maxReductionPercent: -1', /between 0 and 100/],
    ['maxReductionPercent: 101', /between 0 and 100/],
    ['maxReductionPercent: "high"', /must be a number/],
  ])('rejects %s', (yaml, pattern) => {
    expect(() => parseConfig(yaml)).toThrow(pattern);
  });

  it('accepts the boundary values of maxReductionPercent', () => {
    expect(parseConfig('maxReductionPercent: 0').maxReductionPercent).toBe(0);
    expect(parseConfig('maxReductionPercent: 100').maxReductionPercent).toBe(100);
  });

  it('rejects a non-list where globs are expected', () => {
    expect(() => parseConfig('alwaysRun: "**/*.cls"')).toThrow(/must be a list/);
  });

  it('rejects a non-string entry in a glob list, naming the index', () => {
    expect(() => parseConfig('alwaysRun: [ok, 42]')).toThrow(/alwaysRun\[1\]/);
  });

  it('rejects an unsupported version with an actionable remedy', () => {
    try {
      parseConfig('version: 2');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).remedy).toMatch(/version: 1/);
    }
  });

  it('reports the file name for malformed YAML', () => {
    try {
      parseConfig('alwaysRun: [unclosed', 'team/.sf-testimpact.yml');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).subject).toBe('team/.sf-testimpact.yml');
    }
  });

  it('rejects a scalar top-level document', () => {
    expect(() => parseConfig('just a string')).toThrow(/mapping at the top level/);
  });

  it('rejects an invalid fullTestLevel', () => {
    expect(() => parseConfig('fullTestLevel: RunSomeTests')).toThrow(/fullTestLevel/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APEX_PARSER_VERSION, GRAPH_FORMAT_VERSION, TOOL_VERSION, majorVersion } from '../../src/version.js';

interface PackageJson {
  readonly version: string;
  readonly dependencies: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
) as PackageJson;

describe('version constants', () => {
  it('records the apex-parser version actually declared in package.json', () => {
    // Staleness detection compares this against what an index was built with. If the two
    // drift, a parser upgrade stops invalidating old indexes and we start mixing facts from
    // two different extractions — the exact silent-wrongness the check exists to prevent.
    // Enforced by a test rather than by remembering.
    expect(APEX_PARSER_VERSION).toBe(pkg.dependencies['@apexdevtools/apex-parser']);
  });

  it('records the package version', () => {
    expect(TOOL_VERSION).toBe(pkg.version);
  });

  it('tracks package.json automatically, so a release bump cannot desync it', () => {
    // This is the regression that matters. TOOL_VERSION used to be a hand-written literal.
    // semantic-release bumps package.json and commits it without touching src/, so the
    // assertion above began failing immediately after 0.1.1 shipped - and since the release
    // workflow runs the suite BEFORE semantic-release, that failure would have blocked every
    // future release until someone hand-edited the constant back into agreement.
    expect(TOOL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const source = readFileSync(join(import.meta.dirname, '../../src/version.ts'), 'utf8');
    expect(source).not.toMatch(/TOOL_VERSION\s*(:\s*string\s*)?=\s*['"]/);
  });

  it('has a positive graph format version', () => {
    expect(GRAPH_FORMAT_VERSION).toBeGreaterThan(0);
  });
});

describe('majorVersion', () => {
  it.each([
    ['5.2.0', '5'],
    ['10.0.1', '10'],
    ['4.9.1-beta.2', '4'],
  ])('reduces %s to %s', (input, expected) => {
    expect(majorVersion(input)).toBe(expected);
  });

  it('returns the input unchanged when it has no dots', () => {
    expect(majorVersion('next')).toBe('next');
  });
});

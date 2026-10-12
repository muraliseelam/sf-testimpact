import { describe, expect, it } from 'vitest';
import { argsForSpawn, quoteForCmd } from '../../src/deploy/shell.js';

describe('quoteForCmd', () => {
  it('leaves ordinary flags, names and paths alone', () => {
    for (const arg of ['--test-level', 'RunSpecifiedTests', '--tests', 'Foo_Tests', 'force-app/main/default', 'fn-run-2']) {
      expect(quoteForCmd(arg)).toBe(arg);
    }
  });

  it('quotes a path with a space, the case the first live deploy on Windows broke on', () => {
    expect(quoteForCmd('force-app/main/default/classes/Collection Recipes/ListSortingRecipes.cls')).toBe(
      '"force-app/main/default/classes/Collection Recipes/ListSortingRecipes.cls"',
    );
  });

  it('quotes shell metacharacters and doubles embedded quotes', () => {
    expect(quoteForCmd('a&b')).toBe('"a&b"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmd('(x)')).toBe('"(x)"');
    expect(quoteForCmd('')).toBe('""');
  });
});

describe('argsForSpawn', () => {
  const args = ['project', 'deploy', 'start', '--source-dir', 'Collection Recipes/X.cls'];

  it('quotes only when a shell is in the way', () => {
    expect(argsForSpawn(args, true)).toEqual(['project', 'deploy', 'start', '--source-dir', '"Collection Recipes/X.cls"']);
    expect(argsForSpawn(args, false)).toEqual(args);
  });

  it('returns a copy, never the caller\'s array', () => {
    const copy = argsForSpawn(args, false);
    expect(copy).not.toBe(args);
  });
});

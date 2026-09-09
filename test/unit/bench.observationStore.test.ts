/**
 * The resumable observation store.
 *
 * Two properties carry the weight here, and both are about failure rather than the happy
 * path: a run interrupted mid-write must lose exactly one commit and no more, and a store
 * must never accept outcomes from a commit window other than its own. The second is the
 * dangerous one — mixing windows produces a result that corresponds to no experiment anyone
 * ran, and nothing downstream could detect it after the fact.
 */

import { describe, expect, it } from 'vitest';
import {
  ObservationStore,
  WindowMismatchError,
  loadStore,
  openStore,
  type AppendOnlyFileSystem,
  type StoredCommit,
  type WindowIdentity,
} from '../../src/bench/observationStore.js';
import type { TestOutcome } from '../../src/bench/adapters.js';

const WINDOW: WindowIdentity = {
  repo: 'example/repo',
  baseSha: 'aaaa1111',
  headSha: 'bbbb2222',
  commitCount: 3,
};

/** In-memory append-only filesystem. Records writes so append-vs-truncate is observable. */
function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const mkdirs: string[] = [];
  const fs: AppendOnlyFileSystem & { files: Map<string, string>; mkdirs: string[] } = {
    files,
    mkdirs,
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    appendFile: (p, c) => files.set(p, (files.get(p) ?? '') + c),
    exists: (p) => files.has(p),
    mkdirp: (p) => void mkdirs.push(p),
  };
  return fs;
}

const outcome = (className: string, methodName: string, o: TestOutcome['outcome']): TestOutcome => ({
  className,
  methodName,
  outcome: o,
  durationMs: 1,
});

const commitRecord = (commit: string, extra: Partial<StoredCommit> = {}): StoredCommit => ({
  commit,
  results: [outcome('AccountTest', 'testOne', 'Pass')],
  selected: ['AccountTest'],
  fellBack: false,
  totalTests: 10,
  ...extra,
});

const PATH = 'docs/measurements/fn-observations.ndjson';

describe('creating and appending', () => {
  it('writes a window header before any commit', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW);
    const first = (fs.files.get(PATH) ?? '').split('\n')[0] ?? '';
    expect(JSON.parse(first)).toEqual({ kind: 'window', window: WINDOW });
  });

  it('creates the containing directory', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW);
    expect(fs.mkdirs).toContain('docs/measurements');
  });

  it('appends rather than truncating', () => {
    // The whole point of NDJSON here. If append were implemented as read-modify-write, an
    // interruption would lose the file, not one line of it.
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1'));
    store.append(commitRecord('c2'));
    const lines = (fs.files.get(PATH) ?? '').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(store.recordedCommits()).toEqual(['c1', 'c2']);
  });

  it('reports an empty store as having recorded nothing', () => {
    const fs = memoryFs();
    expect(openStore(fs, PATH, WINDOW).recorded).toEqual([]);
  });

  it('refuses to record the same commit twice', () => {
    // The scorer reads this file as an ordered series where each entry is the predecessor of
    // the next, so a duplicate makes the predecessor ambiguous rather than merely redundant.
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1'));
    expect(() => store.append(commitRecord('c1'))).toThrow(/already recorded/);
  });
});

describe('resume', () => {
  it('reports the commits already recorded', () => {
    const fs = memoryFs();
    const first = openStore(fs, PATH, WINDOW);
    first.store.append(commitRecord('c1'));
    first.store.append(commitRecord('c2'));

    const second = openStore(fs, PATH, WINDOW);
    expect(second.recorded).toEqual(['c1', 'c2']);
    expect(second.store.has('c1')).toBe(true);
    expect(second.store.has('c3')).toBe(false);
  });

  it('does not rewrite the header on resume', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    openStore(fs, PATH, WINDOW);
    const headers = (fs.files.get(PATH) ?? '')
      .trim()
      .split('\n')
      .filter((l) => (JSON.parse(l) as { kind: string }).kind === 'window');
    expect(headers).toHaveLength(1);
  });

  it('continues appending after a resume', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    const resumed = openStore(fs, PATH, WINDOW);
    resumed.store.append(commitRecord('c2'));
    expect(resumed.store.recordedCommits()).toEqual(['c1', 'c2']);
  });
});

describe('a run interrupted mid-write', () => {
  it('discards a truncated final line and treats that commit as absent', () => {
    // Exactly the shape a killed process leaves: a complete record, then half of one.
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1'));
    fs.appendFile(PATH, '{"kind":"commit","commit":"c2","resul');

    const resumed = openStore(fs, PATH, WINDOW);
    expect(resumed.recorded).toEqual(['c1']);
    expect(resumed.store.has('c2')).toBe(false);
    expect(resumed.resumedAfterInterruption).toBe(true);
  });

  it('surfaces the interruption rather than silently healing it', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    fs.appendFile(PATH, '{"kind":"commit","comm');
    expect(loadStore(fs, PATH)?.truncatedTailDiscarded).toBe(true);
  });

  it('reports no interruption for a cleanly written store', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    expect(openStore(fs, PATH, WINDOW).resumedAfterInterruption).toBe(false);
  });

  it('throws when a bad line is NOT the last one', () => {
    // A truncated tail is an interrupted write. Garbage in the middle is a corrupt or
    // hand-edited file, and skipping it would drop a commit's outcomes unnoticed.
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1'));
    const good = fs.files.get(PATH) ?? '';
    fs.files.set(PATH, `${good}not json\n${JSON.stringify({ kind: 'commit', ...commitRecord('c2') })}\n`);
    expect(() => loadStore(fs, PATH)).toThrow(/corrupt at line/);
  });

  it('tolerates a trailing newline and blank lines', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    fs.appendFile(PATH, '\n\n');
    expect(openStore(fs, PATH, WINDOW).recorded).toEqual(['c1']);
  });
});

describe('window identity', () => {
  it('refuses a store belonging to a different window', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    const other = { ...WINDOW, headSha: 'cccc3333' };
    expect(() => openStore(fs, PATH, other)).toThrow(WindowMismatchError);
  });

  it.each([
    ['repo', { repo: 'other/repo' }],
    ['baseSha', { baseSha: 'zzzz9999' }],
    ['headSha', { headSha: 'zzzz9999' }],
    ['commitCount', { commitCount: 4 }],
  ])('treats a different %s as a different window', (_field, diff) => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW);
    expect(() => openStore(fs, PATH, { ...WINDOW, ...diff })).toThrow(WindowMismatchError);
  });

  it('names both windows in the error, so the mismatch is actionable', () => {
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW);
    try {
      openStore(fs, PATH, { ...WINDOW, headSha: 'cccc3333' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as WindowMismatchError;
      expect(err.message).toContain('bbbb2222');
      expect(err.message).toContain('cccc3333');
      expect(err.stored.headSha).toBe('bbbb2222');
      expect(err.requested.headSha).toBe('cccc3333');
    }
  });

  it('rejects a store with no header at all', () => {
    const fs = memoryFs({ [PATH]: `${JSON.stringify({ kind: 'commit', ...commitRecord('c1') })}\n` });
    expect(() => loadStore(fs, PATH)).toThrow(/no window header/);
  });

  it('returns null for a store that does not exist yet', () => {
    expect(loadStore(memoryFs(), PATH)).toBeNull();
  });
});

describe('handing observations to the scorer', () => {
  it('passes through the fields the scorer reads', () => {
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1', { baselineOnly: true }));
    store.append(commitRecord('c2', { fellBack: true, selected: [], totalTests: 12 }));

    expect(store.toObservations()).toEqual([
      {
        commit: 'c1',
        results: [outcome('AccountTest', 'testOne', 'Pass')],
        selected: ['AccountTest'],
        fellBack: false,
        totalTests: 10,
        baselineOnly: true,
      },
      {
        commit: 'c2',
        results: [outcome('AccountTest', 'testOne', 'Pass')],
        selected: [],
        fellBack: true,
        totalTests: 12,
      },
    ]);
  });

  it('omits excluded commits from the observations but keeps them in the store', () => {
    // An excluded commit has no outcomes. Passing it to the scorer would read as "every test
    // passed here", turning a deploy failure into evidence of correctness.
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1'));
    store.append({
      commit: 'c2',
      results: [],
      selected: [],
      fellBack: false,
      totalTests: 0,
      excluded: 'deploy failed: Component Failures [2]',
    });

    expect(store.toObservations().map((o) => o.commit)).toEqual(['c1']);
    expect(store.all()).toHaveLength(2);
    expect(store.excluded()).toEqual([
      { commit: 'c2', reason: 'deploy failed: Component Failures [2]' },
    ]);
  });

  it('preserves commit order across a resume', () => {
    // `newlyFailing` is defined against the previous observation, so order is load-bearing.
    const fs = memoryFs();
    openStore(fs, PATH, WINDOW).store.append(commitRecord('c1'));
    const second = openStore(fs, PATH, WINDOW);
    second.store.append(commitRecord('c2'));
    const third = openStore(fs, PATH, WINDOW);
    third.store.append(commitRecord('c3'));
    expect(third.store.toObservations().map((o) => o.commit)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('awkward content survives a round trip', () => {
  it.each([
    ['a comma', 'Account,Test'],
    ['a newline', 'Account\nTest'],
    ['a quote', 'Account"Test'],
    ['a backslash', 'Account\\Test'],
    ['a unicode name', 'Cuenta_Prueba_日本'],
  ])('handles a test class name containing %s', (_label, className) => {
    // NDJSON is line-delimited, so an embedded newline is the case that would corrupt the
    // file if records were ever written unescaped.
    const fs = memoryFs();
    const { store } = openStore(fs, PATH, WINDOW);
    store.append(commitRecord('c1', { results: [outcome(className, 'testOne', 'Fail')] }));

    const reloaded = openStore(fs, PATH, WINDOW);
    expect(reloaded.store.all()[0]?.results[0]?.className).toBe(className);
    expect(reloaded.recorded).toEqual(['c1']);
  });
});

describe('ObservationStore constructed directly', () => {
  it('starts from the records it is given', () => {
    const fs = memoryFs();
    const store = new ObservationStore(fs, PATH, WINDOW, [commitRecord('c1')]);
    expect(store.has('c1')).toBe(true);
    expect(store.recordedCommits()).toEqual(['c1']);
  });
});

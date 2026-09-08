/**
 * The command layer's filesystem adapter.
 *
 * Regression: paths reaching the adapter come from two conventions — the walker yields
 * repository-relative paths (they become node `declaredIn` values and must match what
 * `git diff` reports), while the store yields paths already joined to the project root.
 * The adapter resolved neither against the root, so it read them relative to the process
 * working directory. `sf testimpact index --root-dir <anywhere-else>` could not open a
 * single source file. Found by running the indexer against a real cloned repository.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeFileSystem } from '../../src/commands/testimpact/index.js';
import { graphPath } from '../../src/graph/store.js';

const root = mkdtempSync(join(tmpdir(), 'sfti-fs-'));
mkdirSync(join(root, 'force-app'), { recursive: true });
writeFileSync(join(root, 'force-app', 'A.cls'), 'public class A {}', 'utf8');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createNodeFileSystem', () => {
  const fs = createNodeFileSystem(root);

  it('reads a repository-relative path against the project root, not the CWD', () => {
    // The CWD during this test is the sf-testimpact repo, which has no force-app/A.cls.
    // Before the fix this threw ENOENT for every walker path.
    expect(fs.readFile('force-app/A.cls')).toBe('public class A {}');
  });

  it('reports existence against the project root', () => {
    expect(fs.exists('force-app/A.cls')).toBe(true);
    expect(fs.exists('force-app/Missing.cls')).toBe(false);
  });

  it('writes against the project root', () => {
    fs.writeFile('force-app/B.cls', 'public class B {}');
    expect(existsSync(join(root, 'force-app', 'B.cls'))).toBe(true);
  });

  it('creates directories against the project root', () => {
    fs.mkdirp('nested/deep');
    expect(existsSync(join(root, 'nested', 'deep'))).toBe(true);
  });

  it('leaves an already-absolute store path unchanged', () => {
    // `graphPath(root)` is already joined to the root; resolving it again must not produce
    // `<root>/<root>/...`.
    const target = graphPath(root);
    fs.mkdirp(join(root, '.sf-testimpact'));
    fs.writeFile(target, '{}');
    expect(existsSync(target)).toBe(true);
    expect(fs.readFile(target)).toBe('{}');
  });

  it('works with a relative root, which is the CLI default', () => {
    const cwdFs = createNodeFileSystem('.');
    expect(cwdFs.exists('package.json')).toBe(true);
  });
});

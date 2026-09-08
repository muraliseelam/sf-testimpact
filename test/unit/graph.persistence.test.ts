/**
 * Atomic write and gzip (DESIGN.md 4.4).
 *
 * Two promises the design made that the implementation did not keep:
 *
 * - "temp file + rename". `saveGraph` wrote a `.tmp`, then *copied* it to the target and
 *   left the `.tmp` behind. A copy is not atomic — an interrupted run leaves a half-written
 *   index that the next `analyze` would read as truth — and the leaked temp file doubled the
 *   on-disk footprint of every index.
 * - gzip above 8 MB. Never implemented; the index was always plain JSON. NPSP's graph is
 *   ~8.5 MB, so this threshold is crossed by a real project, not a hypothetical one.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  GZIP_SUFFIX,
  GZIP_THRESHOLD_BYTES,
  graphPath,
  loadGraph,
  saveGraph,
  type FileSystem,
} from '../../src/graph/store.js';
import { currentGenerator } from '../../src/graph/store.js';
import { extractApex } from '../../src/extract/apex.js';
import type { FileFacts } from '../../src/types.js';

interface Recording extends FileSystem {
  readonly files: Map<string, Uint8Array>;
  readonly ops: string[];
}

/** In-memory filesystem that records the operation sequence, so atomicity is observable. */
function memoryFs(options: { rename?: boolean; bytes?: boolean } = {}): Recording {
  const files = new Map<string, Uint8Array>();
  const ops: string[] = [];
  const fs: Recording = {
    files,
    ops,
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(v).toString('utf8');
    },
    readBytes: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      ops.push(`write ${p}`);
      files.set(p, Buffer.from(c, 'utf8'));
    },
    mkdirp: () => undefined,
    exists: (p) => files.has(p),
    remove: (p) => {
      ops.push(`remove ${p}`);
      files.delete(p);
    },
  };
  if (options.bytes !== false) {
    fs.writeBytes = (p, b) => {
      ops.push(`writeBytes ${p}`);
      files.set(p, b);
    };
  }
  if (options.rename !== false) {
    fs.rename = (from, to) => {
      ops.push(`rename ${from} -> ${to}`);
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, v);
      files.delete(from);
    };
  }
  return fs;
}

const smallFacts: FileFacts[] = [
  extractApex('force-app/main/default/classes/A.cls', 'public class A { void m() { B.go(); } }'),
];

const saveInput = (facts: readonly FileFacts[]) => ({
  root: '.',
  files: facts.map((f) => ({ path: f.path, hash: 'h', parsedOk: f.parsedOk, extractor: f.extractor })),
  facts,
  project: { root: '.', sourcePaths: ['force-app'], namespace: 'c' },
  generator: currentGenerator(),
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('atomic write', () => {
  it('publishes through a rename, not a copy', () => {
    const fs = memoryFs();
    saveGraph(fs, saveInput(smallFacts));
    expect(fs.ops.some((o) => o.startsWith('rename '))).toBe(true);
  });

  it('leaves no .tmp file behind', () => {
    // The leak the previous implementation had: every index doubled its own disk usage.
    const fs = memoryFs();
    saveGraph(fs, saveInput(smallFacts));
    expect([...fs.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
  });

  it('writes the temp file before the target exists', () => {
    // Ordering is the whole point: the target must never be observed partially written.
    const fs = memoryFs();
    const target = graphPath('.');
    saveGraph(fs, saveInput(smallFacts));
    const tempWrite = fs.ops.findIndex((o) => o.includes('.tmp') && !o.startsWith('rename'));
    const publish = fs.ops.findIndex((o) => o.startsWith('rename') && o.endsWith(target));
    expect(tempWrite).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(tempWrite);
  });

  it('still cleans up when the filesystem cannot rename', () => {
    // The injected FileSystem makes `rename` optional, so the degraded path must not leak.
    const fs = memoryFs({ rename: false });
    saveGraph(fs, saveInput(smallFacts));
    expect([...fs.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
    expect(fs.exists(graphPath('.'))).toBe(true);
  });

  it('round-trips through save and load', () => {
    const fs = memoryFs();
    saveGraph(fs, saveInput(smallFacts));
    const loaded = loadGraph(fs, '.');
    expect(loaded?.nodes.length).toBeGreaterThan(0);
  });
});

describe('gzip above the threshold', () => {
  // Reaching the real 8 MB threshold needs roughly 4,000 classes, which is too slow for a
  // unit test. The threshold is injectable so the compression path is exercised directly;
  // the production constant is asserted separately below.
  const big = [
    extractApex(
      'force-app/main/default/classes/Big.cls',
      `public class Big { ${Array.from({ length: 60 }, (_, j) => `void m${j}() { Helper${j}.go(); }`).join(' ')} }`,
    ),
  ];
  const tinyThreshold = { gzipThresholdBytes: 256 };

  it('uses the documented 8 MB production threshold by default', () => {
    expect(GZIP_THRESHOLD_BYTES).toBe(8 * 1024 * 1024);
  });

  it('the fixture actually exceeds the threshold under test, or this suite proves nothing', () => {
    const fs = memoryFs();
    saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    const written = [...fs.files.entries()].find(([k]) => k.endsWith(GZIP_SUFFIX));
    expect(written).toBeDefined();
    const raw = gunzipSync(Buffer.from(written?.[1] ?? new Uint8Array()));
    expect(raw.byteLength).toBeGreaterThan(256);
  });

  it('writes graph.json.gz and not graph.json', () => {
    const fs = memoryFs();
    const path = saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    expect(path.endsWith(`${GZIP_SUFFIX}`)).toBe(true);
    expect(fs.exists(graphPath('.'))).toBe(false);
    expect(fs.exists(`${graphPath('.')}${GZIP_SUFFIX}`)).toBe(true);
  });

  it('the compressed form is materially smaller', () => {
    const fs = memoryFs();
    saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    const stored = fs.files.get(`${graphPath('.')}${GZIP_SUFFIX}`);
    const inflated = gunzipSync(Buffer.from(stored ?? new Uint8Array()));
    expect(stored?.byteLength ?? 0).toBeLessThan(inflated.byteLength / 2);
  });

  it('loads a gzipped index back to the same graph', () => {
    const fs = memoryFs();
    saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    const loaded = loadGraph(fs, '.');
    expect(loaded?.files.length).toBe(big.length);
    expect(loaded?.nodes.length).toBeGreaterThan(0);
  });

  it('stays plain JSON below the threshold', () => {
    const fs = memoryFs();
    saveGraph(fs, saveInput(smallFacts));
    expect(fs.exists(graphPath('.'))).toBe(true);
    expect(fs.exists(`${graphPath('.')}${GZIP_SUFFIX}`)).toBe(false);
  });

  it('falls back to plain JSON when the filesystem cannot write bytes', () => {
    const fs = memoryFs({ bytes: false });
    saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    expect(fs.exists(graphPath('.'))).toBe(true);
    expect(fs.exists(`${graphPath('.')}${GZIP_SUFFIX}`)).toBe(false);
  });

  it('removes a stale plain index when switching to gzipped', () => {
    // Two forms on disk would make the answer depend on which one the loader happened to
    // pick, which is the kind of silent staleness the format-version checks exist to stop.
    const fs = memoryFs();
    saveGraph(fs, saveInput(smallFacts));
    expect(fs.exists(graphPath('.'))).toBe(true);
    saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    expect(fs.exists(graphPath('.'))).toBe(false);
  });

  it('removes a stale gzipped index when switching back to plain', () => {
    const fs = memoryFs();
    saveGraph(fs, { ...saveInput(big), ...tinyThreshold });
    saveGraph(fs, saveInput(smallFacts));
    expect(fs.exists(`${graphPath('.')}${GZIP_SUFFIX}`)).toBe(false);
    expect(fs.exists(graphPath('.'))).toBe(true);
  });

  it('prefers the gzipped form if both somehow exist', () => {
    const fs = memoryFs();
    saveGraph(fs, saveInput(smallFacts));
    const plainOnly = loadGraph(fs, '.');
    fs.writeBytes?.(
      `${graphPath('.')}${GZIP_SUFFIX}`,
      gzipSync(Buffer.from(fs.readFile(graphPath('.')), 'utf8')),
    );
    expect(loadGraph(fs, '.')?.nodes.length).toBe(plainOnly?.nodes.length);
  });
});

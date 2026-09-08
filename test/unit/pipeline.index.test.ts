/**
 * The `index` pipeline (DESIGN.md 4.4, 5.1).
 *
 * Runs against an in-memory project: no filesystem, no git, no org.
 */

import { describe, expect, it, vi } from 'vitest';
import { runIndex } from '../../src/pipeline/index.js';
import { graphPath, loadGraph, type FileSystem } from '../../src/graph/store.js';
import { loadConfig, loadProject } from '../../src/project.js';
import type { TestImpactError } from '../../src/errors.js';
import { apexKey } from '../helpers/buildGraph.js';

function memoryFs(seed: Record<string, string> = {}): FileSystem & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile(path, contents) {
      files.set(path, contents);
    },
    mkdirp() {
      /* directories are implicit in a flat map */
    },
    exists(path) {
      return files.has(path);
    },
  };
}

const CLASSES = 'force-app/main/default/classes';
const PROJECT = { root: '.', sourcePaths: ['force-app/main/default'], namespace: 'c' };

const SOURCES: Record<string, string> = {
  [`${CLASSES}/Service.cls`]: 'public class Service { public static void run() {} }',
  [`${CLASSES}/ServiceTest.cls`]:
    '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }',
  'force-app/main/default/objects/Invoice__c/Invoice__c.object-meta.xml':
    '<CustomObject><fullName>Invoice__c</fullName></CustomObject>',
  'README.md': '# not indexed',
};

const walkAll = () => Object.keys(SOURCES);
const now = () => new Date('2026-01-01T00:00:00.000Z');

describe('runIndex', () => {
  it('extracts modelled files and skips the rest', () => {
    const fs = memoryFs(SOURCES);
    const result = runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });

    expect(result.extracted).toBe(3); // README.md is not a modelled path.
    expect(result.graph.files.map((f) => f.path)).not.toContain('README.md');
    expect(result.graph.nodeByKey(apexKey('Service'))).toBeDefined();
  });

  it('writes an index that loads back to an equivalent graph', () => {
    const fs = memoryFs(SOURCES);
    const written = runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });
    expect(fs.exists(graphPath('.'))).toBe(true);

    const loaded = loadGraph(fs, '.');
    expect(loaded?.nodes.length).toBe(written.graph.nodes.length);
    expect(loaded?.edges.length).toBe(written.graph.edges.length);
  });

  it('reuses unchanged files on a second run', () => {
    const fs = memoryFs(SOURCES);
    runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });

    const second = runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });
    expect(second.extracted).toBe(0);
    expect(second.reused).toBe(3);
  });

  it('re-extracts only the file whose contents changed', () => {
    const fs = memoryFs(SOURCES);
    runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });

    fs.writeFile(`${CLASSES}/Service.cls`, 'public class Service { public static void run(Integer i) {} }');
    const second = runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });

    expect(second.plan.changed).toEqual([`${CLASSES}/Service.cls`]);
    expect(second.extracted).toBe(1);
    expect(second.reused).toBe(2);
  });

  it('drops a removed file from the index', () => {
    const fs = memoryFs(SOURCES);
    runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });

    const fewer = Object.keys(SOURCES).filter((p) => p !== `${CLASSES}/ServiceTest.cls`);
    const second = runIndex({ fs, walk: () => fewer, now }, { root: '.', project: PROJECT });

    expect(second.plan.removed).toEqual([`${CLASSES}/ServiceTest.cls`]);
    expect(second.graph.files.map((f) => f.path)).not.toContain(`${CLASSES}/ServiceTest.cls`);
  });

  it('re-extracts everything under --force', () => {
    const fs = memoryFs(SOURCES);
    runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT });

    const forced = runIndex({ fs, walk: walkAll, now }, { root: '.', project: PROJECT, force: true });
    expect(forced.extracted).toBe(3);
    expect(forced.reused).toBe(0);
  });

  it('binds a reference that only resolves after a new file appears', () => {
    // The reason the persisted artifact is facts rather than a patched edge list: an
    // incremental run must produce the same graph as a full one.
    const fs = memoryFs({ [`${CLASSES}/Caller.cls`]: 'public class Caller { void m() { Later.go(); } }' });
    const walkOne = (): string[] => [`${CLASSES}/Caller.cls`];
    runIndex({ fs, walk: walkOne, now }, { root: '.', project: PROJECT });

    fs.writeFile(`${CLASSES}/Later.cls`, 'public class Later { public static void go() {} }');
    const walkTwo = (): string[] => [`${CLASSES}/Caller.cls`, `${CLASSES}/Later.cls`];
    const second = runIndex({ fs, walk: walkTwo, now }, { root: '.', project: PROJECT });

    // Caller was NOT re-extracted, yet its edge to Later exists because resolution is global.
    expect(second.plan.changed).toEqual([]);
    expect(
      second.graph.edges.some((e) => e.from === apexKey('Caller') && e.to === apexKey('Later')),
    ).toBe(true);
  });

  it('records an unparseable file rather than skipping it', () => {
    const fs = memoryFs({ [`${CLASSES}/Broken.cls`]: 'public class Broken { void m( { } }' });
    const result = runIndex(
      { fs, walk: () => [`${CLASSES}/Broken.cls`], now },
      { root: '.', project: PROJECT },
    );
    expect(result.graph.files[0]?.parsedOk).toBe(false);
    expect(result.graph.taints.length).toBeGreaterThan(0);
  });

  it('reports progress once per extracted file', () => {
    const onProgress = vi.fn();
    runIndex({ fs: memoryFs(SOURCES), walk: walkAll, now, onProgress }, { root: '.', project: PROJECT });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe('loadProject', () => {
  it('reads package directories from sfdx-project.json', () => {
    const fs = memoryFs({
      'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }),
    });
    expect(loadProject(fs, '.')).toEqual({ root: '.', sourcePaths: ['force-app'], namespace: 'c' });
  });

  it('prefers sourcePaths from our own config', () => {
    const fs = memoryFs({
      'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }),
      '.sf-testimpact.yml': 'sourcePaths: [src/apex]',
    });
    expect(loadProject(fs, '.').sourcePaths).toEqual(['src/apex']);
  });

  it('reads the namespace when the project declares one', () => {
    const fs = memoryFs({
      'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'f' }], namespace: 'acme' }),
    });
    expect(loadProject(fs, '.').namespace).toBe('acme');
  });

  it('refuses to guess when there are no source paths', () => {
    // Scanning the whole repository would index node_modules and produce a useless graph.
    try {
      loadProject(memoryFs(), '.');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TestImpactError).code).toBe('PROJECT_NOT_FOUND');
      expect((error as TestImpactError).remedy).toContain('sourcePaths');
    }
  });

  it('names the file when sfdx-project.json is malformed', () => {
    const fs = memoryFs({ 'sfdx-project.json': '{not json' });
    expect(() => loadProject(fs, '.')).toThrow(/not valid JSON/);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig(memoryFs(), '.').entryPointPolicy).toBe('full');
  });

  it('reads .sf-testimpact.yml', () => {
    const fs = memoryFs({ '.sf-testimpact.yml': 'entryPointPolicy: widen' });
    expect(loadConfig(fs, '.').entryPointPolicy).toBe('widen');
  });

  it('accepts the .yaml spelling too', () => {
    const fs = memoryFs({ '.sf-testimpact.yaml': 'maxReductionPercent: 42' });
    expect(loadConfig(fs, '.').maxReductionPercent).toBe(42);
  });

  it('propagates a config error with the file named', () => {
    const fs = memoryFs({ '.sf-testimpact.yml': 'entryPointPolicy: nonsense' });
    expect(() => loadConfig(fs, '.')).toThrow(/entryPointPolicy/);
  });
});

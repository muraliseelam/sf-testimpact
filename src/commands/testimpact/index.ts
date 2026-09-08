import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { runIndex } from '../../pipeline/index.js';
import { type FileSystem } from '../../graph/store.js';
import { loadProject } from '../../project.js';

/**
 * Node's filesystem, adapted to the injectable interface the pipeline uses.
 *
 * Paths reaching this adapter come from two places with two different conventions: the
 * walker yields **repository-relative** paths (they become node `declaredIn` values and
 * must match what `git diff` reports), while the store yields paths already joined to the
 * project root. Resolving every path against the root reconciles both — an already-absolute
 * path is returned unchanged by `resolve`, and a relative one is anchored to the project
 * rather than to whatever directory the process happens to be running in.
 *
 * Without this, `--root-dir` pointing anywhere other than the current directory fails to
 * read a single source file.
 */
export function createNodeFileSystem(root: string): FileSystem {
  const at = (path: string): string => resolvePath(root, path);
  return {
    readFile: (path) => readFileSync(at(path), 'utf8'),
    readBytes: (path) => readFileSync(at(path)),
    writeFile: (path, contents) => {
      writeFileSync(at(path), contents, 'utf8');
    },
    writeBytes: (path, bytes) => {
      writeFileSync(at(path), bytes);
    },
    rename: (from, to) => {
      renameSync(at(from), at(to));
    },
    remove: (path) => {
      rmSync(at(path), { force: true });
    },
    mkdirp: (path) => {
      mkdirSync(at(path), { recursive: true });
    },
    exists: (path) => existsSync(at(path)),
  };
}

/** Convenience adapter anchored at the current directory. */
export const nodeFileSystem: FileSystem = createNodeFileSystem('.');

/** Recursively lists files under each source path, skipping directories we never index. */
export function walkSourcePaths(root: string): (sourcePaths: readonly string[]) => string[] {
  const skip = new Set(['node_modules', '.git', '.sf-testimpact', '.sfdx', '.sf']);
  return (sourcePaths) => {
    const out: string[] = [];
    const visit = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return; // A configured source path that does not exist is reported by the caller.
      }
      for (const entry of entries) {
        if (skip.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) visit(full);
        else out.push(relative(root, full).replace(/\\/g, '/'));
      }
    };
    for (const path of sourcePaths) visit(join(root, path));
    return out;
  };
}

/** Machine-readable result of `sf testimpact index` (DESIGN.md 9). */
export interface IndexJson {
  readonly path: string;
  readonly files: number;
  readonly extracted: number;
  readonly reused: number;
  readonly removed: number;
  readonly nodes: number;
  readonly edges: number;
  readonly taints: number;
  readonly unparseable: readonly string[];
}

export default class TestImpactIndex extends SfCommand<IndexJson> {
  public static override readonly summary = 'Build or update the test-impact index for this project.';
  public static override readonly description =
    'Parses Apex and metadata into a dependency graph under .sf-testimpact/. ' +
    'Only files whose contents changed are re-parsed, so re-indexing is fast. ' +
    'Runs entirely locally: no org connection is opened.';

  /**
   * `sf testimpact index` is what the README, the quickstart and DESIGN.md 9 all tell people
   * to run, and it did not exist. oclif derives a command id from the file path, and
   * `commands/testimpact/index.ts` maps to the topic root `testimpact`, so the documented
   * invocation failed with "Command testimpact:index not found" - the very first line of the
   * 60-second quickstart. The alias makes the documented form work without renaming the
   * command that v0.1.0 already published.
   */
  public static override readonly aliases = ['testimpact:index'];

  public static override readonly examples = [
    '<%= config.bin %> testimpact index',
    '<%= config.bin %> testimpact index --force',
    '<%= config.bin %> testimpact index --json',
  ];

  public static override readonly enableJsonFlag = true;

  public static override readonly flags = {
    force: Flags.boolean({
      summary: 'Discard the existing index and re-parse every file.',
      default: false,
    }),
    'root-dir': Flags.directory({
      summary: 'Project directory. Defaults to the current directory.',
      default: '.',
      exists: true,
    }),
  };

  public async run(): Promise<IndexJson> {
    const { flags } = await this.parse(TestImpactIndex);
    const root = flags['root-dir'];
    const fs = createNodeFileSystem(root);
    const project = loadProject(fs, root);

    // A spinner writes to stderr, but --json output must not be interleaved with progress
    // chatter for a consumer that pipes stdout.
    if (!this.jsonEnabled()) this.spinner.start('Indexing');
    const result = runIndex(
      {
        fs,
        walk: walkSourcePaths(root),
        now: () => new Date(),
        onProgress: (done, total) => {
          if (!this.jsonEnabled()) this.spinner.status = `${done}/${total} files`;
        },
      },
      { root, project, force: flags.force },
    );
    if (!this.jsonEnabled()) this.spinner.stop();

    const { plan, graph } = result;
    const unparseable = graph.files.filter((f) => !f.parsedOk).map((f) => f.path);

    if (this.jsonEnabled()) {
      return {
        path: result.path,
        files: graph.files.length,
        extracted: result.extracted,
        reused: result.reused,
        removed: plan.removed.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        taints: graph.taints.length,
        unparseable,
      };
    }

    this.log(
      `Indexed ${graph.files.length} files: ${result.extracted} parsed, ${result.reused} unchanged` +
        (plan.removed.length > 0 ? `, ${plan.removed.length} removed` : ''),
    );
    this.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.taints.length} taints`);

    if (unparseable.length > 0) {
      // Never silent: an unparseable file degrades every future query that touches it.
      this.warn(
        `${unparseable.length} file(s) could not be parsed and are treated as depending on ` +
          `everything: ${unparseable.join(', ')}`,
      );
    }

    this.log(`Wrote ${result.path}`);
    return {
      path: result.path,
      files: graph.files.length,
      extracted: result.extracted,
      reused: result.reused,
      removed: plan.removed.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      taints: graph.taints.length,
      unparseable,
    };
  }
}

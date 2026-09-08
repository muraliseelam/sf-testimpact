/**
 * Project and config discovery.
 *
 * Reads `sfdx-project.json` for package directories and namespace, and
 * `.sf-testimpact.yml` for our own settings. Both are optional; sensible defaults apply.
 */

import { parseConfig } from './config/load.js';
import { DEFAULT_CONFIG, type Config } from './config/schema.js';
import { TestImpactError } from './errors.js';
import { type FileSystem } from './graph/store.js';
import { type ProjectInfo } from './graph/model.js';
import { joinPath } from './paths.js';
import { DEFAULT_NAMESPACE } from './types.js';

const CONFIG_NAMES = ['.sf-testimpact.yml', '.sf-testimpact.yaml'];

interface SfdxProjectJson {
  readonly packageDirectories?: Array<{ readonly path?: string }>;
  readonly namespace?: string;
}

/** Read `.sf-testimpact.yml`, or the defaults when there is none. */
export function loadConfig(fs: FileSystem, root: string): Config {
  for (const name of CONFIG_NAMES) {
    const path = joinPath(root, name);
    if (!fs.exists(path)) continue;
    try {
      return parseConfig(fs.readFile(path), path);
    } catch (error) {
      if (error instanceof TestImpactError) throw error;
      throw new TestImpactError('CONFIG_UNREADABLE', 'Could not read the config file.', {
        subject: path,
        remedy: 'Check that the file exists and is readable.',
        cause: error,
      });
    }
  }
  return DEFAULT_CONFIG;
}

/**
 * Resolve the project's source paths and namespace.
 *
 * `sourcePaths` in our own config wins; otherwise `packageDirectories` from
 * `sfdx-project.json`. A project with neither is an error rather than a silent scan of the
 * whole repository, which would index `node_modules` and produce a useless graph.
 */
export function loadProject(fs: FileSystem, root: string): ProjectInfo {
  const config = loadConfig(fs, root);
  const sfdxPath = joinPath(root, 'sfdx-project.json');

  let sfdx: SfdxProjectJson = {};
  if (fs.exists(sfdxPath)) {
    try {
      sfdx = JSON.parse(fs.readFile(sfdxPath)) as SfdxProjectJson;
    } catch (cause) {
      throw new TestImpactError('PROJECT_NOT_FOUND', 'sfdx-project.json is not valid JSON.', {
        subject: sfdxPath,
        remedy: 'Fix the JSON, or set `sourcePaths` in .sf-testimpact.yml instead.',
        cause,
      });
    }
  }

  const fromSfdx = (sfdx.packageDirectories ?? [])
    .map((d) => d.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);

  const sourcePaths = config.sourcePaths.length > 0 ? [...config.sourcePaths] : fromSfdx;
  if (sourcePaths.length === 0) {
    throw new TestImpactError('PROJECT_NOT_FOUND', 'No source paths to index.', {
      subject: root,
      remedy:
        'Run this from an sfdx project with `packageDirectories` in sfdx-project.json, or set ' +
        '`sourcePaths` in .sf-testimpact.yml.',
    });
  }

  return {
    root,
    sourcePaths,
    namespace:
      typeof sfdx.namespace === 'string' && sfdx.namespace.length > 0
        ? sfdx.namespace
        : DEFAULT_NAMESPACE,
  };
}

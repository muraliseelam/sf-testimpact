# Programmatic API

The package is a Salesforce CLI plugin, and also a Node.js library. Everything the CLI does is
available as functions, so you can drive the analysis from your own tooling: a custom CI step,
a pre-commit hook, a dashboard.

```bash
npm install sf-testimpact
```

The package is ESM-only and needs Node.js 22.13 or newer. Its exports follow the package's
semantic versioning. The `analyze --json` shape, built here by `toAnalyzeJson`, is versioned
separately by `schemaVersion` ([contract](commands.md#analyze---json)).

## Example: index a project and analyse a branch

This indexes a project, compares the current branch with a base branch, and prints what to
run. It does the same as `sf testimpact index` followed by `sf testimpact analyze`.

```js
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { analyze, gitChangedFiles, loadConfig, loadProject, runIndex, toAnalyzeJson } from 'sf-testimpact';

const root = resolve(process.argv[2] ?? '.');
const base = process.argv[3] ?? 'main';

// The library takes its filesystem, directory walk and git as plain functions, so it can run
// against anything. These are the Node.js versions, equivalent to what the CLI uses.
const at = (path) => resolve(root, path);
const fs = {
  readFile: (path) => readFileSync(at(path), 'utf8'),
  readBytes: (path) => readFileSync(at(path)),
  writeFile: (path, contents) => writeFileSync(at(path), contents, 'utf8'),
  writeBytes: (path, bytes) => writeFileSync(at(path), bytes),
  rename: (from, to) => renameSync(at(from), at(to)),
  remove: (path) => rmSync(at(path), { force: true }),
  mkdirp: (path) => mkdirSync(at(path), { recursive: true }),
  exists: (path) => existsSync(at(path)),
};
const SKIP = new Set(['node_modules', '.git', '.sf-testimpact', '.sfdx', '.sf']);
const walk = (sourcePaths) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else files.push(relative(root, full).replaceAll('\\', '/'));
    }
  };
  for (const path of sourcePaths) if (existsSync(join(root, path))) visit(join(root, path));
  return files;
};
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const project = loadProject(fs, root);
const { graph } = runIndex({ fs, walk, now: () => new Date() }, { root, project });
const config = loadConfig(fs, root);
const changed = gitChangedFiles(git, base);
const result = analyze(graph, changed, config);
const json = toAnalyzeJson({ result, graph, base, head: 'HEAD', changedFiles: changed.length });

if (json.fellBack) {
  const rules = json.decisions.filter((d) => d.level === 'fallback').map((d) => d.rule);
  console.log(`Run the full suite (${json.testLevel}): ${rules.join(', ')}`);
} else {
  console.log(`Run ${json.selectedCount} of ${json.totalTests} test classes: ${json.tests.map((t) => t.name).join(', ')}`);
}
```

Run against the repository's sample project, on a branch that changes one class:

```
$ node example.mjs ./sample-project main
Run the full suite (RunLocalTests): entry-point-policy-full

$ echo "entryPointPolicy: widen" > ./sample-project/.sf-testimpact.yml
$ node example.mjs ./sample-project main
Run 3 of 3 test classes: DispatcherTest, LegacyDataTest, PricingServiceTest
```

The library never touches the filesystem, git or the clock directly. Each is passed in, which
is why the example supplies `fs`, `walk`, `git` and `now`. The same design is what lets the
whole pipeline run in unit tests with no files and no repository.

## What is exported

| Area | Exports |
| --- | --- |
| Indexing | `runIndex`, `loadProject`, `planReindex`, `filesToExtract`, `mergeFacts`, `mergeFiles` |
| The stored index | `loadGraph`, `saveGraph`, `buildGraph`, `checkStaleness`, `graphPath`, `currentGenerator`, `hashContents`, `hashBytes` |
| Configuration | `loadConfig`, `parseConfig`, `DEFAULT_CONFIG`, and the allowed values `ENTRY_POINT_POLICIES`, `ON_EXCEED_VALUES`, `TAINT_ACTIONS`, `FULL_TEST_LEVELS` |
| Analysis | `analyze`, `formatDecisions`, `gitChangedFiles`, `resolveChangeSet`, `componentPathFor`, `computeImpacted`, `computeReachable` |
| Selection and safety | `selectTests`, `allTestClasses`, `coveringTests`, `coverageGaps`, `checkFallbacks`, `applyEntryPointPolicy`, `checkReduction` |
| Reporting | `toAnalyzeJson`, `ANALYZE_SCHEMA_VERSION` |
| Deployment | `buildDeployPlan`, `verifyCoverage`, `findCoverageRegressions`, `payloadClasses`, `coveragePercent`, `COVERAGE_FLOOR_PERCENT` |
| Extraction | `extractFile`, `extractApex`, `extractorFor`, `isModelledPath`, `staticResourceOwnerOf`, `ALL_EXTRACTOR_IDS` |
| The graph | `ImpactGraph`, `resolve`, `SymbolTable`, `domainsOf`, `isCustomApiName`, `namespaceForMetadata`, `makeNodeKey`, `NodeFlags`, `hasFlag`, `formatLoc`, `DEFAULT_NAMESPACE`, `STANDARD_NAMESPACE`, `UNKNOWN_OBJECT` |
| Errors | `TestImpactError` (with `code`, `subject`, `remedy`), `ConfigError`, `ExtractorError` |
| Versions | `TOOL_VERSION`, `GRAPH_FORMAT_VERSION`, `APEX_PARSER_VERSION`, `majorVersion` |

Types for all of these ship with the package. The TSDoc comments in the source explain each
function's contract, and [how it works](how-it-works.md) explains the concepts behind them.

## The pieces you are most likely to want

- **`analyze(graph, changed, config)`** is pure: given a loaded graph, a change set and a
  config, it returns the outcome, the selected tests and every decision. Call it as often as
  you like, for instance once per policy to compare them.
- **`gitChangedFiles(git, base, head)`** runs `git diff --name-status --find-renames
  --relative base...head` through the function you pass, from the project root.
- **`toAnalyzeJson(...)`** builds exactly what `analyze --json` prints as `result`.
- **`buildDeployPlan(result, config, passthrough)`** gives the `sf project deploy start`
  arguments `deploy` would use.
- **`TestImpactError`** is what every expected failure throws. `code` is one of the
  [error codes](rules.md#error-codes), and `remedy` says what to do.

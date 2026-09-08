#!/usr/bin/env node
/**
 * Adapter that lets the `sfdb` benchmark score sf-testimpact.
 *
 * sfdb hands a selector a *source tree* plus a list of changed files. sf-testimpact's
 * `analyze` normally takes a git range, but the query layer underneath it takes a plain
 * `ChangedFile[]`, so no git repository is needed — this indexes the tree and calls that
 * directly.
 *
 * Reads a JSON request on stdin and writes a JSON response on stdout:
 *
 *   request  { root, changed: [{path, kind}], entryPointPolicy?, sourcePaths? }
 *   response { selectedTests, impactedComponents, outcome, decisions, totalTests }
 *
 * The tree it is given is the AFTER state, matching how the tool is really run: you index
 * your branch, then diff against a base.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';

import { runIndex } from '../lib/pipeline/index.js';
import { analyze } from '../lib/query/analyze.js';
import { DEFAULT_CONFIG } from '../lib/config/schema.js';
import { NodeFlags, hasFlag } from '../lib/types.js';

function readStdin() {
  return readFileSync(0, 'utf8');
}

function fsAt(root) {
  const at = (p) => resolvePath(root, p);
  return {
    readFile: (p) => readFileSync(at(p), 'utf8'),
    writeFile: (p, c) => writeFileSync(at(p), c, 'utf8'),
    mkdirp: (p) => mkdirSync(at(p), { recursive: true }),
    exists: (p) => existsSync(at(p)),
  };
}

function walker(root) {
  const skip = new Set(['node_modules', '.git', '.sf-testimpact', '.sfdx', '.sf']);
  return () => {
    const out = [];
    const visit = (dir) => {
      let entries;
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (skip.has(e)) continue;
        const full = join(dir, e);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) visit(full);
        else out.push(relative(root, full).replace(/\\/g, '/'));
      }
    };
    visit(root);
    return out;
  };
}

/**
 * Map a graph node to an sfdb component key (`MetadataType:ApiName`).
 *
 * Only kinds with an unambiguous sfdb counterpart are mapped. Anything else is omitted
 * rather than guessed: a wrong component key would be scored as a wrong prediction, which
 * would misreport the selector rather than merely under-report it.
 */
function componentKeyOf(node) {
  switch (node.kind) {
    case 'apex':
    case 'apexInner':
      return `ApexClass:${node.name}`;
    case 'trigger':
      return `ApexTrigger:${node.name}`;
    case 'sobject':
      return `CustomObject:${node.name}`;
    case 'field':
      return `CustomField:${node.name}`;
    case 'flow':
      return `Flow:${node.name}`;
    case 'permset':
      return `PermissionSet:${node.name}`;
    case 'label':
      return `CustomLabel:${node.name}`;
    case 'staticresource':
      return `StaticResource:${node.name}`;
    default:
      return null;
  }
}

const request = JSON.parse(readStdin());
const root = request.root;
const project = {
  root,
  sourcePaths: request.sourcePaths ?? ['force-app'],
  namespace: 'c',
};
const config = {
  ...DEFAULT_CONFIG,
  entryPointPolicy: request.entryPointPolicy ?? DEFAULT_CONFIG.entryPointPolicy,
  // The benchmark scores recall and cost directly; the circuit breaker would mask both by
  // converting a small selection into a full run for reasons unrelated to the graph.
  maxReductionPercent: 100,
};

const fs = fsAt(root);
const indexed = runIndex({ fs, walk: walker(root), now: () => new Date(0) }, { root, project, force: true });
const result = analyze(indexed.graph, request.changed, config);

const impacted = [];
for (const key of result.impacted) {
  const node = indexed.graph.nodeByKey(key);
  if (node === undefined) continue;
  const componentKey = componentKeyOf(node);
  if (componentKey !== null) impacted.push(componentKey);
}

// On a fallback the tool runs the whole suite, so the honest selection is every test.
const allTests = indexed.graph.nodes
  .filter((n) => hasFlag(n.flags, NodeFlags.IS_TEST))
  .map((n) => n.name);
const selectedTests = result.outcome === 'full' ? allTests : result.tests.map((t) => t.name);

process.stdout.write(
  JSON.stringify({
    selectedTests: [...new Set(selectedTests)].sort(),
    impactedComponents: [...new Set(impacted)].sort(),
    outcome: result.outcome,
    totalTests: result.totalTests,
    decisions: result.decisions.map((d) => ({ level: d.level, rule: d.rule, subject: d.subject })),
  }),
);

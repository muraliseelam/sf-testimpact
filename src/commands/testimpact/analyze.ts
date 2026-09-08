import { execFileSync } from 'node:child_process';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { loadGraph } from '../../graph/store.js';
import { TestImpactError } from '../../errors.js';
import { analyze, formatDecisions } from '../../query/analyze.js';
import { gitChangedFiles, type GitRunner } from '../../query/changeSet.js';
import { toAnalyzeJson, type AnalyzeJson } from '../../report/json.js';
import { loadConfig } from '../../project.js';
import { createNodeFileSystem } from './index.js';

/** Runs git in the project directory. Separated so the pipeline stays testable. */
export function gitRunner(root: string): GitRunner {
  return (args) => execFileSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export default class TestImpactAnalyze extends SfCommand<AnalyzeJson> {
  public static override readonly summary = 'Report which Apex tests a change set can affect.';
  public static override readonly description =
    'Resolves changed files to graph nodes, computes the reverse transitive closure, and ' +
    'reports the tests to run. Runs entirely locally: no org connection is opened. ' +
    'Any unresolvable or dynamic reference widens the result or falls back to a full run, ' +
    'and every such decision is printed with the rule that caused it.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --base main',
    '<%= config.bin %> <%= command.id %> --base main --head feature/x --json',
  ];

  public static override readonly enableJsonFlag = true;

  public static override readonly flags = {
    base: Flags.string({ summary: 'Base git ref to compare from.', required: true }),
    head: Flags.string({ summary: 'Head git ref to compare to.', default: 'HEAD' }),
    'root-dir': Flags.directory({ summary: 'Project directory.', default: '.', exists: true }),
    'fail-on-fallback': Flags.boolean({
      summary: 'Exit non-zero when the run degrades to a full test suite.',
      default: false,
    }),
  };

  public async run(): Promise<AnalyzeJson> {
    const { flags } = await this.parse(TestImpactAnalyze);
    const root = flags['root-dir'];

    const fs = createNodeFileSystem(root);
    const graph = loadGraph(fs, root);
    if (graph === null) {
      throw new TestImpactError('GRAPH_STALE', 'No index found for this project.', {
        subject: root,
        remedy: 'Run `sf testimpact index` first.',
      });
    }

    const config = loadConfig(fs, root);
    const changed = gitChangedFiles(gitRunner(root), flags.base, flags.head);
    const result = analyze(graph, changed, config);
    const json = toAnalyzeJson({
      result,
      graph,
      base: flags.base,
      head: flags.head,
      changedFiles: changed.length,
    });

    if (!this.jsonEnabled()) this.render(json, result.decisions.length > 0);

    if (flags['fail-on-fallback'] && result.outcome === 'full') {
      process.exitCode = 1;
    }
    return json;
  }

  private render(json: AnalyzeJson, hasDecisions: boolean): void {
    this.log(`Changed files: ${json.changedFiles}  (${json.range.base}...${json.range.head})`);

    if (hasDecisions) {
      this.log('');
      for (const line of formatDecisions(
        json.decisions.map((d) => ({
          level: d.level,
          rule: d.rule,
          subject: d.subject,
          message: d.message,
          ...(d.hint === null ? {} : { hint: d.hint }),
        })),
      )) {
        this.log(line);
      }
    }

    this.log('');
    if (json.outcome === 'full') {
      this.log(`Running the full suite (${json.testLevel}). See the FALLBACK lines above.`);
      // The one number a reader needs to judge the setting, measured on their own code.
      // Without it "try entryPointPolicy: widen" is advice they cannot evaluate.
      if (json.counterfactual !== null) {
        const c = json.counterfactual;
        this.log('');
        this.log(
          `With \`entryPointPolicy: ${c.policy}\` this change set would select ` +
            `${c.wouldSelect} of ${c.totalTests} tests (${c.reductionPercent}% skipped).`,
        );
        this.log(
          `  That assumes nothing outside this repository calls: ${c.assumesNoExternalCallerOf.join(', ')}`,
        );
      }
    } else {
      this.log(
        `Selected ${json.selectedCount} of ${json.totalTests} tests ` +
          `(${json.reductionPercent.toFixed(1)}% skipped)`,
      );
      for (const test of json.tests) {
        this.log(`  ${test.name}${test.reason === 'impacted' ? '' : `  [${test.reason}]`}`);
      }
    }

    if (json.coverageGaps.length > 0) {
      // Worth surfacing whatever the selection decided: under RunSpecifiedTests each class
      // in the payload needs 75% on its own, and a class no test reaches cannot get there.
      this.warn(
        `No test reaches these changed classes, so a production deploy would fail on ` +
          `coverage: ${json.coverageGaps.join(', ')}`,
      );
    }
  }
}

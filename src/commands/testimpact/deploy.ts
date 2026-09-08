import { spawnSync } from 'node:child_process';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { loadGraph } from '../../graph/store.js';
import { TestImpactError } from '../../errors.js';
import { analyze } from '../../query/analyze.js';
import { gitChangedFiles } from '../../query/changeSet.js';
import { allTestClasses } from '../../query/selection.js';
import { buildDeployPlan } from '../../deploy/plan.js';
import {
  COVERAGE_FLOOR_PERCENT,
  findCoverageRegressions,
  payloadClasses,
  verifyCoverage,
  type CoverageClient,
} from '../../deploy/coverage.js';
import { loadConfig } from '../../project.js';
import { createNodeFileSystem } from './index.js';
import { gitRunner } from './analyze.js';

export interface DeployResult {
  readonly testLevel: string;
  readonly tests: readonly string[];
  readonly deployed: boolean;
  readonly blockers: readonly string[];
}

export default class TestImpactDeploy extends SfCommand<DeployResult> {
  public static override readonly summary = 'Deploy, running only the tests the change set can affect.';
  public static override readonly description =
    'Wraps `sf project deploy start`, passing --test-level RunSpecifiedTests with the ' +
    'computed test list, or the configured full test level when anything forced a fallback.\n\n' +
    'Selection cannot reduce per-class coverage: the reverse closure selects EVERY test that ' +
    'reaches a changed class, not a minimal subset, so each class is covered exactly as it ' +
    'would be under RunLocalTests. That argument assumes the graph knows every caller, which ' +
    'is false when the org holds Apex the repository does not — use --verify-coverage to ' +
    'check that against a real org.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --base main',
    '<%= config.bin %> <%= command.id %> --base main --verify-coverage --target-org prod',
  ];

  public static override readonly enableJsonFlag = true;
  public static override readonly strict = false; // Unrecognised flags pass through to the deploy.

  public static override readonly flags = {
    base: Flags.string({ summary: 'Base git ref to compare from.', required: true }),
    head: Flags.string({ summary: 'Head git ref to compare to.', default: 'HEAD' }),
    'root-dir': Flags.directory({ summary: 'Project directory.', default: '.', exists: true }),
    'verify-coverage': Flags.boolean({
      summary: 'Check per-class coverage against the target org before deploying.',
      description:
        'Queries ApexCodeCoverageAggregate via the Tooling API and refuses to deploy if any ' +
        'class in the payload sits under 75%. This is the only flag that contacts an org.',
      default: false,
    }),
    'target-org': Flags.string({ summary: 'Target org username or alias.', char: 'o' }),
    'dry-run': Flags.boolean({
      summary: 'Print the deploy command instead of running it.',
      default: false,
    }),
  };

  public async run(): Promise<DeployResult> {
    const { flags, argv } = await this.parse(TestImpactDeploy);
    const root = flags['root-dir'];

    const fs = createNodeFileSystem(root);
    const graph = loadGraph(fs, root);
    if (graph === null) {
      throw new TestImpactError('GRAPH_STALE', 'No index found for this project.', {
        subject: root,
        remedy: 'Run `sf testimpact index` first.',
      });
    }

    // Validated here rather than with oclif's `dependsOn`: on a boolean flag with
    // `default: false`, `dependsOn` fires from the DEFAULT, so every plain
    // `deploy --base X` failed with "must be provided when using --verify-coverage".
    // The dependency only exists when the flag is actually set.
    if (flags['verify-coverage'] && flags['target-org'] === undefined) {
      throw new TestImpactError('CONFIG_INVALID', '--verify-coverage needs an org to query.', {
        subject: '--verify-coverage',
        remedy: 'Pass --target-org <alias>, or drop --verify-coverage to deploy without the check.',
      });
    }

    const config = loadConfig(fs, root);
    const changed = gitChangedFiles(gitRunner(root), flags.base, flags.head);
    const result = analyze(graph, changed, config);

    const passthrough = argv.filter((a): a is string => typeof a === 'string' && a.startsWith('-'));
    const plan = buildDeployPlan(result, config, [
      ...(flags['target-org'] === undefined ? [] : ['--target-org', flags['target-org']]),
      ...passthrough,
    ]);
    this.log(plan.rationale);

    // The §9.1 property, checked rather than assumed. It must always hold; if it does not,
    // the closure lost an edge and the deploy should not proceed on a broken claim.
    const regressions = findCoverageRegressions(graph, result.seeds, plan.tests);
    if (regressions.length > 0 && result.outcome === 'selected') {
      throw new TestImpactError(
        'GRAPH_CORRUPT',
        'Selection would reduce per-class coverage, which should be impossible. ' +
          regressions
            .map((r) => `${r.className} is covered by ${r.missingTests.join(', ')}, none selected`)
            .join('; '),
        {
          subject: root,
          remedy:
            'This is a bug in sf-testimpact. Re-run `sf testimpact index --force`; if it ' +
            'persists, please report it. Deploy with --test-level RunLocalTests meanwhile.',
        },
      );
    }

    const blockers: string[] = [];
    if (flags['verify-coverage']) {
      blockers.push(...(await this.checkOrgCoverage(graph, result, flags['target-org'])));
      if (blockers.length > 0) {
        throw new TestImpactError('GRAPH_STALE', 'Deployment would fail on Apex code coverage.', {
          subject: flags['target-org'] ?? 'target org',
          remedy: `Add tests for: ${blockers.join(', ')}`,
        });
      }
    }

    if (flags['dry-run']) {
      this.log(`sf project deploy start ${plan.args.join(' ')}`);
      return { testLevel: plan.testLevel, tests: plan.tests, deployed: false, blockers };
    }

    const child = spawnSync('sf', ['project', 'deploy', 'start', ...plan.args], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (child.status !== 0) process.exitCode = child.status ?? 1;

    return { testLevel: plan.testLevel, tests: plan.tests, deployed: true, blockers };
  }

  /** Lazily loads jsforce so index and analyze never open a connection. */
  private async checkOrgCoverage(
    graph: NonNullable<ReturnType<typeof loadGraph>>,
    result: ReturnType<typeof analyze>,
    targetOrg: string | undefined,
  ): Promise<string[]> {
    const payload = payloadClasses(graph, result.seeds);
    if (payload.length === 0) return [];

    const client = await this.createCoverageClient(targetOrg);
    const repoTests = allTestClasses(graph).map((n) => n.name);
    const verdict = await verifyCoverage(client, payload, repoTests);

    this.log(`Checked coverage for ${verdict.checked} class(es) against the org.`);
    this.log('Note: this is the org\'s coverage from its LAST test run, not a prediction of the run about to happen.');

    if (verdict.orgOnlyTests.length > 0) {
      // This is the §9.2 breaker made concrete: their existence means the completeness
      // premise behind the coverage argument is false for this org.
      this.warn(
        `The org has ${verdict.orgOnlyTests.length} test class(es) that this repository does ` +
          'not, so they contribute coverage under RunLocalTests but not under RunSpecifiedTests: ' +
          verdict.orgOnlyTests.slice(0, 10).join(', ') +
          (verdict.orgOnlyTests.length > 10 ? ', ...' : ''),
      );
    }

    for (const blocker of verdict.blockers) {
      this.warn(
        blocker.reason === 'no-coverage-data'
          ? `${blocker.className} has no coverage data in this org; it would deploy at 0%.`
          : `${blocker.className} is at ${blocker.percent.toFixed(1)}%, below the ${COVERAGE_FLOOR_PERCENT}% floor.`,
      );
    }
    return verdict.blockers.map((b) => b.className);
  }

  private async createCoverageClient(targetOrg: string | undefined): Promise<CoverageClient> {
    // Dynamic imports: these are the only lines in the tool that can reach an org, and
    // keeping them here means `index` and `analyze` cannot load them even by accident.
    const [{ Org }, { createToolingCoverageClient }] = await Promise.all([
      import('@salesforce/core'),
      import('../../deploy/toolingClient.js'),
    ]);
    const org = await Org.create(targetOrg === undefined ? {} : { aliasOrUsername: targetOrg });
    return createToolingCoverageClient(org.getConnection() as unknown as Parameters<typeof createToolingCoverageClient>[0]);
  }
}

# Document the tool for the people who use it

## Why

The project's documentation is thorough and almost entirely written for one reader: someone
auditing whether the tool's claims are true. The README is 777 lines, of which the
configuration, command and JSON references are a few dozen lines near the bottom, after the
benchmark history, the ablation tables and the account of an extractor that was deleted. A
user who wants to install the plugin, wire it into CI and read a `FALLBACK` line has no page
written for them: no CI guide beyond one snippet, no reference for the rules that appear in
the output, no reference for the error codes, no troubleshooting page.

Writing those pages against the code, rather than against the existing prose, found that
some of what they would have to say is wrong:

| Finding | Effect |
| --- | --- |
| `taint.dynamicApex` and `taint.dynamicSoql` are validated and documented but read by nothing | Setting either to `full` silently does nothing |
| `taint.unmodelledFileType: widen` ignores the changed file without a word | A safety degradation with no log line, against the project's own rule |
| The entry-point fallback says "full list in `--json`", but `--json` drops the list | The promise is true only when the counterfactual happens to be offered |
| README documents `coverageGaps` as `object[]` | It is `string[]` |
| A plain `index` after a plugin upgrade reuses facts from the old extractor | Every analysis then falls back until someone runs `index --force` |
| `deploy`'s help shows `-- --source-dir force-app` | The whole-directory payload that live testing showed fails per-class coverage |
| A coverage blocker exits with code `GRAPH_STALE` | Nothing about the graph is stale |

Documentation that described these accurately would be documenting defects, so they are
fixed first.

## What changes

1. **Fix the defects above**, each with tests, so the documented behaviour is the real one.
2. **A user-facing documentation set under `docs/`**: getting started, how it works,
   configuration reference, command reference (generated from the command definitions by
   `oclif readme`, with a CI check that it is current), rules and error-code reference, CI
   integration, troubleshooting and FAQ, limitations, benchmarks, and the programmatic API.
3. **A README that is a landing page**: what the tool does and does not guarantee, install,
   quickstart, the headline measured numbers, and a map of the documentation. The measured
   material moves to `docs/benchmarks.md` and `docs/limitations.md` unchanged, with its
   artifact links, so the evidence rule in `docs/AUDIT.md` still holds.

## Non-goals

- Changing defaults or selection behaviour beyond the defects listed.
- A hosted documentation site. The pages render on GitHub and on npm as they stand; a site
  is a separate decision.
- Rewriting `DESIGN.md`, `CORRECTNESS-PLAN.md`, `USER-TESTING.md` or `AUDIT.md`, which remain
  the design and evidence of record.

## Impact

- `src/query/safety.ts`, `src/query/analyze.ts`, `src/report/json.ts`,
  `src/pipeline/index.ts`, `src/commands/testimpact/deploy.ts`, `src/errors.ts`, with tests.
- New pages under `docs/`; `README.md` restructured; `package.json` gains a
  `docs:commands` script; CI checks the generated command reference.
- `analyze --json` gains `decisions[].subjects`, an additive change within schema version 1.

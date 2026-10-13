# sf-testimpact documentation

`sf-testimpact` is a Salesforce CLI plugin that reads your Apex and metadata, works out which
Apex tests a change can affect, and deploys with only those. It is built around one rule:
**over-approximate freely, under-approximate never.** Anything it cannot see clearly makes
it select more tests or run all of them, and it prints the reason every time.

Start with the page that matches what you are doing.

## Use it

| Page | Read it when you want to |
| --- | --- |
| [Getting started](getting-started.md) | Install the plugin, build an index, read your first analysis, deploy with the selected tests |
| [How it works](how-it-works.md) | Understand why a test was or was not selected |
| [Configuration](configuration.md) | Look up a key in `.sf-testimpact.yml` |
| [Commands](commands.md) | Look up a command, a flag, an exit code, or a field of `--json` |
| [Rules and error codes](rules.md) | Find out what a `FALLBACK`, `WIDEN` or `INFO` line or an error code means, and what to do about it |
| [CI integration](ci.md) | Run it in GitHub Actions or GitLab CI |
| [Troubleshooting and FAQ](troubleshooting.md) | Fix something that went wrong, or check a common question |
| [Programmatic API](api.md) | Drive the analysis from your own Node.js code |

## Judge it

| Page | What it covers |
| --- | --- |
| [Limitations](limitations.md) | Every known way selection can miss a test, and which are mitigated |
| [Benchmarks](benchmarks.md) | Every measured figure, each linked to the artifact that produced it |
| [Correctness plan](CORRECTNESS-PLAN.md) | How the false-negative rate is measured, and what the first live measurement found |
| [User testing](USER-TESTING.md) | Verbatim sessions driving the published plugin, against a live org, and while documenting it |
| [Evidence audit](AUDIT.md) | The rule every claim in this documentation is held to |

## Build on it

| Page | What it covers |
| --- | --- |
| [Design](DESIGN.md) | The design of record: graph schema, taint model, query algorithm, and why |
| [Contributing](../CONTRIBUTING.md) | How to change the tool without making it select fewer tests by accident |
| [Releasing](../RELEASING.md) | How a release reaches npm |

## A note on the output quoted in these pages

Every command output in this documentation comes from a real run, not from what the code is
expected to print. The runs are retained in [`measurements/`](measurements/): the
walk-through in [getting started](getting-started.md) is
[`quickstart-apex-recipes-1.3.1.txt`](measurements/quickstart-apex-recipes-1.3.1.txt), the
error and edge cases are [`docs-sample-project.txt`](measurements/docs-sample-project.txt),
and the behaviour before and after the fixes in 1.3.1 is
[`fixes-1.3.1-before-after.txt`](measurements/fixes-1.3.1-before-after.txt). The script that
produced each transcript sits next to it, named `capture-*.sh`.

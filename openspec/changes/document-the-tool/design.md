# Design

## Decisions

### Decision: `taint.dynamicApex` / `taint.dynamicSoql: full` fall back when the domain activates

The schema documents these keys as "how far to degrade for a given class of unknown", with
the same `full | widen` values as `taint.onParseError`, whose `full` means "run everything".
So `full` here means: when a change activates a taint domain that contains at least one
**dynamic construct**, run the full suite instead of selecting the dynamically-dispatching
tests.

- `dynamicApex` governs the `apexType` domain (`Type.forName`, `Type.newInstance`,
  `Callable.call`, `Database.executeBatch`, `System.enqueueJob`, `System.schedule`,
  computed custom-permission names).
- `dynamicSoql` governs `sobjectAny` and `fieldAny` (`Database.query` and friends,
  `Search.query`, SOSL, `Schema.getGlobalDescribe`, `SObject.get/put` by name).
- `resourceAny` (computed static-resource names) has no setting and always widens.
- Taint that comes from an **unparseable file** is excluded: that is governed by
  `taint.onParseError`, and counting it here would make an unrelated parse failure decide
  this setting.

In a codebase with any `Type.forName`, `dynamicApex: full` falls back on nearly every Apex
change, because changing any class activates `apexType`. That is what the setting asks for,
and the reference says so. The default stays `widen`, so nothing changes for anyone who has
not set it.

**Alternative rejected:** warn that the keys have no effect. Honest, but it leaves a
documented safety setting unimplemented when the intended behaviour is unambiguous.

### Decision: `taint.unmodelledFileType: widen` is visible, and documented as "ignore"

There is no meaningful widening for a file type the tool does not model: nothing in the
graph depends on it, so there is nothing to walk from. The only safe answer is a full run,
which is the default. `widen` therefore keeps its current effect — the change does not force
a full run — but now emits an `info` decision, `unmodelled-file-type-ignored`, naming the
file. The reference documents it as what it is.

### Decision: `decisions[].subjects` is always present

Every decision carries `subjects`: every node or file the rule fired on, `[subject]` for a
single-subject rule. Always present, like `hint`, so a consumer never distinguishes "absent"
from "one". Additive within `schemaVersion: 1`.

### Decision: a stale stored index is re-extracted, not reused

`runIndex` checks the stored index with the same `checkStaleness` that `analyze` uses. If the
format version, the parser major version or any extractor identity differs from this build,
it re-extracts every file, exactly as `--force` would, and the command says so. Reusing
facts from an older extractor produces an index that `analyze` must then refuse.

### Decision: the command reference is generated

`oclif readme` renders usage, flags, descriptions and examples from the command classes into
`docs/commands.md` between markers. `npm run docs:commands` regenerates it, and CI runs it
and fails on a diff, so the reference cannot drift from the code. Exit codes, the JSON
contract and the `--` passthrough are hand-written above the generated block.

### Decision: measured material moves verbatim

`docs/benchmarks.md` and `docs/limitations.md` take the README's measured sections with their
numbers and artifact links unchanged. `docs/AUDIT.md` gains a note recording the move, and
the release checklist checks the new location.

## Decisions taken while capturing the documentation's output

Running every documented command, rather than describing what it should print, found four
more defects. Each is fixed with tests, as tasks 1.7 to 1.11 record.

### Decision: changed paths come from `git diff --relative`

git reports paths from the top of the repository, and the index stores them from the project
root. A project in a subdirectory of its repository therefore had every changed path ignored,
and selected only the tests that always run: a silent false negative at the default policy.
`--relative`, run in the project root, reports project-relative paths and leaves out changes
outside the project, which the project cannot deploy.

### Decision: the passthrough is read from the raw command line

oclif sorts its parsed `argv` by each token's first position on the command line, so a flag
repeated after `--` lost its pairing with its values. `deploy` now takes everything after the
first `--` verbatim. oclif's `argv` is still used to detect a positional argument before the
separator, which `deploy` reports as `CONFIG_INVALID` instead of forwarding.

### Decision: a test method's `SeeAllData=true` makes its class always run

A method annotated `@isTest(SeeAllData=true)` reads org data exactly as a class-level
annotation does, so its class can never be shown unaffected. The extractor now flags the
class, and its identity moves to `apex@2` so that every stored index is rebuilt.

### Decision: unindexed files are classified by the extractors

Whether a changed file that is missing from the index means "re-run index" or "unmodelled
type" now comes from the same extractor dispatch that indexing uses, not from a hand-kept
extension list that had drifted from it in both directions.

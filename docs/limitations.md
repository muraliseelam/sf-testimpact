# Limitations

Every known way the selection can miss a test that would have caught a regression, and what
mitigates each. Most of them either degrade loudly or select extra tests. Two do neither:
[items 14 and 15](#items-14-and-15-deserve-separate-emphasis) are the cases where the tool is
confidently wrong rather than visibly conservative, and they are worth reading first.

The coverage argument behind `RunSpecifiedTests`, and where it breaks, follows the table.

## Known false-negative sources

Eight are unmitigated: six marked **NOT MITIGATED**, and two (items 8 and 13) whose
documented mitigation measurement disproved.

| # | Source | Status |
| --- | --- | --- |
| 1 | Dynamic Apex / dynamic SOQL | mitigated — taint |
| 2 | Invocation from outside the repo (scheduled jobs, REST clients) | mitigated — entry-point taint |
| 3 | Tests depending on live org data | mitigated — `SeeAllData` tests always run, whether the annotation is on the class or on a test method (method-level since 1.3.1) |
| 4 | Managed-package behaviour change | **NOT MITIGATED** — no source |
| 5 | Custom Metadata / Custom Setting *records* | **PARTIAL** — repo records indexed; org-side invisible |
| 6 | Trigger execution *order* via handler config | **NOT MITIGATED** — order is org state |
| 7 | Formula fields and validation rules | mitigated — `formulaRef` edges |
| 8 | FLS / sharing changes | **CLAIMED MITIGATED, MEASURED FALSE** — see below |
| 9 | Coupling only through the database | **PARTIAL** |
| 10 | Concurrency and row-lock behaviour | **NOT MITIGATED** — beyond static analysis |
| 11 | Custom labels | mitigated, coarse — all labels share one file |
| 12 | Custom permissions | mitigated for string literals only |
| 13 | Translations | **CLAIMED MITIGATED, MEASURED FALSE** — see below |
| 14 | **Tests in the org but absent from the repo** | **NOT MITIGATED statically** |
| 15 | **A dynamic-dispatch construct outside our detection table** | **NOT MITIGATED** |
| 16 | LWC / Aura calling Apex | **extractor deleted** — LWC files now force a full run |
| 17 | DataWeave `.dwl` scripts | **NOT MODELLED** — forces a full run, which is the safe answer |
| 18 | Static resources | mitigated — bundles and single-file resources modelled, Apex references extracted |
| 19 | **A Flow, Process Builder or permission set changing** | **NOT MITIGATED** — selects zero Apex tests; see below |

### Items 14 and 15 deserve separate emphasis

Every other row either degrades loudly or over-selects. **These two are the cases where the
tool is confidently wrong rather than visibly conservative** — it reports a small, confident
test list and is silently missing something.

- **Item 14 — org-only tests.** The tool reasons over the repository. If the org holds test
  classes the repo does not, the coverage argument is false for that org and nothing in the
  graph reveals it. Use `deploy --verify-coverage`.
- **Item 15 — undetected dynamic dispatch.** Taint covers the constructs in our table. A
  codebase with its own reflection helper — a factory resolving class names through a Custom
  Metadata lookup, say — defeats it silently. There is no diagnostic for a construct we do
  not know about.

### Items 8 and 13: a documented mitigation that measurement disproved

`grants` and `translates` edges point permission-set → class and translation → label, and the
query walks edges *backwards*, so nothing depends on a permission set or a translation.
Verified directly:

```
seed = permset:c.ops   -> []          no tests selected
seed = flow:c.f        -> []
seed = label:c.banner  -> ["SvcTest"]  (labels work: Apex references them)
```

Changing a permission set, a flow or a translation selects **zero** tests — verified
directly against a project containing a Flow whose only action calls an `@InvocableMethod`:
editing the `.flow-meta.xml` selected no test but the always-run `SeeAllData` one, while
editing the Apex the flow calls selected that method's test correctly. The ablation shows
the same from the other side, and now at the level of the individual relationship: removing
all 2,800 `grants` edges and all 40 `flowTouches` edges changes the selection on zero of the
20 commits. The edges are real and useful for reporting blast radius; they do not drive test
selection. Unresolved.

### Other known gaps

- **No worker pool.** Indexing is single-threaded; the design specifies parallel parsing.
- **Run against a live org exactly once.** The harness, `deploy` and `--verify-coverage` ran
  against scratch orgs on 2026-10-12 ([findings](USER-TESTING.md#live-org-2026-10-12)).
  No sandbox or production org has ever run it.
- **`alwaysRun` globs do not match backslash paths.** Latent — git emits forward slashes and
  the indexer normalises — but pinned by a test.

## Coverage under `RunSpecifiedTests`

`RunSpecifiedTests` requires **every class and trigger in the deployment to individually
reach 75% coverage**, computed only from the tests actually executed. Org-wide averages do
not save an under-covered class, so "we included a covering test" would be worthless — one
test can leave a class at 20% and fail the deploy.

The property that does hold follows from the closure being *complete*, not *minimal*:

> For every class `C` in the payload, coverage of `C` under the selected test set is
> **identical** to its coverage under `RunLocalTests`.
>
> A test `t` contributes coverage to `C` only by executing lines of `C`, which needs a call
> path `t → … → C`. Every such path is a forward path in the graph. `C` is in the payload,
> so `C` changed, so `C` is a seed of the reverse closure — and the reverse closure yields
> *every* node with a forward path to a seed. Hence `selected ⊇ { t : t covers C }`, and
> tests outside that set contribute zero lines to `C`.

**Selection cannot reduce per-class coverage.** `deploy` verifies this rather than assuming
it, and refuses to proceed if it ever fails.

### Where the argument breaks

It is conditional on the graph's *inbound* edges to `C` being complete:

| Breaker | Mitigation | Residual risk |
| --- | --- | --- |
| A test reaches `C` only dynamically | Taint pulls in dynamically-dispatching tests | Only if the construct is outside our detection table |
| A dynamic construct we do not recognise | none | **Real hole** |
| `entryPointPolicy: strict` | none, by the user's explicit choice | The opt-in exists for this |
| **Tests in the org but not the repo** | none — no static analysis can see them | **The largest hole in practice** |

The last matters most in non-source-tracked orgs, which routinely contain Apex the repo does
not. `deploy --verify-coverage` queries the org for exactly this drift — the only command
that contacts an org, with `@salesforce/core` behind a dynamic import so `index` and
`analyze` cannot.

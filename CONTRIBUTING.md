# Contributing to sf-testimpact

Thanks for considering a contribution. This tool decides whether tests get skipped before a
deployment, so the bar for changes is correctness first.

## The one rule that matters

**Over-approximate freely, under-approximate never.**

An extra edge in the graph costs test minutes. A missing edge lets a regression reach
production. If a change makes the tool select *fewer* tests, it needs an argument for why
the removed tests could not possibly have caught anything — not just a benchmark showing
the number went down.

Any construct we cannot resolve must degrade to the conservative behaviour and say so out
loud. See `docs/DESIGN.md` §6 for the taint and fallback rules.

## Setup

```bash
npm ci
npm run check   # lint + build + test
```

Requires Node >= 22.13 (the `@apexdevtools/apex-parser` engine floor).

## Before opening a PR

- `npm run check` passes.
- New exported functions have unit tests. Coverage thresholds are enforced in CI, but
  coverage is a floor, not a goal — test behaviour and edge cases.
- Tests never hit the network or a live org. The Salesforce layer is mocked.
- No `any` and no `@ts-expect-error` without an adjacent comment justifying it.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`). Breaking changes use `!` and a
  `BREAKING CHANGE:` footer. Releases are cut by semantic-release from these messages.

## Adding an extractor

Extractors are pure functions `(filePath, contents) -> FileFacts`. They do no I/O, hold no
state, and know nothing about the graph. Add fixtures under `test/fixtures/` and test the
facts directly.

Every extractor has an identity string (for example `apex@1`). **Bump it whenever your
change alters what the extractor emits.** A stale index that silently mixes old and new
facts is exactly the class of bug this project cannot afford; the identity is what forces a
re-index instead.

## Adding a dependency

Per the project's standards, any dependency under roughly 1M weekly npm downloads needs a
justification in the PR description covering what it does, why the standard library will
not, and what happens if it is abandoned.

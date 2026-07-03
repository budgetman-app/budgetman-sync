# This is a thin fork of moneyman

`budgetman-app/budgetman-sync` is a **thin, additive fork** of
[daniel-hauser/moneyman](https://github.com/daniel-hauser/moneyman), maintained as part of the
[budgetman](https://github.com/budgetman-app/budgetman-orchestrator) personal-finance project.

## What we add

Exactly one capability, opt-in and default-off, in ~2 files:

- `actual.keepPending` + `actual.upsert` config flags (`src/config.schema.ts`).
- A **stable-key pending/FX upsert** in the Actual storage provider (`src/storage/actual.ts`):
  imports pending charges as uncleared, then updates them **in place** on settlement using the
  FX-invariant `originalAmount + originalCurrency` key — never duplicating, never overwriting the
  human's category.

Everything else (scraping, aggregation, retry, the security domain-guard, scheduling, the notifier)
is used **unchanged** from upstream.

## Branch model — rebase, don't merge

- **`main`** is a clean mirror of upstream `daniel-hauser/moneyman@main`. Do not commit to it.
- **`feat/actual-pending-upsert`** carries the entire fork delta as a thin topic branch.
- To pull updates: **rebase** the topic branch onto upstream `main` (not merge), keeping the delta
  small and the history linear. Deploy from the topic branch.

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout feat/actual-pending-upsert && git rebase main
```

## End state — upstream it

The change is designed to be **upstreamable as opt-in / default-off**. If merged upstream, we delete
the topic branch and run **vanilla moneyman + a config flag** — zero owned code, updates automatic
forever. See the orchestrator's `docs/ARCHITECTURE.md` → "Fork strategy" for the rationale.

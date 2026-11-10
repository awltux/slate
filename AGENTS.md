# AGENTS.md — how work happens in Slate

This file is the contract for every change to this repository. If a change cannot follow it, the change is wrong
or this file is wrong — fix one of them in the same commit.

---

## 1. What Slate is

Slate is the **production system of record** for AI film: story, plan, sheets, frames, takes, cuts, provenance,
budget and review. It is not an editor, a renderer or a generator. Other programs own the pixels; Slate owns the
plan, the money and the provenance, and the project folder is the truth (`GUIDE.md`).

The one rule that outranks everything else:

> **Spend pixels last, spend judgement first.**

If a feature makes a expensive decision cheaper to reach before the cheap decisions are settled, it is wrong.

---

## 2. Non-negotiables

These are architectural invariants. A PR that breaks one is rejected regardless of how well it works.

1. **One registry.** Every behaviour is an operation in `src/ops`, with a zod input/output schema, a policy
   (`read | write | spend | destructive`) and, for writes, a declared `touched` node set.
2. **Three surfaces, one implementation.** CLI, MCP and HTTP are transports over the registry. No surface may
   contain policy, validation or business logic. A UI feature that needs new behaviour needs a new operation.
3. **Ids, not paths.** Operation results expose asset ids and URLs. Absolute host paths never appear in a
   response, a log line the user sees, or a document. Enforced by a test.
4. **Documents are the truth; the index is disposable.** Anything derived (thumbnails, proxies, search index)
   can be deleted and rebuilt.
5. **Money is a reservation.** Nothing billable is submitted without an approved estimate token, and the ceiling
   is checked when the reservation is taken, not when the job finishes.
6. **Staleness is derived.** Nodes carry `builtFrom` hashes; `stale = any input hash changed`. Never store a
   `stale` flag.
7. **Headless parity.** Every flow must work with `SLATE_HEADLESS=1` (no daemon). `gate:headless` proves it on
   canonical hashes.
8. **No silent fallback.** A result says which chain rung ran (`via`); a degraded path is reported, not hidden.
9. **Failures are codes.** Errors are `SlateError { code, detail, retryable }`; no free-text-only failures.
10. **Idempotency.** Every write and spend operation accepts `opId`; replay returns the first result.

---

## 3. The slice loop

Work happens in **vertical slices**: a slice is a user-visible outcome that can be demonstrated in the browser
and verified by a command. There is no "infrastructure slice" that ships nothing visible.

For every change, in this order:

1. **Pick the slice** from `docs/PROGRESS.md` and state its acceptance test in one sentence.
2. **Write the failing test first** (`test/unit`, `test/e2e` or `test/ui`). If the test cannot be written, the
   slice is not understood yet.
3. **Implement the kernel/operation.** Types first, then behaviour. Keep it pure where possible.
4. **Wire the surfaces**: CLI subcommand, MCP tool, HTTP route, UI path. All four, or the slice is not done.
5. **Run the QA refactor pass** (§6) — this is not optional and not a later ticket.
6. **Update docs**: regenerate `docs/OP-REGISTRY.md`, add the `CHANGELOG.md` line, tick `docs/PROGRESS.md`.
7. **Run `pnpm verify`.** Green, or go back to 3.
8. **Commit** in the standard form (§4) — feature, then refactor, then docs, as separate commits.
9. **Run the slice gate** (`pnpm gate:<n>`) and save its screenshot to `artifacts/<n>/`.

Never leave the tree red between steps. If a step is too large for one commit, it is too large for one slice.

---

## 4. Commit standard

Conventional Commits, with a scope from this closed list:

`domain` · `kernel` · `auth` · `ops` · `api` · `ui` · `adapters` · `cli` · `mcp` · `test` · `docs` · `chore`

```
feat(ops): add shot.create with readiness checks

Why: the plan page needs shots to exist before anything can reference them, and
readiness is the only honest way to show what a shot is still missing.

How verified: pnpm gate:2 (Plan page shows three shots, readiness badges, and
stale badges after replacing a sheet); pnpm test test/unit/readiness.test.ts

Risk: shot ids become public surface — changing the id scheme later needs a
migration.
```

Rules:

- **One concern per commit.** A feature and a refactor never share a commit; a refactor and a rename never share
  one either.
- **Each commit is green on its own.** `git checkout <sha> && pnpm verify` must pass.
- **≤ 400 lines** of diff (excluding generated files, fixtures and lockfiles). Larger means split.
- **No dead code, no commented-out code, no `TODO` without an issue reference.**
- **Commit messages describe why**, not what — the diff says what.
- **Generated files are regenerated in the same commit** that changes their source (`docs/OP-REGISTRY.md`).
- Amend freely before pushing; never rewrite shared history.

---

## 5. Definition of Done (per slice)

A slice is done only when all of these are true:

- [ ] Operation(s) exist with zod schemas and declared `touched` sets.
- [ ] CLI subcommand, MCP tool and HTTP route are generated from the registry and tested.
- [ ] A UI path exists and is reachable without typing a command.
- [ ] Unit tests cover the rules; an e2e test covers the flow offline; a Playwright test covers the UI path.
- [ ] `pnpm verify` is green and `pnpm gate:<n>` passes.
- [ ] `docs/OP-REGISTRY.md` regenerated; `CHANGELOG.md` line added; `docs/PROGRESS.md` updated.
- [ ] A screenshot is in `artifacts/<n>/` and linked from `PROGRESS.md`.
- [ ] The harness parity check passes: the same flow via CLI with `SLATE_HEADLESS=1` produces identical
      documents (canonical hash).

---

## 6. QA refactor pass (after every change, before committing)

Run this checklist literally. Each item either passes or becomes a commit.

1. **Dead code** — anything added but unreachable is deleted, not left for later.
2. **Naming** — the domain vocabulary in `docs/ARCHITECTURE.md` §Vocabulary is used exactly; no synonyms
   (`frame`/`keyframe`, `take`/`render`, `shot`/`clip`).
3. **Duplication** — policy lives in the operation, not repeated in the UI, CLI and MCP wrappers.
4. **Error paths** — every failure returns a code with a retryable flag; no `throw new Error("...")` reaching a
   surface.
5. **Boundaries** — `domain` imports nothing; `kernel` imports `domain`; `ops` imports `kernel`; `surfaces`
   imports `ops`. No layer reaches sideways.
6. **Paths** — no absolute path in any result; all media references are ids.
7. **Accessibility** — every control has a label, focus is visible, the flow is keyboard-operable.
8. **Performance** — no N+1 fetches, no refetch of the world on every SSE tick, no synchronous work over 10 ms
   on the request path.
9. **Tests** — do they assert behaviour or implementation? Would they fail if the rule were wrong?
10. **Docs** — the operation reference, the changelog and the slice board are current.

Refactors land as `refactor(scope): ...` commits with the reason in the body.

---

## 7. Tests and gates

| Layer | Location | Runs |
|---|---|---|
| Unit | `test/unit/**` | pure rules: hashing, readiness, staleness, ledger arithmetic, permissions |
| E2E (offline) | `test/e2e/**` | operations against a temp project; no network, no credentials |
| UI | `test/ui/**` | Playwright against a real `slated` on a random port |
| Gate | `scripts/gate.ts <n>` | the slice's end-to-end proof + screenshot |

- Tests are **offline and credential-free**. A test that needs a key is a manual checklist item, not a test.
- Fixtures live in `test/fixtures/`; a fixture project ("lighthouse") is shared by every slice.
- Time is injected (`Clock` port); tests never sleep.
- A test that passes for the wrong reason is a bug: assert the failure mode too.

---

## 8. Code conventions

- TypeScript strict, ESM, `.js` extensions on relative imports, no `any`, no non-null assertions.
- All subprocesses go through `CommandRunner` with an **argv array** — never a shell string, never `exec`.
- Time and randomness are ports (`Clock`, `Ids`), injected; production uses the real ones.
- Hashes come from `domain/canonical.ts` only. Never hash `JSON.stringify`.
- Documents are written with `writeAtomic` (temp → fsync → rename) and committed through the commit log.
- Public functions get a one-line doc comment stating the invariant they preserve, not a restatement of the name.

---

## 9. Security rules

- Bind `127.0.0.1` by default. A non-loopback bind requires at least one user and prints the auth mode.
- Sessions: HMAC-signed httpOnly cookie, `SameSite=Lax`, `Secure` under TLS, 12 h.
- CSRF token required on every mutating route.
- API tokens are stored hashed, scoped (`read | write | spend`), revocable, and never logged.
- Media URLs are signed and expiring; range requests supported; no path traversal (asset ids only).
- A leak test walks every operation's output schema and fails on a string that looks like a host path.
- Secrets never enter the repository, a document, or a log line.

---

## 10. Docs and decision records

- `docs/ARCHITECTURE.md` — the living design. Changing a non-negotiable requires an ADR and an edit here.
- `docs/adr/NNNN-title.md` — one page: context, decision, consequences, alternatives. Required for:
  format changes, auth model changes, concurrency model changes, any dependency that owns data.
- `docs/OP-REGISTRY.md` — generated; never hand-edited.
- `docs/PROGRESS.md` — the slice board: done, in progress, next, with gate status and screenshots.
- `CHANGELOG.md` — one line per slice, user-visible phrasing.

---

## 11. Review checklist (self-review before every commit)

- Would a new engineer understand this commit in six months from the message alone?
- Does the gate for this slice catch a regression here? If not, add a test.
- Is there a cheaper design that removes a concept instead of adding one?
- Does this make the expensive decision easier to reach too early? (See §1.)
- If this fails in production, what does the user see, and is it a code with a retryable flag?

---

## 12. Commands

```bash
pnpm dev            # daemon + UI on http://127.0.0.1:7788
pnpm verify         # typecheck + lint + unit + e2e (offline)
pnpm test:watch     # unit loop
pnpm gate:1         # slice gate 1 (boot, auth, health)
SLATE_HEADLESS=1 pnpm gate:1   # same slice with no daemon
```

---

## 13. Current work

See `docs/PROGRESS.md`. Slices 1–22 are done, each with its gate and screenshots: boot through to uploads as declared endpoints with AI-drafted declarations, a project's configuration tab, host health, project
backup and restore, references that can reach a remote model, guarded deletion, editable sheets and a project created
with its shape and look. The next slice comes from the backlog at the end of that file, not from this line.

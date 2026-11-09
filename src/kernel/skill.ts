/**
 * The production skill shipped with Slate. It lives here as a constant so it travels with the binary: `project.create`
 * writes it into `.dsh/skills/slate-production/SKILL.md`, which is exactly where DeepSeek Harness looks for project
 * skills. Tools give mechanics; this gives judgement.
 */
export const SLATE_SKILL_MARKDOWN = `---
name: slate-production
description: Direct an AI film with Slate — the order of work, the money rule, readiness and staleness, and which operation to call when.
---

# Slate production

You are directing a film through Slate. Slate records; other programs make pixels. Never hand-edit
\`production.json\` or \`project.json\` — every change is an operation, because ids, hashes and provenance are what make
the film reproducible.

## The rule

**Spend pixels last, spend judgement first.** Everything before generation is free to change; a take costs money and
a final take costs a lot. If you are about to generate and the cut has not been watched, stop.

## The loop

1. **State first.** Call \`session.brief\`. It returns the budget, the plan's counts, stale nodes and the next useful
   operation. Ask "what changed?" before doing anything.
2. **Story.** \`story.set\` with five lines: situation, desire, conflict, change, result. If a line needs two sentences,
   the idea is not settled.
3. **Plan.** \`scene.create\`, then \`shot.create\`. Watch the readiness checks in the result: each returns pass, warn or
   fail with a reason. Fix the failures rather than working around them.
4. **Look.** Attach boards to shots with \`frame.attach\` (role \`board\`, or \`first\` when it is the conditioning frame).
5. **Cut before spending.** \`cut.build\` then \`cut.render\`. Watch it. Timing is the cheapest thing to get wrong.
6. **Drafts.** \`estimate.create\` with tier \`draft\` → show the price → \`spend.approve\` → \`take.generate\`. Drafts find a
   bad idea for a tenth of the price.
7. **Finals.** The same three calls with tier \`final\`, after the motion has been approved at draft quality.
8. **Select.** \`take.select\` — one take per shot, with a reason.

## Money

- An estimate is a stored record; the approval token names it, its price and an expiry.
- The token is single use and bound to the estimate's hash: if the plan changes, the token is void. Price it again.
- \`take.generate\` checks the ceiling at reservation time, before a frame renders. A refused batch returns
  \`budget_exhausted\` with what is pending — report it, do not work around it.
- Approval on its own spends nothing. Only a submitted job reserves money.

## Readiness and staleness

- \`shot.get\` returns \`readiness[]\`: scene-linked, described, duration, number-unique, story. A failed check is a
  reason, not an obstacle to argue with.
- \`graph.stale\` lists nodes whose inputs changed since they were built, with the cause. After reviewing a shot against
  an edited scene, call \`shot.rebase\` — do not regenerate to clear a badge.
- Every write returns \`stale.added\` and \`stale.cleared\`. Say what your change invalidated; the human cannot see the
  graph.

## Working with the desktop tools

Blender, OpenShot, FFmpeg and mpv run on the host. Work with your own tools in \`work/\`, then attach the result with
provenance — \`take.attach\` for clips, \`frame.attach\` for stills. An unattached file is invisible to the film.

\`capabilities.get\` says which program will run each stage and what a degraded stage costs. Repeat that to the human
before starting work, never afterwards.

## Style

- Answer with what changed and what it cost, not with a restatement of the plan.
- Report failures as the code Slate returned (\`budget_exhausted\`, \`stale_upstream\`, \`readiness_failed\`) and the one
  thing that would unblock them.
- Never invent an id, a price or a duration. Ask Slate.
`;

export const SLATE_SKILL_PATH = ".dsh/skills/slate-production/SKILL.md";

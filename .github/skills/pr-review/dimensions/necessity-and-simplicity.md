# Necessity & simplicity

Apply `_shared-contract.md`. Set `Domain: necessity-and-simplicity`.

Feature necessity and scope are normally settled in the issue or design
discussion before implementation. Reopen that question here only when the
implementation reveals unexpected cost, overengineering, or review-driven creep.
*Can merge* does not mean *should merge*.

## When you apply

Any of: the diff adds **user-facing surface** (command, setting, `launch.json`
field, manifest-editor tab or field, diagnostic, menu entry); it adds **new
internal structure** (module, class, abstraction, config knob) — over-engineering
hides here; or this is a **re-review**.

Otherwise — small bug fixes, mechanical refactors, perf, docs, tests, CI — note
"no new surface, N/A" in `## What I checked` and stop.

## The extension's mission

Bring the **WinApp CLI's Windows app packaging, identity, signing, and
debugging** into VS Code for any app framework, plus first-class
`AppxManifest.xml` editing. The CLI owns the behavior; the extension makes it
discoverable and integrated. A change that re-implements CLI logic in
TypeScript, or wanders from that mission, is a finding even when the code is
clean.

## What to weigh

- **Does it earn its complexity?** Value delivered against surface area and
  long-term maintenance. A command duplicating ~80% of an existing one should
  usually extend it instead.
- **Does it belong in the CLI?** Logic that every `winapp` user needs (not just
  VS Code users) should land in `microsoft/WinAppCli` and be surfaced here.
- **Is there a real user?** Or is this speculative generality?
- **Could it be smaller?** Fewer commands, a narrower setting, one code path
  instead of two. Several new commands or editor tabs at once should usually be
  staged.
- **False confidence.** A command that looks like it worked but silently did
  nothing (e.g. a success toast after a fire-and-forget terminal command) is
  *reputationally worse than not shipping at all*. Say so plainly.

## Review-driven scope creep

This is the failure mode you exist to catch, and nothing else looks for it.

A PR that has been through review loops is the highest-risk shape for
over-engineering: each suggestion was individually reasonable, and nobody watched
the total. Nine reviewers each asking for one small addition produce nine
additions — and the next reviewer treats all nine as settled design.

- **Reviewer-suggested code is not settled design.** The don't-re-litigate rule
  protects decisions *maintainers* made. It does not protect a setting, prompt,
  or defensive branch that exists only because an earlier review asked for it.
  Reopen those freely.
- **Recommend deletion by name.** A concrete cut-list — "drop the
  `winapp.x` setting, the second quick pick, and the `FooResolver` indirection;
  one caller each, no user asked" — is worth more than three additive findings.
- **Say when to stop.** If what remains is medium/low polish, state in
  `## What I checked` that the PR is converged and further rounds will add
  complexity rather than quality.

Describe the unnecessary surface and its cost, not the review round or comment
that introduced it. Review provenance does not belong in production comments or
documentation.

## State a conclusion either way

Always form and state an opinion on necessity and size — but it can be "the scope
is justified," said explicitly in `## What I checked` with a one-line rationale.
A silent omission reads as no opinion, which is the gap this dimension exists to
close. Do not manufacture a scope objection to avoid an empty report.

## Severity

Out of scope for the mission, or ships likely false confidence → high.
Earns little over extending an existing command → medium. Complexity from an
earlier review that is not earning its keep → medium, or high if it added
user-facing surface (a command ID, setting key, or `launch.json` field is
forever). Premature abstraction → low.

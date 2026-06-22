# Alternative-solution review

You are reviewing a PR diff for the `microsoft/WinAppVSCE` repo and asking:
**is there a simpler, more idiomatic, or already-existing way to do this in
this codebase?** Apply the shared output contract in `_shared-contract.md`.
Set `Domain: alternative-solution` on every finding.

## Repo-specific patterns to enforce

- **CLI path resolution → use `getWinappCliPath` / `WINAPP_CLI_CALLER_VALUE`.**
  New code that re-discovers the bundled CLI path or redefines the caller tag
  duplicates existing utilities in `src/winapp-cli-utils.ts`.
- **Manifest parsing/editing → reuse existing helpers.** Prefer the established
  `manifest-parser.ts`, `manifest-validator.ts`, `xml-utils.ts`, and
  `manifest-xml-ops*.ts` modules over ad-hoc XML parsing or raw string surgery.
- **VS Code process launching → use arg arrays, not shell strings.** New code
  that shells out via concatenated command strings when an existing `spawn` or
  `execFile` pattern would work should be flagged.
- **Manifest editor architecture.** New custom-editor behavior should extend the
  existing provider / parser / validator flow rather than creating a parallel
  manifest-edit path elsewhere in `src/`.
- **Command registration.** New commands should plug into the existing
  `extension.ts` registration and package contribution model instead of creating
  one-off bootstrap paths.
- **Validation logic reuse.** If a regex, manifest field rule, or XML helper
  already exists, new code should call it instead of re-implementing it.
- **One responsibility per module.** Flag new files or classes that combine UI,
  process execution, parsing, and validation when a thin wrapper around an
  existing helper would do.
- **Large-file pressure.** If a diff pushes an already-large file materially
  higher when the change could live in a focused helper/module, call that out.
- **DOM-aware XML handling.** Prefer the repo's existing DOM and helper-based
  XML mutations over brittle regex-only structural edits.

## Cross-cutting checks

- Does this change duplicate logic that already exists in another helper,
  parser, validator, or script? Search for similar patterns and recommend reuse.
- Could a new method be a simple call to an existing helper plus a small
  wrapper? If so, recommend the wrapper.
- Is a new abstraction premature (one caller, no likely second)? Recommend
  inlining.
- Is the change bypassing an existing VS Code or Node API that already solves
  the problem safely? Recommend the built-in path.

## What to drop

- Generic "this could be more functional" / "consider a different pattern"
  without a concrete in-repo alternative.
- Refactor suggestions that exceed the scope of the PR ("rewrite this whole
  module") — note them only as `low` with a tight recommendation, or skip.

## Severity guide for this dimension

- Re-implementing existing parser/validator/helper logic → medium.
- Wrong abstraction choice that will likely force follow-up rework → medium.
- Minor "could reuse helper X" with marginal benefit → low.

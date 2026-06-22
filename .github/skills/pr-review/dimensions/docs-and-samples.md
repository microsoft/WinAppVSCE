# Docs & samples sync review

You are reviewing a PR diff for the `microsoft/WinAppVSCE` repo and asking:
**do the docs and contributor-facing repo assets reflect this change?**
Apply the shared output contract in `_shared-contract.md`. Set
`Domain: docs-and-samples` on every finding.

This dimension is mostly read-only research — use `explore` agent type if
available, otherwise standard file reads.

## Docs surfaces

The most likely sync points in this repo are:

- `README.md`
- `docs/` (if present)
- `package.json` command/debugger/custom-editor descriptions
- `.github/` repo guidance, issue templates, workflows, and skills
- `.pipelines/` release documentation or publish flows
- `src/test/e2e/README.md` and related fixtures when user workflows change

## What to look for

- **New or changed extension commands** without corresponding updates in:
  - `README.md` command tables or scenario sections
  - `package.json` contributed command titles/descriptions
  - Any relevant docs page under `docs/`
- **Changed debug behavior** (launch config fields, debugger expectations,
  folder-selection flow, bundled CLI assumptions) without README/docs updates.
- **Manifest editor feature changes** (new tabs, fields, validation rules,
  extension types, supported asset behavior) without updating the README or
  editor-specific docs.
- **Install/distribution changes** (bundled CLI, VSIX packaging, prerelease vs
  stable flow, download locations) without updating setup guidance.
- **Broken cross-links.** New docs linking to renamed/deleted files, or removed
  docs still referenced from `README.md` or repo automation text.
- **Workflow/skill drift.** If repo automation or contributor experience changes,
  check whether `.github/skills/`, workflow docs, or release notes text need
  to move with it.
- **Examples and snippets.** `launch.json`, command names, or manifest snippets
  in docs should still match the shipped extension behavior.

## What to drop

- Asking for grammar tweaks unrelated to the change.
- Asking to update docs for behavior that did not change.
- Flagging generated build output (`dist/`, reports, artifacts) as documentation
  debt.

## Severity guide for this dimension

- New user-visible command/behavior missing from README and the relevant repo
  guidance → high.
- Behavior change that makes existing setup/debugging docs incorrect → high.
- Missing update to a narrower doc/example surface → medium.
- Minor typo or link polish → low.

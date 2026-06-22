# Test coverage review

You are reviewing a PR diff for the `microsoft/WinAppVSCE` repo and asking:
**are the changes adequately covered by tests?** Apply the shared output
contract in `_shared-contract.md`. Set `Domain: test-coverage` on every
finding.

## Test surfaces in this repo

- **Unit tests:** `src/test/*.test.ts` plus focused TS tests run by
  `npm run test:unit`.
- **E2E/editor tests:** `src/test/e2e/*.spec.ts` (Playwright driving VS Code /
  Electron), configured by `playwright.config.ts`.
- **Build-time checks:** `npm run compile-tsc`, `npm run lint`, and any targeted
  smoke coverage already wired into scripts.

## What to look for

- **New command/debug/editor behavior, no tests.** If a diff adds a new command,
  launch-config path, custom-editor action, or parser behavior, there should be
  at least one automated test that exercises it.
- **Manifest parser/validator changes without targeted coverage.** New XML
  fields, regexes, edge cases, or reorder logic should usually add or update
  tests under `src/test/`.
- **User-flow changes without E2E coverage.** If the change materially affects
  the manifest editor UI, command palette wiring, or debug launch flow, check
  whether a Playwright spec should cover it.
- **Correctness findings without tests.** If you identified an edge case or bug,
  check whether the current tests would catch it; if not, emit a coverage
  finding too.
- **Brittle tests.** New tests that depend on the real network, real user
  profiles, real external tools without stubbing, or machine-specific absolute
  paths.
- **Fixture drift.** New parser/editor behavior that requires fixture updates but
  leaves existing fixtures unrealistically narrow or stale.
- **Regex / validation hardening without abuse tests.** Security-sensitive regex
  and validation changes should usually have adversarial or edge-case coverage.
- **Packaging or release-script changes with no lightweight verification.** If a
  script change affects version stamping, CLI bundling, or VSIX creation, look
  for at least a targeted script/unit check where the repo already has one.

## What to drop

- "Increase coverage to 100%" without a specific uncovered scenario.
- Suggesting tests for trivial constant exports or metadata-only edits.
- Demanding full E2E coverage when a tight unit test would cover the behavior.

## Severity guide for this dimension

- New user-visible feature path with zero meaningful automated coverage → high.
- New error path / edge case not exercised by current tests → medium.
- UI/editor flow change that clearly merits E2E coverage but has none → medium.
- Brittle tests that can break CI or pollute machine state → high.

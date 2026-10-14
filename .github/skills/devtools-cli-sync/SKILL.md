---
name: devtools-cli-sync
description: Re-sync the VS Code DevTools panel in microsoft/WinAppVSCE with the winapp CLI DevTools work (microsoft/winappCli, branch nmetulev-devtools / PR #943). Covers pulling a fresh CLI build, diffing the DevTools JSON-RPC schema, checking the launch/invocation contract, and sweeping the native DevTools window and overlay for layout and feature changes we should mirror.
infer: true
---

You are the **WinApp DevTools sync agent** for the `microsoft/WinAppVSCE` repo.

The extension's DevTools panel (`src/devtools/`) is a VS Code re-implementation
of the *native DevTools window* that `winapp run --devtools <on>` opens. It
talks to the same DevTools engine over the same JSON-RPC named pipe. The engine
lives in another repo and is still on an unmerged branch, so it moves
underneath us — frequently. Your job is to find every way it has moved and
bring our panel back into alignment.

Scope note: we mirror the **DevTools window** only. The **overlay** (the
toolbar floating over the running app) stays native; we never re-implement it.

## When to activate

Trigger phrases include:

- "sync the devtools" / "sync devtools with the CLI"
- "re-sync the winapp CLI" / "pull a new CLI build"
- "check devtools parity" / "are we in sync with the devtools branch"
- "has the devtools branch had updates"
- "did any devtools UI changes come in that we should adopt"
- "check for devtools schema drift"

Do **not** activate for general DevTools panel feature work that is not driven
by an upstream change.

## Workflow

1. **Read `.github/skills/devtools-cli-sync/AGENTS.md` first.** It is the
   authoritative runbook: exact commands, the CLI-file-to-our-file map, the
   validation gates, and the traps that have bitten previous syncs.
2. **Work the six passes in order** — binaries, schema, invocation contract,
   window parity, capability audit, validate. Each pass has a concrete
   deliverable; do not skip ahead, because pass 2 can invalidate pass 4's
   assumptions.
3. **Report a verdict table before you change anything.** For each upstream
   change: what it is, whether it applies to us, and adopt / ignore / file-
   upstream. Let the user pick before implementing anything non-mechanical.
4. **Validate with the full gate list** in AGENTS.md and paste the real
   numbers (schema method/event counts, unit pass count, E2E pass count).

## Rules

- **No backward compatibility.** This feature has not shipped. Never add a
  fallback, a version probe, or a "works on the old CLI too" branch. When the
  contract changes, change our code to match and delete the old path.
- **Mirror the window, not the overlay.** A change under
  `DevToolsOverlay.*` is almost always none of our business.
- **Prefer engine data over re-derived data.** If you are about to compute
  something the engine already returns, stop and check the schema first —
  that mistake is how we shipped uncaptioned tree rows for weeks.
- **Gaps are feedback, not workarounds.** When the engine cannot give us what
  the native window has, add it to the upstream gaps issue
  (`microsoft/winappCli#1051`) instead of reimplementing engine logic.

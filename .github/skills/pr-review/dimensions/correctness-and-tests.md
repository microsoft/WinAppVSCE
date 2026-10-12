# Does it work? (correctness + tests)

You own two questions for the `microsoft/WinAppVSCE` repo: **is this code
correct**, and **would we know if it broke?**

Owning both means *you* decide when a gap is worth a test. A bug you would not
bother testing is not a coverage finding — say so and move on.

Apply `_shared-contract.md`. Set `Domain: correctness`.

You already know how to spot floating promises, missing `await`, leaked
disposables, off-by-one, and swallowed rejections. That is not written down
here. What follows is what you cannot know without this repo.

## Repo gotchas

- **CLI output is not clean JSON.** `winapp` can print log lines around its
  `--json` payload. Parse through `extractJsonObject`; a bare `JSON.parse` on
  stdout works on the author's machine and breaks on a first-run / update
  banner.
- **Every CLI spawn sets `WINAPP_CLI_CALLER`.** A new spawn that omits it, or
  replaces `process.env` instead of spreading it, changes CLI behavior or loses
  `PATH`.
- **Bundled CLI is per-arch.** `bin/win-x64/winapp.exe` and
  `bin/win-arm64/winapp.exe` are picked by `getWinappCliPath`. Code that
  hardcodes `win-x64` breaks ARM64 users.
- **Working directory resolution.** Commands run from the resolved project
  folder (`resolveWorkingDirectory` / `resolveProjectDirectory`), not
  `workspaceFolders[0]`. Multi-root workspaces and `winapp.appDirectories` must
  still work; zero workspace folders must fail with a clear message, not a
  `TypeError`.
- **Manifest names vary.** `AppxManifest.xml`, `appxmanifest.xml`, and
  `*.appxmanifest` are all valid (see `isManifestPath`, the activation events,
  and the editor `selector`). Exact-case or single-name matching drifts from
  the rest of the extension.
- **Formatting-preserving edits.** Manifest editor writes go through
  `applyFieldChange` / `manifest-xml-ops*.ts` as text edits. A change that drops
  comments, reorders attributes, loses a namespace declaration, or writes the
  whole document from a model is data loss in the user's manifest.
- **Webview save handshake.** Saves flush pending webview edits via a
  `flushChanges` / `changesFlushed` nonce exchange in
  `manifest-editor-provider.ts`. New editor state that bypasses it is lost on a
  fast Ctrl+S, and a resolver that does not match the nonce resolves the wrong
  save.
- **Webview path containment.** Asset/image resolution must stay inside the
  manifest's package root via `isPathWithin`; asset copy tokens are single-use
  (`AssetCopyTokenStore`).
- **Terminal-launched commands are fire-and-forget.** `runWinappCommand` and
  the elevated cert-install path (`runWinappCommandElevated`) use
  `Terminal.sendText`; the extension cannot observe their exit code. Code that
  reports success after `sendText` is wrong output — use `runWinappCapture`
  when the result matters.
- **Cleanup on the failure path.** Child processes, terminals, debug sessions,
  temp files, and registered loose-layout packages (from F5 identity) must be
  released when a command fails or the user cancels — a leaked registration
  breaks the *next* debug run, which is how these bugs reach users.

## Regression

Say what changes for existing users and existing flows. A validation that was
dead and now fires (a new diagnostic, a stricter `launch.json` check) is a
behavior change: state whether it will start failing workspaces that used to
work. Lead `What is wrong` with `Regression:`.

## Tests

- **Unit:** `src/test/*.test.ts`, mostly `node:test` run via `tsx`
  (`project-detection.test.ts` runs under mocha). They run **outside VS Code**:
  modules that import `vscode` must be mocked (see
  `intellisense-integration.test.ts`), so testable logic belongs in pure
  modules.
- **`npm run test:unit` lists test files explicitly.** A new `*.test.ts` that is
  not added to that script in `package.json` never runs in CI — `high`, because
  it looks like coverage and is not.
- **Fixtures:** `src/test/fixtures/` is copied to `out/test/fixtures` by the
  test script; reference fixtures relative to the compiled output.
- **E2E:** `src/test/e2e/*.spec.ts` (Playwright driving VS Code/Electron,
  `playwright.config.ts`). Specs share one VS Code instance (`shared-context`,
  `workers: 1`) and CI retries once — a spec that leaves editor state behind or
  only passes on retry is a real flake. `winapp.new` specs skip without a
  template pack.
- A new user-visible command or editor action with **no test at all** is `high`.
  Past that, ask whether a test would have caught a real bug; if not, skip it.
- Tests that hit the network, install certs, register packages, or write to the
  real user profile **without cleanup** are `high` — they break CI and
  contributors' machines.

# Syncing the VS Code DevTools panel with the winapp CLI

Operational runbook for keeping `src/devtools/` aligned with the DevTools
engine in `microsoft/winappCli`. Read this end to end before touching
anything; several passes depend on facts established by earlier passes.

---

## 0. What we are actually syncing with

| Thing | Where it lives | Do we mirror it? |
| --- | --- | --- |
| DevTools **engine** (JSON-RPC over a named pipe) | `src/winapp-devtools/native/WinApp.DevTools.Native/` | We are a client of it. Contract changes are mandatory. |
| DevTools **window** (the native inspector window) | `DevToolsWindow.*.inc` | **Yes** — our panel is a VS Code re-implementation of this. |
| DevTools **overlay** (toolbar floating over the app) | `DevToolsOverlay.*.inc` | **No** — stays native. We only toggle it and drive its highlight. |
| `winapp run` DevTools flags | `src/winapp-CLI/WinApp.Cli/Commands/RunCommand.DevTools.cs` | **Yes** — we spawn the CLI. |
| User-facing docs | `docs/guides/devtools.md`, `docs/guides/devtools-advanced.md` | Read for intent; useful when a commit message is terse. |

Upstream coordinates:

- repo `microsoft/winappCli`, branch **`nmetulev-devtools`**, PR **#943**
- tracking issue for engine gaps that block or inconvenience us:
  **`microsoft/winappCli#1051`**
- our PR: `microsoft/WinAppVSCE` **#295**

> **Dates on that branch are 2026, not 2025.** A `since=`/`until=` window from
> the wrong year silently returns pre-branch commits and produces a nonsense
> compare. Always sanity-check the first returned commit's date.

---

## Pass 1 — Get the new CLI build into `bin/`

**Do not use `scripts/download-cli.ps1`.** It only fetches published GitHub
*releases*, and there is no DevTools prerelease. Builds come from branch CI.

```powershell
# Latest successful branch build
gh run list --repo microsoft/winappCli --branch nmetulev-devtools `
  --workflow "Build and Package" --limit 5 `
  --json databaseId,conclusion,createdAt `
  -q '.[] | "\(.databaseId)  \(.conclusion)  \(.createdAt)"'
```

Download the **`cli-binaries`** artifact. It is ~250 MB and contains
`win-arm64/` and `win-x64/`, 10 files each — the 6 we ship plus 4 `.pdb`s.

```powershell
$stage = "$env:TEMP\winapp-cli-sync"
gh run download <RUN_ID> --repo microsoft/winappCli --name cli-binaries --dir $stage
foreach ($rid in 'win-arm64','win-x64') {
    # Filter with Where-Object, NOT -Exclude: Get-ChildItem -Exclude silently
    # matches nothing on a bare directory path and copies zero files.
    Get-ChildItem "$stage\$rid" -File |
        Where-Object { $_.Extension -ne '.pdb' } |
        Copy-Item -Destination ".\bin\$rid" -Force
}
.\bin\win-arm64\winapp.exe --version   # must report the NEW build
```

Each `bin\win-{rid}` must end up with exactly these six files:

```
libHarfBuzzSharp.dll  libSkiaSharp.dll  winapp-devtools-schema.json
WinApp.DevTools.Managed.dll  WinApp.DevTools.Native.dll  winapp.exe
```

### Artifact traps

- **`npm-package` omits `winapp-devtools-schema.json`.** Syncing from the npm
  tarball makes the drift gate silently inert (it *warns* and passes when the
  schema is missing — see `scripts/check-devtools-schema.ts`). Older runs also
  published `nuget-packages` with the schema under `tools/win-{rid}/`; prefer
  `cli-binaries`, which is a straight file copy with no nupkg extraction.
- `bin/` is gitignored. The VSIX picks it up at package time, so a stale
  `bin/` means a stale shipped CLI with no git signal.
- Two other artifacts are worth a look during pass 4:
  **`devtools-validation-results`** and **`devtools-overlay-observations`**
  (small) often contain the upstream team's own screenshots and observations
  of the window and overlay.

**Deliverable:** old version → new version, e.g. `.247` → `.278`.

---

## Pass 2 — Protocol / schema drift

```powershell
npm run check-devtools-schema
```

It compares `bin/*/winapp-devtools-schema.json` against the methods and events
our code actually uses, for both RIDs. Record the counts (at last sync:
**29 methods, 7 events**, no drift).

### The gate is weaker than it looks — do the manual part

`check-devtools-schema.ts` compares **names only**. A change to a params or
result *shape* passes clean. This has already happened once (an upstream commit
added a field to `InternalSetCommentsParams` and the gate stayed green). So:

```powershell
# Byte-compare the schema against the one you were on before
Get-FileHash .\bin\win-arm64\winapp-devtools-schema.json
```

If the hash changed, diff the old and new JSON and read every `$defs` entry for
a method we call. `src/devtools/protocol.ts` and `src/devtools/devtools-client.ts`
encode those shapes.

`USED_METHODS` in `protocol.ts` is checked **in both directions**: the script
fails if the schema no longer advertises something we list, and separately
scans `src/devtools/` to fail if the list and the actual call sites disagree.
So adding a call means adding its entry, and removing the last call site means
removing its entry.

**Deliverable:** schema hash same/changed; method and event counts; a list of
shape changes affecting methods we call.

---

## Pass 3 — Invocation contract (`winapp run`)

Everything we encode about CLI arguments lives in **one** file:
`src/devtools/launch-options.ts`. Nothing else in the extension should build
DevTools spawn args.

Re-verify against the new build:

```powershell
.\bin\win-arm64\winapp.exe run --help
```

Current contract, and why each part matters:

- `--devtools` is a **valued** option taking `on | off | headless`. It is not a
  bare switch; if you pass it bare it swallows the next argument.
- We always pass the mode **explicitly, including `off`**, because the CLI turns
  DevTools on by default for WinUI projects — omitting the flag would enable it
  for someone who wrote `useDevTools: false`.
- `headless` = engine running, overlay toolbar not drawn. That is what our
  `noOverlay` launch.json property maps to, because the panel is a second client
  and must keep the engine alive.

Also re-check the **pipe discovery / negotiation** path if upstream touched
`DevToolsPipeDiscovery`, `DevToolsNegotiation`, or `DevToolsStartupHooks`
(their test file names make this easy to spot) — that is how
`src/devtools/devtools-client.ts` finds and handshakes with the engine.

The E2E capability probe `cliSupportsDevTools()` in
`src/test/e2e/devtools-fixture.ts` greps `run --help` for the **mode syntax**
(`/--devtools\s*<[^>]*\bon\b[^>]*>/`), not a bare flag, specifically so an older
build is detected as unsupported instead of failing mid-suite. If the option
spelling changes, that regex must change with it.

**Deliverable:** confirmed or updated `launch-options.ts` + fixture probe.

---

## Pass 4 — Window layout / feature parity sweep

This is the judgement-heavy pass. List what landed since the last sync:

```powershell
gh api "repos/microsoft/winappCli/commits?sha=nmetulev-devtools&since=2026-10-09T00:00:00Z&per_page=100" `
  -q '.[] | "\(.sha[0:8])  \(.commit.author.date[0:10])  \(.commit.message | split("\n")[0])"'
```

Triage each commit by the files it touches (`gh api repos/microsoft/winappCli/commits/<sha> -q '.files[].filename'`):

| Upstream file | Our counterpart | Action |
| --- | --- | --- |
| `DevToolsWindow.TreeView/.TreeRows/.TreeRefresh.inc` | `src/devtools/webview-script-tree.ts` | Mirror |
| `DevToolsWindow.PropsPane/.PropsLayout/.LiveProps/.KindModel.inc` | `src/devtools/webview-script-properties.ts` | Mirror |
| `DevToolsWindow.Editors.inc` | `src/devtools/webview-script-editors.ts` | Mirror |
| `DevToolsWindow.Comments.inc` | `src/devtools/webview-script-comments.ts` | Mirror |
| `DevToolsWindow.Expansion/.PaneRows/.PaneSinks.inc` | `webview-script-core.ts`, `webview-script-messages.ts` | Mirror behaviour, not plumbing |
| `DevToolsWindow.SourceAndResources.inc` | `source-navigation.ts`, `source-resolver.ts` | Mirror |
| `DevToolsWindow.Placement/.Lifecycle/.State.inc` | — | Usually native window-management only; read, rarely act |
| `DevToolsOverlay.*.inc` | `overlay.ts` only | Ignore unless it changes the `Overlay.*` RPC surface |
| `DevToolsProtocolSchema.inc`, `DevToolsProtocol.*` | `protocol.ts`, `devtools-client.ts` | Mandatory (pass 2) |
| `DevToolsBatch.h` | — | Engine-side derivation; usually free to us |
| `RunCommand.DevTools.cs`, `DevToolsMode*` | `launch-options.ts` | Mandatory (pass 3) |
| `docs/guides/devtools*.md` | `README.md`, our PR body | Read for intent |

### Before concluding "we need to implement X"

Check whether the engine already returns it. The highest-value find of a past
sync was that `VisualTree.getPreviews` is a **public** method we had never
called — it is where the native window's row captions, per-row source lines,
automation IDs and glyph handling come from, and we were rendering bare type
names because we assumed `VisualTree.enumerate` was all there was.

Rule of thumb: if the native window shows something `enumerate` does not
return, there is a second call, not a client-side derivation.

Watch for per-call limits — `getPreviews` caps at **256 handles** and errors
rather than truncating, which is why we chunk.

### Report before implementing

Produce a table and let the user choose:

| Upstream change | Applies to our panel? | Verdict |
| --- | --- | --- |
| … | … | adopt / ignore (overlay-only) / file upstream |

Then implement only what was picked.

**Deliverable:** verdict table + the adopted changes.

---

## Pass 5 — Capability audit

Diff `USED_METHODS` against the full schema (the engine exposes ~50 methods;
we use 29). Unused at last sync:

```
VisualTree.find        VisualTree.query        VisualTree.getAppAuthored
Selection.poll         Selection.select        Selection.completePick
Property.setQuery
```

A newly added method is a feature the native window probably gained. Decide
whether we want it, or note it and move on.

**Deliverable:** current used/total, plus anything newly added upstream.

---

## Pass 6 — Validate

Run all of these and paste the real numbers:

```powershell
npm run compile-tsc              # typecheck
npm run lint                     # 0 errors (11 pre-existing warnings as of last sync)
npm run check-devtools-schema    # method/event counts, both RIDs, no drift
npm run test:unit                # 1352/1352 at last sync
npm run test:e2e -- --grep "@winui-app"   # DevTools panel E2E, 8 specs
.\scripts\package-vsc.ps1 -CliBinariesPath (Resolve-Path bin).Path
```

Notes:

- `package-vsc.ps1` defaults to `artifacts/cli` and errors without
  `-CliBinariesPath`. Confirm it reports **12 CLI files** (6 × 2 RIDs).
- The DevTools E2E suite builds and launches a real WinUI fixture app, then
  drives the panel. `beforeAll` order matters: dotnet probe → **CLI DevTools
  probe before building** → build → workspace → launch → F5.
- No unit test may import `vscode`, so `devtools-panel.ts` is unit-untestable;
  E2E is its only coverage. Budget for that when changing it.
- New unit test files must be added by hand to the `test:unit` script list in
  `package.json`.
- Manifest-editor E2E is independently flaky; a failure there is not yours.

---

## Standing rules

**No backward compatibility, ever.** The feature has not shipped. Do not add
version probes, fallbacks, or dual-path handling for an older CLI build. When
the contract changes, change our code and delete the old path. (The one
version-sensitive thing we keep is the E2E *probe*, which skips the suite on an
unsupported build rather than adapting to it.)

**File-editing conventions that keep breaking syncs:**

- **No backticks anywhere in** `webview-script*.ts`, `webview-styles.ts`,
  `webview-content.ts` — including inside comments. They are template literals.
  Use `\uXXXX` escapes for characters you would otherwise backtick around.
- `src/extension.ts` is **tabs**; `src/devtools/` is **4 spaces**.
- All webview fragments are concatenated into **one IIFE** in
  `webview-script.ts`, so function declarations hoist across fragments
  (e.g. `fileLabel` is defined in the tree fragment and used in comments).
  `webview-script-messages.ts` must stay **last** in the fragment order.
- `src/devtools/devtools-types.ts` is the single source of truth for the
  host↔webview message contract. Add both the payload type and the message
  variant there before wiring either side.

**Environment:** private npm/NuGet feeds only — never pass `--source` or
`--registry`, and never add a `nuget.config`/`.npmrc` naming a public endpoint.
`.git` is a file here (worktree), so use `$env:TEMP` for scratch.

**PowerShell traps hit repeatedly:**

- No heredoc. `git commit -F - <<'EOF'` is a parse error — use repeated `-m`.
  A parse error means **nothing** in that call ran, including the `git add` you
  chained before it.
- `node -e` breaks on `$defs` (PowerShell interpolation). Use a script file.
- `gh pr edit --body` goes through GraphQL and fails on SAML/SSO. Use
  `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> --input body.json` or the
  `update_pull_request` tool.
- Draft PRs do not trigger `pull_request` workflows here; dispatch manually
  with `gh workflow run "Build and Test" --ref <branch>`. `gh run watch`
  intermittently 502s — poll `gh run view --json status` instead.

---

## Known open items — re-check these every sync

| Item | Why it needs a look |
| --- | --- |
| `overlay.ts`'s `NO_HIGHLIGHT = '0'` claim | The "highlighting handle `0` clears the adorner without hiding the toolbar" behaviour was verified against an **older** engine, upstream has since reworked overlay internals, and no test covers it. Confirm manually: select an element, clear the highlight, check the toolbar is still up. |
| Schema gate compares names only | Consider tightening `check-devtools-schema.ts` to compare `$defs` shapes for used methods. Until then, pass 2's manual hash/diff step is mandatory. |
| CI cannot run the DevTools E2E yet | Blocked on a dotnet change shipping in the CLI. Re-test CI once the new build contains it. |
| Engine gaps issue `microsoft/winappCli#1051` | Append anything new you find; keep "blocking" and "nice to have" separated. |

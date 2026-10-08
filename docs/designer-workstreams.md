# WinUI XAML designer — improvement workstreams

A code-grounded quality plan for the VS2022 XAML live-preview designer
(`vs-extension/WinUIXamlPreview` + the out-of-process `surface/` host). Each item
cites evidence so it can be picked up without re-deriving context. File/line
references are approximate and may drift as code changes.

Status legend: ✅ done · 🔜 queued · 🧭 needs a design decision first.

---

## WS1 — Resilience & lifecycle hardening ✅ COMPLETE

Tasks T0–T13, all committed on `zateutsch-xaml-visualizer` and verified by the
`SurfaceClient.FaultTests` harness (9/9, zero leaked processes).

- T0 failure funnel, T1 timeout-kill, T2 connect-cancel, T3 readloop-log,
  T4 send-report, T5 async-dispose, T6 intentional-exit, T7 package shutdown
  registry, T8 tracker-dispose, T9 VSTHRD002 re-enable, T10 async provisioner IO,
  T11/T12 unified terminal recovery banner, T13 fault-injection harness.

---

## WS2 — Rendering fidelity  🔜  (highest user-visible value)

The preview is only as useful as it is faithful. Static mode strips `{x:Bind}`
and code-behind (`surface/Surface/XamlCleaner.cs`), so many real pages render
blank/default unless live activation works.

- **F1 — Live-mode reliability.** `SURFACE_LIVE_MODE` activation runs real
  `{x:Bind}`/code-behind but a fresh live process still crashes on inherently
  unrenderable pages (backdrops / animated visuals / App-window coupling), which
  demote to static for the session (`PreviewControl.xaml.cs` `_liveFallbackDocs`;
  `RenderHost.cs:240-274`). Measure the current live success rate across a real
  app, attack the top crash classes, and narrow the static fallback.
- **F2 — Live re-theming without a full relaunch.** 🧭 A theme change still needs
  a new process (`SURFACE_THEME` env), but since WS3-P6 it is a warm swap: a
  new-theme spare on the same host is promoted while the old frame stays up. The
  host `SetTheme` is a no-op and `SurfaceClient.SetTheme`/`SetThemeMsg` is vestigial
  with a misleading "applies live" comment (`FrameServer.cs:340-351`,
  `Messages.cs:123`). Remaining option: re-resolve `{ThemeResource}` on the live
  canvas (in-process). Also delete/fix the vestigial path + comment.
- **F3 — Custom/third-party control fidelity.** Unmapped controls become
  placeholders and the DesignHost ships a *fixed* CommunityToolkit 8.2.250402
  closure (`XamlCleaner` Rule 7, `RenderHost.cs:276-331`, `DesignHost.csproj`).
  Generalize resource/PRI closure to the user's actual referenced packages
  (validated separately) so placeholdered controls shrink.
- **F4 — Acrylic / backdrop / animation.** Off-screen `RenderTargetBitmap`
  capture can't reproduce compositor/window-backdrop effects, and animated content
  must be settled before capture (`RenderSettle.cs`). Define and document what is
  faithful vs. approximated; make the degraded cases explicit in the UI.
- **F5 — App startup resources.** The user `Application` subclass is never run;
  resource scope is reconstructed (`App.cs:796,1064`). Audit the gap (app-global
  `StaticResource`, implicit styles) and close the common cases.

---

## WS3 — Performance & startup latency  ✅

Context that shapes the plan: VS defaults to **native-HWND mode** (`PreferNative`),
so the PNG encode/readback path matters less here than **process launch, run-copy,
and re-host** cost. The margin already debounces edits (500 ms) and resizes (180 ms).
Until P9 every Surface process on ARM64 ran under x64 emulation, which made each
relaunch expensive. P9 now ships a native ARM64 Surface.

Measured facts (ARM64 dev machine):
- Matched self-contained host = **327 files / 151 MB**.
- `HostPayload.CreateRunCopy` = SHA-256 every source file → copy every file →
  SHA-256 every copied file (3 full passes).
- The matched upgrade runs it **twice** (`PrepareMatchedRunCopy`, then again in
  `SurfaceClient` because `userPri` is set) ≈ 6 passes / ~900 MB before the process
  starts. Each warm spare on a matched host repeats one copy.
- **10 orphaned run-copies / 0.62 GB** found in `%TEMP%\wsr-v2`.

### P0 baseline (ARM64, mock project, cold VS open, 2.5.1 cache already present)

Collected with PERF markers via `scripts/designer-perf-summary.ps1 -ByOutcome`.

| Span | Time |
|------|------|
| Open → first paint (bundled host) | 17.0 s (identity 6.4 s; Surface spawn → Ready 8.5 s, ~5 s of it is app resource scope) |
| `upgrade.build`: provisioner on a **cache hit** | **37.3 s** (68 s in an earlier session) |
| Matched run-copy (each of 2 copies) | 0.7–0.9 s |
| Matched spawn → Ready | 3.3–6.4 s |
| Upgrade swap → paint | 4.8 s |
| Live edit → paint (pre-warmed spare) | 1.5 s |

**Finding: run-copy is not the bottleneck. The provisioner cache-hit path is.**
It doesn't short-circuit. On every open it stages sources, runs `dotnet --version`
and two `dotnet restore`s, then `BuildStorage.Identity` SHA-256s **every file of
every restored NuGet package** in three dependency graphs, including the
multi-arch WinAppSDK packages. Only after that does it check the cache. Standalone
and warm, that's 8.4 s (restores ~2.7 s, identity hash ~4.7 s). Inside VS, with
cold disk caches, Defender and concurrent Surface startup, it's 37–68 s. The P2
decision is therefore lower priority; P1a is the new top item.

Also observed: a one-off VS repaint glitch after a live-spare swap (white block over
the editor and toolbar, cleared on its own). Tracked under WS8.

**After P1a + P1 (cold VS reopen, cache present):** `upgrade.build` 37.3 s → **2.4 s**;
upgrade start → matched ready 44.5 s → **6.8 s**; swap → paint 4.8 s → 0.9 s.
Open → full-fidelity matched preview went from ~65 s to **~12 s**. The first open after
an extension update still does one real build (67.7 s observed), because a new engine
stamp gives a new cache key.

| ID | Task | Evidence | Depends on |
|----|------|----------|------------|
| P0 ✅ | Instrument latency baseline: PERF markers for open→first paint (split: identity / run-copy / start→Ready / Ready→paint), edit→paint, theme→paint, crash→recovered, upgrade→swap; capture an ARM64 baseline with the mock project | baseline above | — |
| P1a ✅ | Fast cache-hit path: memoize the identity per input fingerprint (package dir + file size/mtime, assets.json hashes) so a hit skips staging, restore and the deep package hash; keep full hashing for builds. **Done:** `BuildStorage.Recall/Remember` (`v2\memo\*.json`). On the real 2.5.1 cache, standalone time went from 15.4 s to 1.2–1.9 s with the same key. The cached payload is still fully validated and matched-host verified | 37–68 s `upgrade.build` on a cache hit | P0 |
| P1 ✅ | Collapse the double matched run-copy to one per process. **Done:** the matched client launches from the verified read-only cache entry, and `SurfaceClient` makes the only (validated) per-process run-copy. This removes ~0.7–1 s and a 151 MB copy per upgrade, and `%TEMP%\WinUIXamlPreview\run` is no longer created | `PreviewControl` ~1027 + `SurfaceClient` ~119-131 | P0 |
| P2 ✅ (re-scoped) | Make run-copy cheap: single pass that hashes each member while copying | **Done:** `CreateRunCopy` used to hash the pristine host, copy it, then hash the copy (3 full passes over 326 files / 151 MB). Now each member is hashed as it is copied and must match the manifest (structural checks unchanged; unexpected-file check on the copy is metadata-only). Every byte the run uses is still verified, so no trust-once cache memo was needed. Standalone: 3.1–3.3 s → 2.2–3.1 s; in VS `client.runcopy` 2.3–3.6 s → 1.2–2.1 s. **Not done:** hardlinks: the cost is per-file creation (~1–15 ms each, likely AV scanning), not bytes, so a hardlink set measured no faster than a copy, and it would share writable files with the cache. Remaining spare start time is `Process.Start` of the new exe (0.3–3.9 s) and init to Ready (6–11 s), outside P2 | `HostPayload.cs` `CreateRunCopy` | P1 |
| P2b ✅ | Surface startup: stop enumerating every resource key before Ready | **Done:** Rule 6 of the XAML cleaner used a set of every string key in the app resource scope, built at startup by walking all merged/theme dictionaries. WinRT enumeration marshals each resource *value*, so this took 3.6–7.4 s (55–75% of spare startup) on the x64 Surface. It now asks `Resources.ContainsKey` per referenced key (searches merged + theme dictionaries; ~0.01–0.1 ms, one-time ~27 ms warm-up) and memoizes the answer until the scope changes. Also more accurate: `SystemAccentColor` resolves but was missing from the enumerated set. In VS: merge→scope established 3.6–7.4 s → ~0.1 s; spare `client.ready` 6–11 s → 1.3–3.1 s; held edits waited 0.4–7.4 s with no 15 s fallbacks. Background prebuild of the set was not needed (direct lookups are cheap, including misses) | `App.cs` `IsResourceKeyResolvable`; `XamlCleaner` Rule 6 | P0 |
| P3 ✅ | GC orphaned run-copies (`%TEMP%\wsr-v2`, `%TEMP%\WinUIXamlPreview\run`) + bounded cache-generation GC. **Done:** `HostPayload.TryRetire` claims a directory by renaming it to `.trash-*` (blocked while a Surface uses it as its working directory) and then deletes it. `SurfaceClient` cleanup retries for ~5 s. `PreviewPackage` sweeps run-copies older than 10 min, 30 s after load. Provisioner `BuildStorage.Collect` keeps the 3 most recently used keys and retires others only after 1 day unused and with their lock free; it removes unreferenced generations older than 1 h and memos of retired keys. In VS the sweep reclaimed 18 dirs (~0.7 GB) in 0.5 s, live run dirs were untouched, and VS shutdown left no copies | 0.62 GB observed | P0 |
| P4 ✅ | Host latest-wins render coalescing (drop superseded `UpdateXaml`; keep resize/canvas/native ordering) | Done: `ReadLoop` now drains the socket on a `surface-recv` thread; an `UpdateXaml` immediately followed by another queued `UpdateXaml` is skipped (logged "superseded"). Any other message is an ordering barrier; malformed updates are never skipped. Protocol tests cover collapse, Resize barrier, malformed (fail on old code) | P0 |
| P5 ✅ (re-scoped) | Live-mode edits with no ready spare: hold the edit for the next spare instead of re-rendering in the used process | **Done (hold, latest wins):** an isolated edit (live mode / risky doc) that finds no ready spare is held; when the next spare is ready it renders the newest document text (a burst costs one render). Falls back to the old in-place render if the spare fails to start or takes >15 s; a promoted render that errors leaves a still-fresh process, so a held edit renders there at once. In VS: 8 edits 2 s apart → 3 renders, all on fresh processes, no in-place renders; holds ~7.8–8.1 s; final text painted 6.5 s after the last edit. PERF `edit.hold`, `edit.livewait`. **Rejected:** warming the next spare during the render (measured slower: spare ready 9.7–11.2 s vs 5.5 s, paint 2.1 s vs 1.5 s) and a permanent depth-2 pool (~90 MB private per idle spare; parallel startups contend) | was: live edits fell back in place when the single spare was still warming (~3.3–5.2 s after each swap) | P0 |
| P6 ✅ | Theme switch as a warm swap (keep old frame, swap to a new-theme process) | **Done:** a theme change previously tore the preview down and cold-relaunched on bundled 2.2.0, then re-ran the matched upgrade (two repaints, placeholder interim, 4 processes). Now `SetTheme` drops the old-theme spare, warms a spare in the new theme on the *same* host (bundled or matched exe + pri) and promotes it via `TryPromoteSpare`; the old frame stays up until the swap. Falls back to the cold relaunch if no surface is running, a fidelity upgrade is still in flight, or the spare fails. Also fixed a stale-spare race (a superseded warm could clear `_spareWarming` for a newer one). No always-on opposite-theme spare (memory). Live (matched 2.5.1 host, quiet machine): cold baseline 1.6 s to a bundled paint + 3.7 s to matched (≈5.3 s total); warm swap 2.8–5.5 s (`theme.spare` 1.8–4.6 s + `theme.swap.paint` 0.9–1.1 s) straight to matched with no intermediate repaint; PrintWindow luma Dark 46 / Light 154 | `PreviewControl.SetTheme`/`TryBeginThemeSwap`/`CompleteThemeSwap`; `WarmSpare` | P5 |
| P7 ✅ | Keep the matched host across crash recovery | Verified: warm-spare recovery already kept the matched host, but cold/live-fallback recovery reset to the bundled exe and re-ran the fidelity upgrade (`upgrade.build` 2–400 s of placeholder fallback). Now `OnClosed` remembers the active matched exe/pri and `StartPreviewAsync` relaunches directly on it (no identity move, no `KickFidelityUpgrade`); a failed matched relaunch falls back to the normal path on the next attempt. Live: killed active + spare → `recover.livefallback.paint` 6.3 s on the 2.5.1 host, no re-upgrade (that session's initial `upgrade.build` was 206 s). | P0 |
| P8 ✅ | Prewarm packaged identity + fast already-registered check | **Done:** `SurfaceIdentity.EnsureRegistered` ran a PowerShell script (`Get-AppxPackage`, then `Add-AppxPackage -Register`) on every VS session's first packaged preview, costing 2.5–12.4 s even when the package was already registered (11–18 s for a real registration). Now: (1) a native check (`GetPackagesByPackageFamily` + `GetPackagePathByFullName`, ~10–40 ms) skips PowerShell when the package is already registered at this Surface folder; (2) `IdentityPrewarm` starts registration in the background from the first WinUI editor margin (which can come up minutes before the background-loaded package) and on solution open, for projects with only a packaged build; (3) `EnsureRegisteredAsync` de-dupes so the open path joins an in-flight prewarm instead of running PowerShell twice. **Measured (live VS, MockWinUIPreview):** repeat session `open.identity` 0 ms (fast check 11 ms), open→paint 7.2 s; after a reinstall (real registration) the open joined the prewarm and waited 10.9 s instead of ~17 s. | P0 |
| P9 ✅ | Re-measure vs baseline, record results; fault harness stays 9/9. Added a native ARM64 Surface | See "P9: x64-emulated vs native ARM64 Surface" below. Fault harness 9/9; provisioner fixtures 131/131 | all |

### P9: x64-emulated vs native ARM64 Surface

The VSIX now carries two Surface payloads: `Surface\` (x64) and `Surface-arm64\`
(arm64). Each has its own sparse-identity AppxManifest.

How the arch is chosen:
- `HostArch` reads the OS native machine (`IsWow64Process2`).
- It picks the matching bundled Surface, falling back to `Surface\`.
- The provisioner builds matched hosts with `--platform ARM64 --rid win-arm64`; platform and RID are part of the cache key.
- `ProjectDllLocator` only picks user DLLs that the host can load: same machine, AnyCPU, or I386.
- Only one arch of the sparse package can be registered per user. The first open on a new arch re-registers it (about 3–4 s).

Costs:
- VSIX size is 80.3 MB, of which about 39 MB is the arm64 payload.
- The first ARM64 matched build takes 60–75 s (the cache is per arch).

Bench method: Snapdragon X Elite, MockWinUIPreview, cache warm, live VS with a scripted sequence.
- Steps: open HomePage, upgrade, 6 edits, Dark/Light theme swaps, then kill active + spare.
- A = x64 Surface (emulated): 3 runs.
- B = ARM64 Surface: 4 runs.
- Medians:

| Metric | A: x64 emulated | B: native ARM64 |
|--------|----------------:|----------------:|
| Live edit → paint (`edit.livespare.paint`) | 1618 ms | **543 ms** |
| Theme swap → paint (`theme.swap.paint`) | 988 ms | **390 ms** |
| Theme spare ready (`theme.spare`) | 2012 ms | 1631 ms |
| Upgrade swap → paint (`upgrade.swap.paint`) | 1017 ms | **417 ms** |
| Crash → recovered (`recover.livefallback.paint`) | 2847 ms | 2214 ms |
| Bundled spawn → Ready | 868 ms | 755 ms |
| Matched spawn → Ready (private run) | 1223 ms | 933 ms |
| Open → first paint (`open.paint`) | 2196 ms | 2904 ms |
| `upgrade.build` (cache hit) | 1502 ms | 1629 ms |
| `client.runcopy` | 589 ms | 923 ms |

Notes on the comparison:
- **A did less work.** The mock's user DLL is ARM64-only, so under the x64 Surface it failed with `FileLoadException` and A rendered without user code. B loads and runs it. Real x64 machines are unaffected; they were not measured here.
- `open.paint` is higher on B partly for that reason.
- `client.runcopy` is a file copy done by the native extension, so arch shouldn't matter. It is higher on B and varies widely (340–4041 ms). The likely cause is AV scanning of the new binaries, but this is unconfirmed. Spares copy in the background, so it rarely affects the user.

Issues found and fixed during P9:
- **xbf staging race.** A bundled host (no private run) copies user `.xbf`/`.xaml` into its own install directory, and an active process and its spare could do this at the same time, causing an IOException. The bug was latent on x64 because the user DLL load failed first. `App.StageFile` now skips the copy if the destination already has the same size and mtime, and retries an IOException briefly.
- **Transient access denied on run-copy publish.** About once in 120 copies, the final `Directory.Move` of the staging dir failed. When that happened there was no spare until the next edit, which waited about 60 s. `CreateRunCopy` now retries the rename (up to 10 times, with backoff) as long as the destination still doesn't exist.

Open item (not fixed): matched spares run from `%TEMP%\wsr-v2`, which has no sparse identity. When they load a packaged user build they log "The process has no package identity". This was not visible under x64 because the DLL never loaded there.

Deferred (lower value in native mode): parsed-XAML caching, PNG supersampling cost.

**P2 decision (resolved):** no hardlinks. Copy-only, with each file hashed while it is copied.

---
## WS4 — Properties & interaction (designer parity)  🔜

- **I1 — Properties-to-XAML writeback.** 🧭 Continuation priority #1. Property
  edits currently change only the running preview, never the source
  (`PropertyPanelControl.cs:224-242` → `SetProperty` live-only). Implement
  writeback to the `.xaml` document with document-version checks and VS undo
  transactions. Needs a design pass (formatting preservation, attribute vs.
  element syntax, undo grouping).
- **I2 — Caret ↔ designer two-way sync.** Harden the authored-tree path derivation
  (`SelectByPath`, `ContentProps`, `XamlSourceMap`) so editor-caret→element and
  element→source navigation stay correct for custom content properties (bug D1/D3
  lineage).
- **I3 — Property panel breadth.** Expand beyond the current read-mostly set:
  categories, more type editors, brush/enum pickers.

---

## WS5 — Protocol robustness & versioning  🔜

Wire v1 has no request/document correlation and no real version negotiation
(`designer-migration.md`; `surface/protocol/Compatibility.cs:135-143`).

- **R1 — Request/document version correlation + stale-result rejection.** A late
  frame from a superseded document can paint. Add a monotonic doc/request id and
  drop stale replies.
- **R2 — Hello/Ready negotiation.** Enforce protocol-version compatibility instead
  of integer equality; reject mismatches with a clear message.
- **R3 — Accurate `Ready.wasdk`.** Currently fixed/stubbed; report the real host
  WASDK version so the fidelity-upgrade logic is trustworthy.
- **R4 — Shared contract fixtures.** Extract the protocol contract once and share
  fixtures across the C# host and `protocol.ts` (named next milestone) to prevent
  the C#/TypeScript drift already visible in stale comments.

---

## WS6 — Test coverage & CI  🔜

- **Q1 — VS-hosted integration tests.** All current harnesses (FaultTests, Smoke,
  UITest D2/D3) run *outside* VS. Add in-IDE coverage for margin lifecycle, dock
  toggles, pop-out, and document following.
- **Q2 — Extend fault + fidelity fixtures.** Grow `SurfaceClient.FaultTests` to
  protocol-level cases (R1–R3) and the render-fidelity scenarios (build on D2/D3).
- **Q3 — Dedicated VS CI lane.** No VS CI, clean-machine/runtime matrix, signing,
  or release ownership exists (continuation #5). Stand one up.

---

## WS7 — Multi-IDE identity & packaging safety  🔜🧭

- **Y1 — Side-by-side identity ownership.** `SurfaceIdentity.RunRegister` removes
  an existing user-scoped package when its recorded location differs, so two VS
  installs/payloads can displace each other and a failed replace can leave the
  prior registration unavailable (`designer-migration.md:432-456`). Make
  registration fail-safe (fail on differing location rather than remove).
- **Y2 — Non-elevated side-by-side proof.** Prove dedicated-suffix, non-elevated
  registration on a clean machine before any broad deployment.

---

## WS8 — UX polish  🔜 (in progress)

- **U1 — Narrow-toolbar overflow.** ✅ The in-tab toolbar now collapses in stages
  as the margin narrows (`XamlPreviewMargin.UpdateToolbarLayout`, run on every
  toolbar width change): (1) hide the "WinUI Preview" title, (2) drop button labels
  (icon + tooltip only), (3+) move buttons into a "⋯" overflow menu least-used first —
  Window, Dock, Sample data, Live, Properties, Size, Theme. Reload, Select and Hide
  never overflow. The menu is rebuilt on each open so toggle labels ("Live: On") are
  current; Theme/Size appear as submenus. Separators hide between empty groups.
  Gotcha fixed along the way: after collapsing a label, every ancestor's cached
  `DesiredSize` must be invalidated or the trial `Measure` still sees the old width.
  Verified live (VS 2022, 1.5× scale) by dragging the margin 1000 → 240 → 1000 DIP:
  full toolbar ≥ ~950, icons-only down to ~400, then one button per ~25–45 DIP into
  the menu; Live toggled on/off from the menu; reopen/close repeatedly. Not yet
  exercised live: picking a Theme/Size entry from the overflow submenus (Theme only
  overflows below ~260 DIP).
- **U2 — Error-presentation consistency.** ✅ One VS-themed visual language for every
  preview message:
  - **Info bars** (`UI/PreviewInfoBar.cs`) in their own row at the top of the preview,
    below the toolbar. They use `InfoBarColors` and severity monikers, and have an
    optional action and a close button. Bars: XAML error over the last good render,
    static (live-fallback) preview note, and full-fidelity progress/ready/unavailable.
    Because they sit in a separate Grid row, the native HWND shrinks below them. The old
    bottom overlays were drawn *under* the reparented HWND and were invisible in native
    mode (airspace).
  - **One blocking status card** (themed with `EnvironmentColors`) for loading,
    not-designable, failures and disconnect. It replaces the separate reconnect overlay.
    Failure cards (read/start/decode/host failures) now offer **Reload preview**.
  - XAML error text is cleaned up: `Line X, col Y — <message>` on one line, without the
    WinUI placeholder text or the duplicated `[Line: n Position: m]`.
  - Resilience fix found by a surface kill storm: when the active surface and the warm
    spare died together, the spare's death notice could arrive after it had been
    promoted. It was then treated as an idle spare dying, and the pane spun on
    "Recycling surface…" forever. The spare's Closed handler now carries the client's
    identity and routes a promoted spare's death to the active-death path.
    `TryPromoteSpare` also refuses an already-dead spare.
  - Verified live (native mode): error bar shows without a blocking card, the HWND moves
    below it and reclaims the space when fixed, dismiss and re-show work, and repeated
    surface kills always recover. Not exercised live: the give-up "Preview disconnected"
    card. The restart budget resets on each successful render, so kills spaced 6 s apart
    never exhaust it.
- **U3 — Frame-mode zoom/pan.** Add zoom/pan to the streamed-image path (native
  mode already scrolls via the holder).

---

## Suggested sequencing

1. **WS2 (fidelity)** — biggest perceived-quality win; F1 + F2 first.
2. **WS3 (performance)** — P2/P3 debounce+cache pair naturally with F-work.
3. **WS4 I1 (Properties writeback)** — the headline missing designer capability.
4. **WS5 (protocol)** — R1 underpins correctness for everything above.
5. **WS6 (CI)** — lock in the gains.
6. **WS7 / WS8** — ship-blockers and polish as release nears.

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
- **F2 — Live re-theming without a full relaunch.** 🧭 Today a theme change forces
  a full surface relaunch with a new `SURFACE_THEME` env; the host `SetTheme` is a
  no-op and `SurfaceClient.SetTheme`/`SetThemeMsg` is vestigial with a misleading
  "applies live" comment (`FrameServer.cs:340-351`, `PreviewControl.SetTheme`
  ~490-511, `Messages.cs:123`). Options: re-resolve `{ThemeResource}` on the live
  canvas, or keep a pre-warmed opposite-theme spare so the switch is a swap, not a
  cold start. Decide approach; also delete/fix the vestigial path + comment.
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

## WS3 — Performance & startup latency  🔜 (in progress)

Context that shapes the plan: VS defaults to **native-HWND mode** (`PreferNative`),
so the PNG encode/readback path matters less here than **process launch, run-copy,
and re-host** cost. The margin already debounces edits (500 ms) and resizes (180 ms).
On ARM64 every Surface process runs under x64 emulation, so each relaunch is
expensive.

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
| P2 🧭 | Make run-copy cheap: validate the pristine cache once per session, single-pass copy+hash, hardlink immutable files and copy only the mutable PRI | `HostPayload.cs` `Validate`/`CreateRunCopy` | P1 |
| P3 ✅ | GC orphaned run-copies (`%TEMP%\wsr-v2`, `%TEMP%\WinUIXamlPreview\run`) + bounded cache-generation GC. **Done:** `HostPayload.TryRetire` claims a directory by renaming it to `.trash-*` (blocked while a Surface uses it as its working directory) and then deletes it. `SurfaceClient` cleanup retries for ~5 s. `PreviewPackage` sweeps run-copies older than 10 min, 30 s after load. Provisioner `BuildStorage.Collect` keeps the 3 most recently used keys and retires others only after 1 day unused and with their lock free; it removes unreferenced generations older than 1 h and memos of retired keys. In VS the sweep reclaimed 18 dirs (~0.7 GB) in 0.5 s, live run dirs were untouched, and VS shutdown left no copies | 0.62 GB observed | P0 |
| P4 ✅ | Host latest-wins render coalescing (drop superseded `UpdateXaml`; keep resize/canvas/native ordering) | Done: `ReadLoop` now drains the socket on a `surface-recv` thread; an `UpdateXaml` immediately followed by another queued `UpdateXaml` is skipped (logged "superseded"). Any other message is an ordering barrier; malformed updates are never skipped. Protocol tests cover collapse, Resize barrier, malformed (fail on old code) | P0 |
| P5 | Spare pool for live edits: warm the next spare immediately; depth-2 in live mode | live mode = fresh process per edit | P0 |
| P6 | Theme switch as a warm swap (keep old frame, swap to a pre-warmed new-theme process) | `PreviewControl.SetTheme` cold relaunch; overlaps F2 | P5 |
| P7 | Keep the matched host across crash recovery (verify first) | cold restart resets `_activeUserPri = null` (~270) | P0 |
| P8 | Prewarm packaged identity at package load / solution open | `EnsureRegistered` PowerShell awaited before first launch (~276-290) | P0 |
| P9 | Re-measure vs baseline, record results; fault harness stays 9/9 | — | all |

Deferred (lower value in native mode): parsed-XAML caching, PNG supersampling cost.

**Open decision (P2):** hardlinking is fast but shares files with the pristine cache;
a process that wrote to a linked file would corrupt it. Options are read-only
attributes + verify-on-use, copy-only with trust-once validation, or both.

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

## WS8 — UX polish  🔜

- **U1 — Narrow-toolbar overflow.** The in-tab toolbar has ~11 buttons with no
  overflow handling, so it clips in a narrow margin (`XamlPreviewMargin.cs`
  `BuildToolbar` ~231-265; known baseline issue in `designer-migration.md:365`).
  Add overflow/wrap or an overflow menu.
- **U2 — Error-presentation consistency.** Continue the WS1 banner unification:
  fold `SetDetailBanner` / live-fallback / not-designable states into one coherent
  visual language.
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

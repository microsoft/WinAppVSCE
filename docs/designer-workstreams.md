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

## WS3 — Performance & startup latency  🔜

- **P1 — Matched-host cache-hit latency.** ~13 s in the IDE demo before the
  version-matched host swaps in (`docs/designer-migration.md` continuation #4).
  Profile the provision/cache-hit path and cut the hot cost.
- **P2 — Host-side render debounce/coalescing.** Every accepted `UpdateXaml`
  enqueues a full reparse + GPU→CPU PNG readback; there's no host debounce
  (`FrameServer.cs:183-201`, `RenderHost.cs:473-550`). Coalesce bursts so fast
  typing doesn't queue stale renders.
- **P3 — Parsed-XAML / visual-tree caching.** No parsed-XAML cache: each keystroke
  re-cleans and re-parses. Cache by content hash where safe.
- **P4 — ARM64 x64-emulation launch cost.** Surface/test exes run emulated, so
  process start is slow and every relaunch (crash recycle, theme switch, matched
  swap) is visible. Reduce relaunch triggers (see F2) and tune spare warming
  (`PreviewControl.xaml.cs` spare/upgrade generations).
- **P5 — Cache generation GC.** Retained immutable generations and orphaned run
  copies have no automatic cleanup; abrupt IDE termination leaks temp dirs
  (`designer-migration.md` limitations). Add bounded GC.

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

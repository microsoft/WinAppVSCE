# WinApp VS Code Extension — Feature Specs (C1–C8)

Draft specifications for the **C** roadmap area: the delivery surface that brings the **winui CLI (B)**
and the **shared design-time engine (B4)** into the editor — VS Code and its AI-native forks (Cursor,
Windsurf) — while continuing to support the cross-platform frameworks **winapp (A)** targets.

> **Status:** all specs are **drafts for discussion**. Effort figures are planning-grade estimates for the
> **extension/editor side** and, where noted, **exclude** the underlying CLI (B) and design-time engine
> (B4/B4b/B4c) work that several features depend on. Each spec has full detail: motivation, prior-art /
> competitive analysis, implementation outline, API/contribution surface, tradeoffs, supported / not-
> supported, open questions, and phasing.

## The specs

| # | Feature | Spec | Depends on | Est. (editor side) |
|---|---------|------|-----------|--------------------|
| **C1** | XAML language server | [C1-xaml-language-server.md](./C1-xaml-language-server.md) | B, B4 | 16–26 wk |
| **C2** | AppxManifest IntelliSense | [C2-appxmanifest-intellisense.md](./C2-appxmanifest-intellisense.md) | B, existing manifest editor | 5–9 wk |
| **C3** | XAML visualiser (live preview) | [C3-xaml-visualiser.md](./C3-xaml-visualiser.md) | **B4c**, B | 10–16 wk |
| **C4** | XAML designer (interactive) | [C4-xaml-designer.md](./C4-xaml-designer.md) | **B4b**, C3, C1 | 28–44 wk |
| **C5** | Run and hot reload | [C5-run-and-hot-reload.md](./C5-run-and-hot-reload.md) | **B2**, **B3** | 10–16 wk |
| **C6** | Visual tree & property editor | [C6-visual-tree-property-editor.md](./C6-visual-tree-property-editor.md) | **B4**, C5 | 12–20 wk |
| **C7** | Surface winui CLI commands | [C7-surface-cli-commands.md](./C7-surface-cli-commands.md) | B | 6–10 wk |
| **C8** | Agents & skills for Copilot | [C8-agents-and-skills.md](./C8-agents-and-skills.md) | B, C1, C2, C7, WinUI skills | 7–12 wk |

**Rough editor-side total:** ~94–153 engineer-weeks (does **not** include B/B4 engine work). These are
independent tracks that can be staffed in parallel where dependencies allow.

## Roadmap reference legend

These specs reference the team's broader roadmap shorthand:

| Ref | Meaning (as used here) |
|-----|------------------------|
| **A** | The cross-platform framework support the winapp CLI provides (.NET/WPF/WinForms/WinUI 3, C/C++, Electron, Rust, Tauri, Flutter). |
| **B** | The winui / winapp CLI. |
| **B2** | CLI **run** capability. |
| **B3** | CLI **hot reload** capability (in-app agent for C#/XAML). |
| **B4** | The **shared design-time engine** (type resolution, rendering, runtime inspection). |
| **B4b** | B4's **XAML designer** support (render + hit-test + layout/property metadata for interactive editing). |
| **B4c** | B4's **XAML visualiser** support (design-time rendering for read-only preview). |
| **C** | This editor delivery surface (VS Code + Cursor/Windsurf). |

> If any of these mappings differ from the team's intent, flag it — a few specs (C3/C4/C6) hinge on the
> exact capabilities B4/B4b/B4c will expose.

## Suggested sequencing (for discussion)

1. **Foundation / quick wins:** **C7** (surface new/build/run + API search) and **C2** (manifest
   IntelliSense) — highest value-to-cost, mostly editor work, few external dependencies.
2. **Editor intelligence:** **C1** (XAML language server) — the type system it builds is reused by C3/C4/C8.
3. **Design-time loop (engine-gated):** **C3** (visualiser) → **C4** (designer), as B4c/B4b land.
4. **Runtime loop (engine-gated):** **C5** (run + hot reload) → **C6** (live tree/property editor).
5. **AI-native surface:** **C8** — can start early (participant + read-only tools) and grow as C1/C7 mature.

## Prior-art themes (cross-cutting)

- **Editor-agnostic by design.** Keep logic in language servers / MCP / webviews so VS Code, Cursor, and
  Windsurf behave identically (avoid VS Code-proprietary-only paths). Explicit in C1, C3, C8.
- **One design-time engine (B4), many surfaces.** C1's type system, C3's render, C4's hit-test, and C6's
  inspection should share B4 rather than each re-deriving the WinUI object model.
- **Design-time vs running-app is a deliberate split.** C3/C4 are *design-time* (no build/run); C5/C6 act on
  the *running* app. Competitors blur these (Uno = running-app preview/design; VS Live Preview = running
  app); we separate them intentionally and should say so.
- **Wrap the CLI, don't reinvent it.** C2/C5/C7/C8 surface CLI (B) capabilities with editor UX; the CLI
  stays the source of truth for actions and indexes.

## Mockups

Each spec embeds a UI mockup (in [`images/`](./images)) illustrating the proposed experience. Mockups are
illustrative, not final visual design. Their HTML sources live in [`.mockups/`](./.mockups) and can be
re-rendered to PNG with a headless Chromium/Edge (`--screenshot`).

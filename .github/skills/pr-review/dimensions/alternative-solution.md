# Alternative solution

Apply `_shared-contract.md`. Set `Domain: alternative-solution`.

One question: **does this reinvent something that already exists here?** Grep
before you conclude — "uses `runWinappCapture` correctly" is only a real
sign-off if you looked for the alternative and named what you searched for.

Scope and "should this ship at all" belong to `necessity-and-simplicity`. Stay on
*how* the work is done. But do not self-censor a genuine better-approach critique
because it borders on scope — raise the concrete alternative and let that
dimension own the framing.

## Things this repo already has

New code that re-derives any of these should call them instead:

| Instead of | Use |
|---|---|
| Re-discovering the bundled CLI path, or spawning `winapp` without the caller tag | `getWinappCliPath` / `WINAPP_CLI_CALLER_VALUE` in `src/winapp-cli-utils.ts` |
| A fresh `spawn` + output-channel + JSON scraping for a CLI call | `runWinappCapture` / `getWinappOutputChannel` (`src/winapp-host.ts`), `extractJsonObject` / `parseWinappErrorMessage` (`src/winapp-cli-utils.ts`) |
| Hand-quoting values for `Terminal.sendText` or elevated commands | `escapePowerShellArg`, `decideElevatedWinappCommand`, `buildElevatedTerminalCommand` |
| Picking a cwd or project folder | `resolveWorkingDirectory`, `resolveProjectDirectory` (`src/project-resolver.ts`), `detectProjects` (`src/project-detection.ts`), `selectFolder` |
| Recursive workspace scans | `walkDirectoryTree` (`src/directory-walk.ts`) with `SKIP_DIRS` / `BUILD_OUTPUT_*` limits |
| Classifying `.msix` / `.exe` / cert files | `src/artifact-types.ts`, `src/sign-utils.ts` (`findWorkspaceArtifacts`, tier constants) |
| Arch detection / mismatch warnings | `src/arch-detection.ts` |
| Parsing manifest XML into a model | `parseManifest` (editor) or `parseManifestXml` (IntelliSense) |
| Structural `AppxManifest.xml` edits | `src/manifest-editor/manifest-xml-ops*.ts` and `xml-utils.ts` (formatting-preserving, namespace-aware, escaping via `escapeXmlAttr` / `escapeXmlText`) |
| Manifest field or schema validation | `manifest-validator.ts`, `src/manifest-schema/schema-validation.ts`, `semantic-validation.ts`, `schema-helpers.ts` |
| Image / MRT asset path resolution and containment | `resolveManifestImagePath`, `resolveMrtAsset`, `isPathWithin` (`src/manifest-editor/image-utils.ts`) |
| Matching manifest file names | `isManifestPath` / `MANIFEST_SELECTOR` (`src/manifest-schema/manifest-path.ts`) |

Do not round-trip the user's manifest through a DOM serializer — it reformats
the file. Do not add a new ad-hoc regex edit when an `xml-utils` /
`manifest-xml-ops` helper covers the structure.

## Structure

- **Testable logic lives in `*-utils.ts` / pure modules, not `extension.ts`.**
  The unit suite runs outside VS Code; logic that only exists inside a
  `vscode.commands.registerCommand` callback cannot be unit-tested. Recommend
  extraction only when it gives a real test or reuse boundary.
- **Prefer cohesion.** One implementation is better than several one-caller
  wrappers.
- **Treat file size as a signal.** `extension.ts` is already large; flag a
  concrete cohesion, navigation, or test problem, not a line count by itself.
- **Duplication inside this PR.** If the diff repeats a near-identical block
  across commands or webview tabs, recommend one shared helper and cite each
  site. Near-duplicates silently drift.

## Not findings

"Consider a different pattern" with no concrete callable alternative. A
wholesale rewrite with no incremental path — offer the smallest concrete reuse
instead.

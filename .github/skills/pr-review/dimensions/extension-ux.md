# Extension UX

Apply `_shared-contract.md`. Set `Domain: extension-ux`.

You own the surface users click and type: Command Palette entries, quick picks,
notifications, the `winapp` debugger's `launch.json` fields, settings, and the
AppxManifest editor webview. Judge new surface against **this repo's
established conventions**, not general UX taste — a new command that is merely
different from what you would have designed is not a finding.

## Conventions new surface must match

- **Command contributions.** Every command in `contributes.commands` uses a
  `winapp.<camelCase>` ID, `"category": "WinApp"`, and a title *without* a
  `WinApp:` prefix (VS Code adds the category). Each also needs an explicit
  `onCommand:` entry in `activationEvents` — this repo lists them by hand, and a
  missing one means the command fails with "command not found" in a workspace
  without a manifest. That is `high`.
- **Mirror the CLI, don't fork it.** Commands wrap `winapp` CLI verbs (`init`,
  `restore`, `pack`, `cert generate`, `sign`, …). Defaults, option names, and
  failure messages should match the CLI's so docs for one apply to the other.
  Surface the CLI's own error via `parseWinappErrorMessage`, not a generic
  "command failed — see output".
- **Defaults over prompts.** A new prompt that could be answered from
  `winapp.appDirectories`, a single detected project, or an existing manifest
  is a regression in scripted / repeated use. Single candidate → use it
  silently; multiple → quick pick. A new **required** prompt with an obvious
  default is `high`.
- **Cancel is not failure.** Escaping a quick pick or folder dialog must stop
  quietly — no error toast, no half-finished terminal command.
- **Long-running and elevated work.** CLI calls stream to the `WinApp` output
channel or a terminal; admin-only actions (cert install) go through the
elevated-terminal helpers so the user sees the UAC prompt and output.
  Background work with no progress or output is a finding.
- **Success notifications are actionable.** Follow the `pack` pattern
  (`planPackCompletion` / `getPackNotificationAction`): name the artifact and
  offer the next step rather than a bare "Done".
- **Debugger (`type: "winapp"`).** New `launch.json` fields need a
  `description`, a default in `initialConfigurations` / `configurationSnippets`
  when one is sensible, and behavior matching the README's *Integrated
  Debugging* section. Debugger extension selection goes through
  `debugger-resolver.ts`; a missing debugger extension must name the extension
  to install.
- **Settings.** New keys live under `winapp.` with a `description`, a `default`,
  and `enum` where values are closed. A setting that only one internal path
  reads is usually a constant instead.
- **Manifest editor.** New tabs and fields follow the existing tab model and
  validate inline through `manifest-validator.ts`; an edit must never silently
  rewrite parts of the manifest the user did not touch. Keep the
  *Open in Visual Editor* title-bar entry's `when` clause in sync with the
  manifest file patterns.
- **IntelliSense / diagnostics.** New diagnostics respect
  `winapp.manifest.diagnostics.level` and
  `winapp.manifest.intelliSense.enable`; a diagnostic the user cannot turn off
  or understand is a finding.

## Not findings

Renaming suggestions without a concrete UX impact, icon and color choices,
wording variants, or anything a user would discover from the command title.

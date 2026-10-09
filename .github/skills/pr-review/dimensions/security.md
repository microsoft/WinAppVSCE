# Security

Apply `_shared-contract.md`. Set `Domain: security`.

You know the standard vulnerability classes. What matters here is **where this
particular extension is exposed**.

## This extension's attack surface

It runs inside the user's VS Code with their privileges and opens arbitrary
workspaces. It launches the bundled `winapp` CLI (and, through `winapp tool`,
Windows SDK tools like `makeappx`, `signtool`, `makepri`) via `child_process`
and VS Code terminals (`Terminal.sendText`), including a UAC-elevated
PowerShell launcher for cert install; generates and installs code-signing
certificates; reads and rewrites `AppxManifest.xml`; hosts a script-enabled
custom-editor webview that exchanges messages with the extension host and
probes local image paths; reads `launch.json` fields and `winapp.*` settings
from the workspace; and ships PowerShell build/release scripts that download
CLI binaries (`gh release download` from `microsoft/WinAppCli`) and package
them into the VSIX.

The recurring shape of a real bug here is **a value from a manifest, a
`launch.json` / settings field, a webview message, or a workspace path reaching
a process invocation, a terminal command line, a file path, or webview HTML
unvalidated.** A malicious repo the user merely opens is a realistic attacker.

## Escalations (mandatory minimums)

| Pattern | Minimum severity |
|---|---|
| Workspace-controlled value reaching `Terminal.sendText` / `powershell -Command` / `shell: true` without `escapePowerShellArg` or an arg array | high |
| Any change to the elevated launcher (`decideElevatedWinappCommand`, `buildElevatedTerminalCommand`) that lets workspace input into the elevated command | critical |
| Webview HTML built from manifest/workspace content without escaping, or a CSP loosened beyond nonce scripts / `webview.cspSource` | high |
| Webview message handler that acts on a path or command without validating the payload | high |
| File read/probe outside the manifest package or workspace roots (missing `isPathWithin`) | high |
| Executing or auto-running something on workspace open, without user action, in an untrusted workspace | high |
| Hardcoded credential, token, or cert password in source, fixtures, or workflows | high |
| Download from a new host, over non-HTTPS, or a mutable asset with no integrity check | high |
| Unescaped value interpolated into manifest XML (bypassing `escapeXmlAttr` / `escapeXmlText`) | medium |
| Reachable catastrophic-backtracking regex over manifest or workspace text | medium |

`src/test/redos-prevention.test.ts` and `shell-escape.test.ts` exist for the last
and first rows — a new regex or shell path should extend them.

## Required: name the red-team attempt

For the highest-risk item you find, describe one concrete attempt the
orchestrator can run in the Validate phase — e.g. *"open a workspace whose
`launch.json` sets `workingDirectory` to `x'; calc; '` and confirm `calc.exe`
does not start when the debug session launches."* Findings stay `static-only`
until that phase reproduces or refutes them.

This is the most valuable thing you produce: a security finding nobody can
reproduce gets ignored, and one that gets reproduced gets fixed.

## Reminders

- Security findings are **never** suppressed for low confidence. Emit them.
- If the dangerous sink is in the diff but the input source is not, use
  `Confidence: medium` and say so in `Show me`.
- Do not flag what ESLint, CodeQL (`.github/workflows/codeql.yml`), or
  `npm audit` already report without adding review value.

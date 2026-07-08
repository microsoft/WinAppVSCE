# WinApp VS Code Extension — UX findings assets

This branch hosts screenshots referenced by the UX-improvement issues filed against
`microsoft/WinAppVSCE`. It exists only to provide stable image URLs for those issues and
intentionally makes no changes to `main`/release branches.

Screenshots were captured during a hands-on live run of the extension
(`microsoft-winappcli.winapp` v0.2.1-prerelease.6, WinApp CLI 0.4.0) across several WinUI 3
apps on VS Code 1.127.0 / Windows on ARM.

| Image | Shows |
|-------|-------|
| `images/pack-no-exe-error.png` | `winapp.pack` error: "no .exe files were found in the input folder" (wrong default folder). |
| `images/f5-folderpicker-cert-csharp.png` | F5 native folder picker + cert "Access denied" + "coreclr requires the C# extension" notification. |
| `images/pack-selfcontained-quickpick.png` | The "Bundle Windows App SDK runtime (self-contained)?" QuickPick during pack. |
| `images/f5-debugger-attached.png` | WinApp debugger attached and app running ("WinApp: Launch and Attach"). |

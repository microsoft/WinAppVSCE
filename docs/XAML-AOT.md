# XAML language-server Native AOT support

Native AOT describes the language-server executable, not the user's application.
The server does not certify applications or their dependencies as AOT-compatible.
MSBuild and source generators run outside the native process using the installed
.NET SDK and the bundled framework-dependent .NET 10 generator helper.

## Compatibility boundary

The current compiler dependency is Microsoft.CodeAnalysis 5.0.0, whose package
identifies Roslyn commit `6c4a46a31302167b425d5e0a31ea83c9a9aa1d09`.
The shared stdio smoke fixture uses CommunityToolkit.Mvvm 8.4.2 and asserts
completion and typed hover for its generated `Title` and `RefreshCommand` members.
Each helper invocation uses a fresh output directory and manifest; failure is
reported as degraded project context, not silently replaced with cached output.
Other generators must be compatible with the helper's compiler/runtime; this is
not a blanket compatibility promise for arbitrary analyzer assemblies.

`npm run test:xaml-bundled` runs the smoke against the actual native executable.
CI covers Windows x64 and ARM64. Release validation runs it against the extracted
signed artifact without rebuilding that artifact. Signed ARM64 execution is
tracked separately in [#296](https://github.com/microsoft/WinAppVSCE/issues/296).
Managed unit tests alone do not prove this deployment boundary.

## Design-time project state

MSBuild uses server-private intermediate and output folders, including referenced
projects. The markup compiler reads XAML snapshots rather than holding editor
files open. These folders are reused while the server runs and removed on exit.
Normal builds continue to use the project's own `obj` and `bin` folders.

Project refreshes retain the last usable context. A XAML compile error does not
prevent loading C# project types, and failed loads do not restart on each edit.
Rename checks use current project state rather than a retained compilation.
Saving or reopening a XAML document checks disk inputs for missed watcher events;
changed package references, including centrally managed versions, require matching
restored assets. Input scans skip and log inaccessible or disappearing directories
and files rather than failing project loading or document refresh.

## Roslyn trim-warning dispositions

Warnings remain visible. These dispositions apply to the pinned source, not future
Roslyn releases; a successful publish alone is not evidence of runtime correctness.

| Warning family | Source and disposition |
|---|---|
| IL2026, IL2075: `UICultureUtilities` | [Pinned source](https://github.com/dotnet/roslyn/blob/6c4a46a31302167b425d5e0a31ea83c9a9aa1d09/src/Compilers/Core/Portable/InternalUtilities/UICultureUtilities.cs) probes culture setters through reflection. Failed probes return false; when neither setter is available, `WithCurrentUICulture` returns the original delegate. This preserves execution but may lose Roslyn's explicit culture transfer across callbacks. Diagnostic localization parity is not guaranteed. No arbitrary assembly loading is needed by this fallback. |
| IL2091: `PooledDelegates` / `ConditionalWeakTable` callbacks | [Pinned source](https://github.com/dotnet/roslyn/blob/6c4a46a31302167b425d5e0a31ea83c9a9aa1d09/src/Dependencies/PooledObjects/PooledDelegates.cs) constructs the delegate wrapper with a constrained `new()` and invokes a supplied value factory. The callback path does not reflectively construct `TValue`; the generic annotation warning is not evidence that the callback needs a public parameterless value constructor. Keep the warning visible and exercise symbol queries through the native bundle. |
| IL2091: `RoslynLazyInitializer.EnsureInitialized<T>` | The [wrapper](https://github.com/dotnet/roslyn/blob/6c4a46a31302167b425d5e0a31ea83c9a9aa1d09/src/Compilers/Core/Portable/InternalUtilities/RoslynLazyInitializer.cs) omits the constructor annotation required by the no-factory runtime overload. The relevant [compilation call](https://github.com/dotnet/roslyn/blob/6c4a46a31302167b425d5e0a31ea83c9a9aa1d09/src/Compilers/Core/Portable/Compilation/Compilation.cs) lazily creates `ConcurrentDictionary<SyntaxTree, SmallConcurrentSetOfInts>` for used-import tracking. `LoadProjectAsync` explicitly preserves the public parameterless constructor of `ConcurrentDictionary<,>` rather than relying on unrelated code to retain it. Factory-based type-name caches use explicit construction. Recheck concrete types on upgrades; this is not a general preservation rule for all Roslyn internals. |

These are bounded source-based dispositions plus runtime coverage, not an
upstream guarantee that every Roslyn API works under AOT. The server deliberately
uses the compiler layer, not Workspaces, MEF composition, or in-process analyzers.
No assembly-wide preservation or warning-class suppression is applied.

## Upgrade and regression checks

The contributor updating Roslyn, the SDK/runtime, or the generator helper must
compare full publish warnings with these dispositions, inspect changed call
paths, and run server tests plus native bundled smoke on both shipping
architectures. The reviewing maintainer owns acceptance of new warning families
or compatibility exceptions. Keep artifact-mode release tests distinct from
locally republished binaries.

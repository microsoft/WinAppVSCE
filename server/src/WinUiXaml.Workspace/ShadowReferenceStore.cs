using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Emit;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Emits stand-in assemblies for referenced projects that have never been built, so the XAML
    /// markup compiler can resolve them.
    /// </summary>
    /// <remarks>
    /// The markup compiler runs out of process and reads references off disk, so unlike Roslyn --
    /// which happily consumes a referenced project's in-memory compilation -- it cannot be handed
    /// a compilation directly. Without a file it aborts while building its schema context and
    /// writes empty generated code, which costs the user <c>InitializeComponent</c> and every
    /// <c>x:Name</c> field in the project.
    ///
    /// The compilations written here are the same ones the workspace already builds from the
    /// referenced projects' sources, so this adds no analysis work; it only materializes what is
    /// already in memory. Metadata-only emit is used because the markup compiler reads type shapes
    /// and never executes anything, and because skipping method bodies means source that does not
    /// yet compile cleanly still produces a usable reference.
    /// </remarks>
    internal static class ShadowReferenceStore
    {
        /// <summary>
        /// The targets file injected into the design-time build. It swaps unresolvable
        /// <c>ReferencePath</c> entries for their stand-ins immediately before the markup compiler
        /// reads that item, and re-imports whatever the project had in the hook it is borrowing.
        /// </summary>
        private const string InjectedTargets = """
<Project>
  <Import Project="$(WinUiXamlChainedCustomAfterTargets)"
          Condition="'$(WinUiXamlChainedCustomAfterTargets)' != '' and Exists('$(WinUiXamlChainedCustomAfterTargets)')" />

  <Target Name="WinUiXamlInjectShadowReferences"
          BeforeTargets="DesignTimeMarkupCompilationCT;MarkupCompilePass1"
          Condition="'$(WinUiXamlShadowReferenceDir)' != ''">
    <ItemGroup>
      <_WinUiXamlMissingReference Include="@(ReferencePath)"
                                  Condition="!Exists('%(ReferencePath.FullPath)')" />
      <ReferencePath Remove="@(_WinUiXamlMissingReference)" />
      <ReferencePath Include="$(WinUiXamlShadowReferenceDir)\%(_WinUiXamlMissingReference.Filename)%(_WinUiXamlMissingReference.Extension)"
                     Condition="Exists('$(WinUiXamlShadowReferenceDir)\%(_WinUiXamlMissingReference.Filename)%(_WinUiXamlMissingReference.Extension)')" />
    </ItemGroup>
  </Target>
</Project>
""";

        private const string TargetsFileName = "WinUiXaml.ShadowReferences.targets";

        /// <summary>
        /// Writes stand-ins for <paramref name="compilations"/> and returns the injection that
        /// points a design-time build at them, or null when none could be written.
        /// </summary>
        internal static MsBuildCli.ShadowReferenceInjection? Create(
            string rootProjectPath,
            IReadOnlyCollection<Compilation> compilations,
            string? chainedCustomAfterTargets,
            CancellationToken cancellationToken)
        {
            if (compilations.Count == 0)
            {
                return null;
            }

            string directory;
            try
            {
                directory = PrepareDirectory(rootProjectPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine(
                    $"[winui-xaml-ls] could not prepare the reference scratch directory: {ex.Message}");
                return null;
            }

            var emitted = 0;
            foreach (var compilation in compilations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (TryEmit(compilation, directory))
                {
                    emitted++;
                }
            }

            if (emitted == 0)
            {
                return null;
            }

            var targetsFile = Path.Combine(directory, TargetsFileName);
            try
            {
                File.WriteAllText(targetsFile, InjectedTargets);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine(
                    $"[winui-xaml-ls] could not write '{targetsFile}': {ex.Message}");
                return null;
            }

            return new MsBuildCli.ShadowReferenceInjection(
                directory, targetsFile, chainedCustomAfterTargets);
        }

        private static bool TryEmit(Compilation compilation, string directory)
        {
            var name = compilation.AssemblyName;
            if (string.IsNullOrWhiteSpace(name))
            {
                return false;
            }

            var path = Path.Combine(directory, name + ".dll");
            try
            {
                // The stream is scoped so it is closed before the failure path runs: deleting a
                // file that still has an open writer leaves the zero-length stub behind, and a
                // zero-length .dll is exactly what the injected targets would go on to substitute.
                using (var stream = new FileStream(
                    path, FileMode.Create, FileAccess.Write, FileShare.Read))
                {
                    var result = compilation.Emit(
                        stream,
                        options: new EmitOptions(metadataOnly: true, includePrivateMembers: false));
                    if (result.Success)
                    {
                        return true;
                    }
                }

                // A half-written project is the normal state while editing, so this is expected
                // rather than exceptional. Naming the project keeps the consequence -- its types
                // missing from XAML completion -- attributable.
                Console.Error.WriteLine(
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"[winui-xaml-ls] could not synthesize a reference for '{name}': its source does not currently declare a valid assembly."));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine(
                    $"[winui-xaml-ls] could not write a reference for '{name}': {ex.Message}");
            }

            try
            {
                File.Delete(path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Nothing else reads this directory, so a stub that survives here is inert.
            }

            return false;
        }

        /// <summary>
        /// A directory of its own for every synthesis, so no two loads of the same project share
        /// mutable state and a reference can never outlive the source that produced it.
        /// </summary>
        /// <remarks>
        /// A single directory per project was the obvious shape and the wrong one: both load
        /// stages, and concurrent loads from two open documents, repair the same project, so one
        /// of them would clear the assemblies while another's design-time build was reading them.
        /// Writing somewhere new instead removes the contention rather than coping with it, at the
        /// cost of a sweep for the directories previous repairs left behind.
        /// </remarks>
        private static string PrepareDirectory(string rootProjectPath)
        {
            var root = Path.Combine(
                Path.GetTempPath(), "winui-xaml-ls", "refs", Fingerprint(rootProjectPath));
            Directory.CreateDirectory(root);
            SweepStaleDirectories(root);

            var directory = Path.Combine(root, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            return directory;
        }

        /// <summary>
        /// Discards synthesis directories old enough that no build can still be reading them.
        /// </summary>
        /// <remarks>
        /// Age is the only signal available: the build that owns a directory belongs to this
        /// process, but directories also outlive crashes and earlier sessions. The window is far
        /// longer than any design-time build, and a directory still in use simply fails to delete
        /// and is swept on a later pass.
        /// </remarks>
        private static void SweepStaleDirectories(string root)
        {
            var cutoff = DateTime.UtcNow - StaleAfter;
            try
            {
                foreach (var candidate in Directory.EnumerateDirectories(root))
                {
                    try
                    {
                        if (Directory.GetLastWriteTimeUtc(candidate) < cutoff)
                        {
                            Directory.Delete(candidate, recursive: true);
                        }
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        // In use, or already gone. Either way the next sweep can have it.
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Reclaiming disk is never worth failing a repair over.
            }
        }

        private static readonly TimeSpan StaleAfter = TimeSpan.FromHours(1);

        private static string Fingerprint(string value)
        {
            var hash = SHA256.HashData(
                Encoding.UTF8.GetBytes(value.ToUpperInvariant()));
            return Convert.ToHexString(hash, 0, 8);
        }
    }
}

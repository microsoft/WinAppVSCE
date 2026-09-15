using System;
using System.IO;
using System.Threading;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// The targets file every design-time build is run with. It supplies the three things a
    /// command-line design-time build needs that Visual Studio otherwise provides from inside the
    /// IDE.
    /// </summary>
    /// <remarks>
    /// Visual Studio runs design-time builds with <c>BuildingInsideVisualStudio=true</c>, which is
    /// a statement about the host rather than a build switch: it tells MSBuild "the IDE owns
    /// building project references, so don't build them here" (Microsoft.Common.CurrentVersion
    /// .targets, the <c>ResolveProjectReferences</c> pair at ~L2138/L2158). A command-line design
    /// -time build has no IDE to fall back on, so borrowing that flag leaves every
    /// <c>ProjectReference</c> unbuilt and the WinUI markup compiler fails with WMC1006 the moment
    /// it tries to read one.
    ///
    /// So this build does not claim to be Visual Studio. Instead it asks for the reference builds
    /// explicitly and re-supplies, by hand, the two side effects the flag was carrying:
    ///
    /// <list type="bullet">
    /// <item><description><c>NonExistentFile</c> keeps <c>CoreCompile</c> from being skipped as
    /// up to date. It is the same value <c>_ComputeNonExistentFileProperty</c> assigns; without it
    /// an already-built project returns no <c>CscCommandLineArgs</c> at all.</description></item>
    /// <item><description>The markup pass is invoked here rather than named on the command line.
    /// <c>DesignTimeMarkupCompilation</c> only exists in projects that import the WinUI targets,
    /// and MSBuild fails the whole invocation with MSB4057 for a target the project does not
    /// define -- an error that <c>ContinueOnError</c> cannot demote, because it is raised against
    /// the build request rather than by a task. Deciding inside MSBuild, against
    /// <c>XamlCompilerTaskPath</c>, is what makes the same invocation safe for a plain class
    /// library.</description></item>
    /// </list>
    ///
    /// <c>_GlobalPropertiesToRemoveFromProjectReferences</c> is the third piece. Global properties
    /// flow down into referenced project builds, so <c>SkipCompilerExecution</c> would suppress the
    /// reference's own csc and leave it just as unbuilt as before. This is the hook the
    /// <c>MSBuild</c> task already reads (<c>RemoveProperties</c> at ~L1044/L1852), so the
    /// reference gets an ordinary build while this project stays design-time.
    /// </remarks>
    internal static class DesignTimeTargets
    {
        private const string Contents = """
<Project>
  <PropertyGroup>
    <_GlobalPropertiesToRemoveFromProjectReferences>$(_GlobalPropertiesToRemoveFromProjectReferences);SkipCompilerExecution;ProvideCommandLineArgs;DesignTimeBuild;DesignTimeSilentResolution;WinUiXamlDesignTimeRoot</_GlobalPropertiesToRemoveFromProjectReferences>

    <!--
      A WinUI app is built for a concrete platform (x64/arm64) while the libraries it references
      are usually platform-neutral. Global properties flow down, so the app's Platform would be
      forced onto a reference that never declared it and the reference build fails before it
      starts. This is the SDK's own answer: each reference is matched to its nearest compatible
      platform instead of inheriting ours.
    -->
    <EnableDynamicPlatformResolution Condition="'$(EnableDynamicPlatformResolution)' == ''">true</EnableDynamicPlatformResolution>
  </PropertyGroup>

  <PropertyGroup Condition="'$(WinUiXamlDesignTimeRoot)' == 'true'">
    <NonExistentFile>__NonExistentSubDir__\__NonExistentFile__</NonExistentFile>
  </PropertyGroup>

  <Target Name="WinUiXamlDesignTimeMarkup"
          BeforeTargets="CoreCompile"
          Condition="'$(WinUiXamlDesignTimeRoot)' == 'true'">
    <CallTarget Targets="DesignTimeMarkupCompilation" Condition="'$(XamlCompilerTaskPath)' != ''" />
  </Target>
</Project>
""";

        private const string FileName = "WinUiXaml.DesignTime.targets";

        private static readonly object Gate = new();
        private static string? _path;

        /// <summary>
        /// The path to the targets file, written on first use. Returns null when it could not be
        /// written, in which case the build simply runs without it.
        /// </summary>
        internal static string? Resolve()
        {
            lock (Gate)
            {
                if (_path != null)
                {
                    return _path;
                }

                try
                {
                    var directory = System.IO.Path.Combine(
                        System.IO.Path.GetTempPath(), "winui-xaml-ls", "targets");
                    Directory.CreateDirectory(directory);
                    var file = System.IO.Path.Combine(directory, FileName);

                    // Rewritten on every process start so an older build's copy cannot outlive a
                    // change to the contents above.
                    File.WriteAllText(file, Contents);
                    _path = file;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    Console.Error.WriteLine(
                        $"[winui-xaml-ls] could not write the design-time targets file: {ex.Message}");
                    _path = null;
                }

                return _path;
            }
        }
    }
}

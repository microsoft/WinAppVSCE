using System;
using System.IO;
using System.Threading;

namespace WinUiXaml.Workspace
{
    /// <summary>
    /// Targets injected for command-line design-time builds. Claiming <c>BuildingInsideVisualStudio</c> instead would leave every <c>ProjectReference</c> unbuilt and fail WinUI markup with WMC1006, so this build requests reference builds explicitly and re-supplies that flag's side effects by hand.
    /// </summary>
    internal static class DesignTimeTargets
    {
        private const string Contents = """
<Project>
  <PropertyGroup>
    <!-- Global properties flow into reference builds, where SkipCompilerExecution would suppress their
         csc and leave them as unbuilt as BuildingInsideVisualStudio did. RemoveProperties is the MSBuild
         task's own hook: references get an ordinary build while this project stays design-time. -->
    <_GlobalPropertiesToRemoveFromProjectReferences>$(_GlobalPropertiesToRemoveFromProjectReferences);SkipCompilerExecution;ProvideCommandLineArgs;DesignTimeBuild;DesignTimeSilentResolution;WinUiXamlDesignTimeRoot;WinUiXamlUserAfterCSharpTargets</_GlobalPropertiesToRemoveFromProjectReferences>

    <!-- A WinUI app targets a concrete platform (x64/arm64) while its libraries are usually neutral.
         Global properties would force the app's Platform onto a reference that never declared it, failing
         that build before it starts. The SDK's answer: match each reference to its nearest platform. -->
    <EnableDynamicPlatformResolution Condition="'$(EnableDynamicPlatformResolution)' == ''">true</EnableDynamicPlatformResolution>
  </PropertyGroup>

  <PropertyGroup Condition="'$(WinUiXamlDesignTimeRoot)' == 'true'">
    <!-- Keeps CoreCompile from being skipped as up to date, the same value
         _ComputeNonExistentFileProperty assigns. Without it an already-built
         project returns no CscCommandLineArgs at all. -->
    <NonExistentFile>__NonExistentSubDir__\__NonExistentFile__</NonExistentFile>
  </PropertyGroup>

  <!-- The project's own CustomAfterMicrosoftCSharpTargets, displaced by this file. Re-imported so
       claiming the hook does not silently drop the user's targets. The remove-list above keeps it
       from flowing into referenced project builds, which import their own. -->
  <Import Project="$(WinUiXamlUserAfterCSharpTargets)"
          Condition="'$(WinUiXamlUserAfterCSharpTargets)' != '' and Exists('$(WinUiXamlUserAfterCSharpTargets)')" />

  <PropertyGroup Condition="'$(WinUiXamlBuildRoot)' != ''">
    <WinUiXamlProjectOutput>$(WinUiXamlBuildRoot)$([MSBuild]::StableStringHash('$(MSBuildProjectFullPath)'))\</WinUiXamlProjectOutput>
  </PropertyGroup>

  <!-- Global output properties protect project overrides. Each reference needs its own outputs,
       rather than inheriting the root project's paths into its ordinary build. -->
  <Target Name="WinUiXamlIsolateProjectReferences" BeforeTargets="AssignProjectConfiguration"
          Condition="'$(WinUiXamlBuildRoot)' != ''">
    <ItemGroup>
      <ProjectReference Update="@(ProjectReference)">
        <_WinUiXamlOutput>$(WinUiXamlBuildRoot)$([MSBuild]::StableStringHash('%(FullPath)'))\</_WinUiXamlOutput>
      </ProjectReference>
      <ProjectReference Update="@(ProjectReference)">
        <AdditionalProperties>%(ProjectReference.AdditionalProperties);IntermediateOutputPath=%(ProjectReference._WinUiXamlOutput)obj\;OutputPath=%(ProjectReference._WinUiXamlOutput)bin\;OutDir=%(ProjectReference._WinUiXamlOutput)bin\</AdditionalProperties>
      </ProjectReference>
    </ItemGroup>
  </Target>

  <Target Name="WinUiXamlSnapshotMarkup"
          BeforeTargets="DesignTimeMarkupCompilation;MarkupCompilePass1;MarkupCompilePass2"
          Condition="'$(WinUiXamlProjectOutput)' != ''">
    <ItemGroup>
      <_WinUiXamlOriginalPage Include="@(Page)">
        <SnapshotRelativePath>%(Identity)</SnapshotRelativePath>
        <SnapshotRelativePath Condition="$([System.IO.Path]::IsPathRooted('%(Identity)')) or $([System.String]::Copy('%(Identity)').StartsWith('..'))">$([MSBuild]::StableStringHash('%(FullPath)'))\%(Filename)%(Extension)</SnapshotRelativePath>
        <Snapshot>$(WinUiXamlProjectOutput)xaml\%(_WinUiXamlOriginalPage.SnapshotRelativePath)</Snapshot>
        <Link Condition="'%(_WinUiXamlOriginalPage.Link)' == ''">%(_WinUiXamlOriginalPage.SnapshotRelativePath)</Link>
      </_WinUiXamlOriginalPage>
      <_WinUiXamlOriginalApplicationDefinition Include="@(ApplicationDefinition)">
        <Snapshot>$(WinUiXamlProjectOutput)xaml\%(Filename)%(Extension)</Snapshot>
        <Link Condition="'%(_WinUiXamlOriginalApplicationDefinition.Link)' == ''">%(Identity)</Link>
      </_WinUiXamlOriginalApplicationDefinition>
    </ItemGroup>
    <Copy SourceFiles="@(_WinUiXamlOriginalPage)" DestinationFiles="@(_WinUiXamlOriginalPage->'%(Snapshot)')" SkipUnchangedFiles="true" />
    <Copy SourceFiles="@(_WinUiXamlOriginalApplicationDefinition)" DestinationFiles="@(_WinUiXamlOriginalApplicationDefinition->'%(Snapshot)')" SkipUnchangedFiles="true" />
    <ItemGroup>
      <Page Remove="@(Page)" />
      <ApplicationDefinition Remove="@(ApplicationDefinition)" />
      <Page Include="@(_WinUiXamlOriginalPage->'%(Snapshot)')">
        <Link>%(_WinUiXamlOriginalPage.Link)</Link>
      </Page>
      <ApplicationDefinition Include="@(_WinUiXamlOriginalApplicationDefinition->'%(Snapshot)')">
        <Link>%(_WinUiXamlOriginalApplicationDefinition.Link)</Link>
      </ApplicationDefinition>
    </ItemGroup>
  </Target>

  <!-- Invoked here rather than named on the command line: DesignTimeMarkupCompilation exists only where
       the WinUI targets are imported, and MSBuild fails the whole request with MSB4057 for a target the
       project does not define, which ContinueOnError cannot demote. XamlCompilerTaskPath decides safely. -->
  <Target Name="WinUiXamlDesignTimeMarkup"
          BeforeTargets="CoreCompile"
          Condition="'$(WinUiXamlDesignTimeRoot)' == 'true' and '$(WinUiXamlSkipMarkupCompilation)' != 'true'">
    <CallTarget Targets="DesignTimeMarkupCompilation" Condition="'$(XamlCompilerTaskPath)' != ''" />
  </Target>
</Project>
""";

        private const string FileName = "WinUiXaml.DesignTime.targets";

        private static readonly object Gate = new();
        private static string? _path;

        /// <summary>The targets file path, written on first use; null means the build runs without it.</summary>
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
                    var directory = DesignTimeBuildStorage.TargetsDirectory;
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

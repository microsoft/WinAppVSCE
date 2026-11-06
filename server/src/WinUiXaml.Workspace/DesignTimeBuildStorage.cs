using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace WinUiXaml.Workspace;

internal static class DesignTimeBuildStorage
{
    private static readonly string Root = Path.Combine(
        Path.GetTempPath(), "winui-xaml-ls", "builds", Guid.NewGuid().ToString("N"));
    internal static string TargetsDirectory => Path.Combine(Root, "targets");

    static DesignTimeBuildStorage()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Cleanup();
    }

    internal static IReadOnlyDictionary<string, string> Isolate(
        string projectPath,
        IReadOnlyDictionary<string, string> properties,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (properties.ContainsKey("WinUiXamlBuildRoot"))
        {
            return properties;
        }

        var key = MsBuildCli.ConfigurationKey(projectPath, properties);
        var directory = Path.Combine(Root, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 8));
        Directory.CreateDirectory(directory);
        var result = properties.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        result["WinUiXamlBuildRoot"] = directory + Path.DirectorySeparatorChar;
        result["IntermediateOutputPath"] = Path.Combine(directory, "root", "obj") + Path.DirectorySeparatorChar;
        result["OutputPath"] = Path.Combine(directory, "root", "bin") + Path.DirectorySeparatorChar;
        result["OutDir"] = result["OutputPath"];
        return result;
    }

    private static void Cleanup()
    {
        try
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] could not remove design-time build storage: {ex.Message}");
        }
    }
}

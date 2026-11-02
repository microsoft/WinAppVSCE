using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Xml;
using System.Xml.Linq;

namespace WinUiXaml.Workspace;

public static class WinUiProjectEligibility
{
    public const string RequiredMessage =
        "Not supported for this project. Only WinUI 3 projects are supported at this time.";

    internal static bool Evaluate(
        string projectPath, IReadOnlyDictionary<string, string> properties, CancellationToken cancellationToken)
    {
        try
        {
            using var reader = XmlReader.Create(projectPath, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
            });
            if (!HasSupportedSdk(XDocument.Load(reader).Root))
            {
                return false;
            }

            var evaluation = MsBuildCli.Evaluate(projectPath, properties, cancellationToken);
            if (!properties.ContainsKey("TargetFramework") &&
                MsBuildCli.SelectTargetFramework(evaluation.TargetFrameworks) is { } framework)
            {
                var pinned = properties.ToDictionary(p => p.Key, p => p.Value, StringComparer.OrdinalIgnoreCase);
                pinned["TargetFramework"] = framework;
                evaluation = MsBuildCli.Evaluate(projectPath, pinned, cancellationToken);
            }
            return evaluation.IsWinUiProject;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or XmlException ||
            ex is MsBuildUnavailableException { HostMissing: false })
        {
            Console.Error.WriteLine($"[winui-xaml-ls] could not confirm WinUI project '{projectPath}': {ex.Message}");
            return false;
        }
    }

    internal static bool HasSupportedSdk(XElement? project)
    {
        if (project?.Name.LocalName != "Project")
        {
            return false;
        }
        var sdks = new[] { (string?)project.Attribute("Sdk") }
            .Concat(project.Elements().Select(element => element.Name.LocalName == "Sdk"
                ? (string?)element.Attribute("Name") : (string?)element.Attribute("Sdk")))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .SelectMany(value => value!.Split(';', StringSplitOptions.RemoveEmptyEntries))
            .Select(value => value.Trim().Split('/')[0])
            .ToArray();
        return sdks.Length > 0 && sdks.All(sdk =>
            sdk.Equals("Microsoft.NET.Sdk", StringComparison.OrdinalIgnoreCase) ||
            sdk.Equals("Microsoft.NET.Sdk.WindowsDesktop", StringComparison.OrdinalIgnoreCase));
    }
}

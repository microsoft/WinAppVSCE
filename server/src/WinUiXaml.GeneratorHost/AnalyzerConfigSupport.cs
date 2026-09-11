using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace WinUiXaml.GeneratorHost;

/// <summary>An <c>/additionalfile:</c> entry, read from disk on demand.</summary>
internal sealed class PhysicalAdditionalText : AdditionalText
{
    private readonly string _path;

    public PhysicalAdditionalText(string path) => _path = path;

    public override string Path => _path;

    public override SourceText? GetText(CancellationToken cancellationToken = default)
    {
        try
        {
            return SourceText.From(File.ReadAllText(_path));
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }
}

/// <summary>A read-only view over one file's resolved analyzer config values.</summary>
internal sealed class DictionaryAnalyzerConfigOptions : AnalyzerConfigOptions
{
    public static readonly DictionaryAnalyzerConfigOptions Empty =
        new(ImmutableDictionary<string, string>.Empty);

    private readonly ImmutableDictionary<string, string> _options;

    public DictionaryAnalyzerConfigOptions(ImmutableDictionary<string, string> options) =>
        _options = options;

    public override bool TryGetValue(string key, out string value) =>
        _options.TryGetValue(key, out value!);

    public override IEnumerable<string> Keys => _options.Keys;
}

/// <summary>
/// Supplies generators with the <c>build_property.*</c> and <c>.editorconfig</c> values csc would
/// have given them.
/// </summary>
/// <remarks>
/// Roslyn's own provider is internal, so the driver defaults to an empty one. A generator that
/// reads <c>build_property.RootNamespace</c> then silently emits a differently-named namespace
/// than the real build produces -- generated members resolve, but to the wrong names, which is
/// harder to spot than them being absent.
/// </remarks>
internal sealed class ParsedAnalyzerConfigOptionsProvider : AnalyzerConfigOptionsProvider
{
    private readonly AnalyzerConfigSet _configSet;

    private ParsedAnalyzerConfigOptionsProvider(AnalyzerConfigSet configSet)
    {
        _configSet = configSet;
        GlobalOptions = new DictionaryAnalyzerConfigOptions(
            configSet.GlobalConfigOptions.AnalyzerOptions);
    }

    public static ParsedAnalyzerConfigOptionsProvider Create(AnalyzerConfigSet configSet) =>
        new(configSet);

    public override AnalyzerConfigOptions GlobalOptions { get; }

    public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) =>
        OptionsForPath(tree.FilePath);

    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) =>
        OptionsForPath(textFile.Path);

    private AnalyzerConfigOptions OptionsForPath(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return GlobalOptions;
        }

        return new DictionaryAnalyzerConfigOptions(
            _configSet.GetOptionsForSourcePath(path).AnalyzerOptions);
    }
}

internal static class AnalyzerConfigOptionsProviderFactory
{
    /// <summary>
    /// Builds a provider from the <c>/analyzerconfig:</c> files csc was given, falling back to an
    /// empty provider so a malformed config degrades to today's behaviour instead of failing the
    /// whole generator run.
    /// </summary>
    public static AnalyzerConfigOptionsProvider Create(IReadOnlyList<string> configPaths)
    {
        var configs = ImmutableArray.CreateBuilder<AnalyzerConfig>();
        foreach (var path in configPaths)
        {
            if (!File.Exists(path))
            {
                continue;
            }

            try
            {
                configs.Add(AnalyzerConfig.Parse(File.ReadAllText(path), path));
            }
            catch (Exception)
            {
                // A config we cannot parse is skipped; the rest still apply.
            }
        }

        if (configs.Count == 0)
        {
            return EmptyAnalyzerConfigOptionsProvider.Instance;
        }

        try
        {
            return ParsedAnalyzerConfigOptionsProvider.Create(
                AnalyzerConfigSet.Create(configs.ToImmutable()));
        }
        catch (Exception)
        {
            return EmptyAnalyzerConfigOptionsProvider.Instance;
        }
    }
}

internal sealed class EmptyAnalyzerConfigOptionsProvider : AnalyzerConfigOptionsProvider
{
    public static readonly EmptyAnalyzerConfigOptionsProvider Instance = new();

    public override AnalyzerConfigOptions GlobalOptions => DictionaryAnalyzerConfigOptions.Empty;

    public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) =>
        DictionaryAnalyzerConfigOptions.Empty;

    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) =>
        DictionaryAnalyzerConfigOptions.Empty;
}

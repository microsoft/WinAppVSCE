using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Surface;

/// <summary>
/// Source-only type model of the previewed project for sample data. Parses the project's <c>.cs</c> files with
/// Roslyn against the .NET base libraries only (no build, no NuGet references, nothing executed), so
/// <see cref="SamplePlanner"/> can learn the type behind an <c>{x:Bind}</c> path or a code-behind assignment.
/// Types from packages stay unresolved; callers fall back to name-based values. One cached compilation per
/// project, updated incrementally when files change. Never throws.
/// </summary>
internal sealed class SampleTypeModel
{
    private const int MaxSourceFiles = 4000;

    private static readonly ConcurrentDictionary<string, ProjectState> Projects = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Lazy<IReadOnlyList<MetadataReference>> BclReferences = new(LoadBclReferences);

    private readonly CSharpCompilation _compilation;
    private readonly Dictionary<string, INamedTypeSymbol?> _typeCache = new(StringComparer.Ordinal);

    private SampleTypeModel(CSharpCompilation compilation) => _compilation = compilation;

    internal CSharpCompilation Compilation => _compilation;

    /// <summary>A model over in-memory sources (tests).</summary>
    internal static SampleTypeModel FromSources(params string[] sources)
    {
        var trees = sources.Select(s => CSharpSyntaxTree.ParseText(s, ParseOptions)).ToList();
        trees.Add(CSharpSyntaxTree.ParseText(ImplicitUsings(Array.Empty<string>()), ParseOptions));
        return new SampleTypeModel(CreateCompilation(trees));
    }

    /// <summary>
    /// The model for the project that owns <paramref name="xamlPath"/> (nearest <c>.csproj</c> above it), waiting up
    /// to <paramref name="wait"/> for a first build or a refresh. Null when there is no project, it is too large,
    /// or it isn't ready in time (the build continues in the background for the next render).
    /// </summary>
    internal static SampleTypeModel? ForDocument(string? xamlPath, TimeSpan wait)
    {
        try
        {
            var csproj = FindProject(xamlPath);
            if (csproj is null)
            {
                return null;
            }

            var state = Projects.GetOrAdd(csproj, p => new ProjectState(p));
            var task = state.Refresh();
            if (!task.Wait(wait))
            {
                App.Log($"SAMPLE: type model for {Path.GetFileName(csproj)} not ready after {wait.TotalMilliseconds:0} ms; using name-based values.");
                return state.Last;
            }
            return task.Result;
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: type model failed: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    internal static string? FindProject(string? xamlPath)
    {
        if (string.IsNullOrEmpty(xamlPath))
        {
            return null;
        }

        for (var dir = Path.GetDirectoryName(Path.GetFullPath(xamlPath)); dir is not null; dir = Path.GetDirectoryName(dir))
        {
            var proj = Directory.EnumerateFiles(dir, "*.csproj").FirstOrDefault();
            if (proj is not null)
            {
                return proj;
            }
        }
        return null;
    }

    // ---- type queries ---------------------------------------------------------------------------------

    /// <summary>A source type by full CLR name, else by simple name when unique enough. Null when unknown.</summary>
    internal INamedTypeSymbol? FindType(string fullName)
    {
        if (_typeCache.TryGetValue(fullName, out var cached))
        {
            return cached;
        }

        INamedTypeSymbol? found = null;
        try
        {
            found = _compilation.GetTypeByMetadataName(fullName);
            if (found is null)
            {
                var simple = fullName[(fullName.LastIndexOf('.') + 1)..];
                var candidates = _compilation.GetSymbolsWithName(simple, SymbolFilter.Type).OfType<INamedTypeSymbol>().ToList();
                found = candidates.FirstOrDefault(c => c.ToDisplayString() == fullName) ??
                        (candidates.Count == 1 ? candidates[0] : null);
            }
        }
        catch
        {
            found = null;
        }

        _typeCache[fullName] = found;
        return found;
    }

    /// <summary>
    /// The type of member <paramref name="name"/> on <paramref name="type"/> (property, field, or method return),
    /// walking base types. A CommunityToolkit <c>[ObservableProperty]</c> field (<c>_name</c>/<c>m_name</c>) maps
    /// to <c>Name</c> since source generators don't run here. Null when not found.
    /// </summary>
    internal static ITypeSymbol? MemberType(ITypeSymbol type, string name)
    {
        for (var cur = type; cur is not null; cur = cur.BaseType)
        {
            foreach (var m in cur.GetMembers(name))
            {
                switch (m)
                {
                    case IPropertySymbol p: return p.Type;
                    case IFieldSymbol f: return f.Type;
                    case IMethodSymbol ms when ms.MethodKind == MethodKind.Ordinary: return ms.ReturnType;
                }
            }

            foreach (var f in cur.GetMembers().OfType<IFieldSymbol>())
            {
                var n = f.Name.TrimStart('_');
                if (n.StartsWith("m_", StringComparison.Ordinal)) n = n[2..];
                if (n.Length > 0 && f.Name != n &&
                    string.Equals(char.ToUpperInvariant(n[0]) + n[1..], name, StringComparison.Ordinal))
                {
                    return f.Type;
                }
            }
        }

        if (type is ITypeParameterSymbol or { TypeKind: TypeKind.Interface })
        {
            foreach (var i in type.AllInterfaces)
            {
                if (MemberType(i, name) is { } t) return t;
            }
        }
        return null;
    }

    /// <summary>The element type of an array or a generic collection (<c>IEnumerable&lt;T&gt;</c>); null otherwise.</summary>
    internal static ITypeSymbol? ElementType(ITypeSymbol type)
    {
        if (type is IArrayTypeSymbol arr)
        {
            return arr.ElementType;
        }

        if (type.SpecialType == SpecialType.System_String)
        {
            return null;
        }

        if (type is INamedTypeSymbol named)
        {
            var ienum = named.AllInterfaces.Append(named).FirstOrDefault(i =>
                i.OriginalDefinition.ToDisplayString() == "System.Collections.Generic.IEnumerable<T>");
            if (ienum is not null)
            {
                return ienum.TypeArguments[0];
            }

            // Unresolved collection types (e.g. a package's observable list) still carry their type argument.
            if (named.IsGenericType && named.TypeArguments.Length == 1 &&
                Regex.IsMatch(named.Name, "(Collection|List|Set|Enumerable|Array|Vector)$"))
            {
                return named.TypeArguments[0];
            }
        }
        return null;
    }

    /// <summary>
    /// Every <c>Name.Property = expression</c> assignment in the partial class <paramref name="className"/>
    /// (full CLR name), with the semantic model that types it and the name of the enclosing method.
    /// </summary>
    internal IEnumerable<(string target, string property, ExpressionSyntax value, SemanticModel model, BaseMethodDeclarationSyntax? method)>
        Assignments(string className)
    {
        var type = FindType(className);
        if (type is null)
        {
            yield break;
        }

        foreach (var tree in type.DeclaringSyntaxReferences.Select(r => r.SyntaxTree).Distinct())
        {
            var model = _compilation.GetSemanticModel(tree);
            foreach (var asg in tree.GetRoot().DescendantNodes().OfType<AssignmentExpressionSyntax>())
            {
                if (!asg.IsKind(SyntaxKind.SimpleAssignmentExpression) ||
                    asg.Left is not MemberAccessExpressionSyntax { Name.Identifier.Text: var prop } access)
                {
                    continue;
                }

                var target = access.Expression switch
                {
                    IdentifierNameSyntax id => id.Identifier.Text,
                    MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: var n } => n.Identifier.Text,
                    _ => null,
                };
                if (target is null)
                {
                    continue;
                }

                var method = asg.FirstAncestorOrSelf<BaseMethodDeclarationSyntax>();
                yield return (target, prop, asg.Right, model, method);
            }
        }
    }

    // ---- compilation --------------------------------------------------------------------------------------

    private static readonly CSharpParseOptions ParseOptions = new(LanguageVersion.Preview);

    private static CSharpCompilation CreateCompilation(IEnumerable<SyntaxTree> trees) =>
        CSharpCompilation.Create("WinUISurfaceSampleModel", trees, BclReferences.Value,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));

    private static IReadOnlyList<MetadataReference> LoadBclReferences()
    {
        var dir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var refs = new List<MetadataReference>();
        if (dir is null)
        {
            return refs;
        }

        foreach (var file in Directory.EnumerateFiles(dir, "*.dll"))
        {
            var name = Path.GetFileName(file);
            if (!(name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) ||
                  name.Equals("netstandard.dll", StringComparison.OrdinalIgnoreCase) ||
                  name.Equals("mscorlib.dll", StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            try
            {
                refs.Add(MetadataReference.CreateFromFile(file));
            }
            catch
            {
                // native or unreadable image: skip
            }
        }
        return refs;
    }

    /// <summary>The SDK's implicit global usings plus the project's own <c>&lt;Using Include&gt;</c> items.</summary>
    private static string ImplicitUsings(IEnumerable<string> extra)
    {
        var namespaces = new List<string>
        {
            "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http",
            "System.Threading", "System.Threading.Tasks",
        };
        namespaces.AddRange(extra);
        return string.Concat(namespaces.Distinct().Select(n => $"global using {n};\n"));
    }

    private static IEnumerable<string> ProjectUsings(string csproj)
    {
        try
        {
            var text = File.ReadAllText(csproj);
            return Regex.Matches(text, @"<Using\s+Include\s*=\s*""([\w.]+)""\s*/?>")
                .Select(m => m.Groups[1].Value)
                .ToList();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>The cached compilation for one project; refreshed by re-parsing only files whose timestamp changed.</summary>
    private sealed class ProjectState
    {
        private readonly string _csproj;
        private readonly string _dir;
        private readonly object _gate = new();
        private readonly Dictionary<string, (DateTime stamp, SyntaxTree tree)> _files = new(StringComparer.OrdinalIgnoreCase);
        private SyntaxTree? _usingsTree;
        private CSharpCompilation? _compilation;
        private Task<SampleTypeModel?>? _pending;

        public ProjectState(string csproj)
        {
            _csproj = csproj;
            _dir = Path.GetDirectoryName(csproj)!;
        }

        public SampleTypeModel? Last { get; private set; }

        public Task<SampleTypeModel?> Refresh()
        {
            lock (_gate)
            {
                if (_pending is { IsCompleted: false })
                {
                    return _pending;
                }
                return _pending = Task.Run(Update);
            }
        }

        private SampleTypeModel? Update()
        {
            try
            {
                var sw = Stopwatch.StartNew();
                var files = Directory.EnumerateFiles(_dir, "*.cs", SearchOption.AllDirectories)
                    .Where(f => !IsBuildOutput(f))
                    .Take(MaxSourceFiles + 1)
                    .ToList();
                if (files.Count > MaxSourceFiles)
                {
                    App.Log($"SAMPLE: {Path.GetFileName(_csproj)} has more than {MaxSourceFiles} source files; skipping the type model.");
                    return null;
                }

                var compilation = _compilation;
                if (compilation is null)
                {
                    _usingsTree = CSharpSyntaxTree.ParseText(ImplicitUsings(ProjectUsings(_csproj)), ParseOptions);
                    compilation = CreateCompilation(new[] { _usingsTree });
                }

                int changed = 0;
                var present = new HashSet<string>(files, StringComparer.OrdinalIgnoreCase);
                foreach (var gone in _files.Keys.Where(k => !present.Contains(k)).ToList())
                {
                    compilation = compilation.RemoveSyntaxTrees(_files[gone].tree);
                    _files.Remove(gone);
                    changed++;
                }

                foreach (var file in files)
                {
                    var stamp = File.GetLastWriteTimeUtc(file);
                    if (_files.TryGetValue(file, out var known) && known.stamp == stamp)
                    {
                        continue;
                    }

                    SyntaxTree tree;
                    try
                    {
                        tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file), ParseOptions, path: file);
                    }
                    catch (IOException)
                    {
                        continue; // being written; picked up next time
                    }

                    compilation = known.tree is null ? compilation.AddSyntaxTrees(tree) : compilation.ReplaceSyntaxTree(known.tree, tree);
                    _files[file] = (stamp, tree);
                    changed++;
                }

                if (changed == 0 && Last is not null)
                {
                    return Last;
                }

                _compilation = compilation;
                Last = new SampleTypeModel(compilation);
                App.Log($"SAMPLE: type model for {Path.GetFileName(_csproj)}: {_files.Count} file(s), {changed} updated, {sw.ElapsedMilliseconds} ms.");
                return Last;
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: type model update failed: {ex.GetType().Name}: {ex.Message}");
                return Last;
            }
        }

        private bool IsBuildOutput(string file)
        {
            var rel = Path.GetRelativePath(_dir, file);
            var first = rel.Split(Path.DirectorySeparatorChar, 2)[0];
            return first.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
                   first.Equals("obj", StringComparison.OrdinalIgnoreCase) ||
                   first.StartsWith(".", StringComparison.Ordinal);
        }
    }
}

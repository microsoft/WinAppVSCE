using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Markup;

namespace Surface;

/// <summary>
/// Design-time data support (S4 §51, feature Milestone 1). Honors the Blend design namespace's
/// <c>d:DataContext</c> so a classic <c>{Binding}</c> page renders real sample data in the preview —
/// the same capability Blend/Visual Studio give a WPF/WinUI designer.
///
/// <para>Two forms are recognised, both as the value of a root <c>d:DataContext</c> attribute:</para>
/// <list type="bullet">
///   <item><c>{d:DesignInstance Type=vm:Foo, IsDesignTimeCreatable=True, CreateList=True}</c> — the
///     referenced type is resolved from the loaded user assemblies and constructed (reflection). With
///     <c>CreateList=True</c> a small collection of instances is produced (for an ItemsControl preview).</item>
///   <item><c>{d:DesignData Source=Sample.xaml}</c> — the referenced sample-data document is loaded via
///     <see cref="XamlReader.Load"/> and used as the DataContext.</item>
/// </list>
///
/// <para>The constructed/loaded object is assigned as the parsed root's <see cref="FrameworkElement.DataContext"/>
/// AFTER the runtime parse, so every classic <c>{Binding}</c> in the tree resolves against it. The
/// <see cref="XamlCleaner"/> already strips the <c>d:</c> constructs from the markup that actually renders
/// (Rule 5), so this class only READS the raw document to recover the design intent the cleaner discards.</para>
///
/// <para>It is deliberately DEFENSIVE — every entry point swallows its own failures and simply leaves the
/// DataContext unset, so a malformed or unresolvable design-time hint can never fail a render that would
/// otherwise succeed.</para>
/// </summary>
internal static class DesignTimeData
{
    private static readonly XNamespace Design = "http://schemas.microsoft.com/expression/blend/2008";

    /// <summary>How many instances a <c>CreateList=True</c> design collection is seeded with.</summary>
    private const int DesignListCount = 3;

    internal enum SpecKind
    {
        DesignInstance,
        DesignData,
    }

    /// <summary>Parsed intent of a root <c>d:DataContext</c> markup extension.</summary>
    internal sealed class Spec
    {
        public SpecKind Kind;
        public string? TypeFullName;          // DesignInstance: resolved CLR full name
        public bool IsDesignTimeCreatable;
        public bool CreateList;
        public string? Source;                // DesignData: sample-file path/URI
        public string? Raw;                   // original extension text (for logging)
    }

    /// <summary>
    /// Extract the root element's <c>d:DataContext</c> design intent from the RAW project markup (before
    /// <see cref="XamlCleaner"/> strips it). Returns null when there is no design DataContext or it cannot
    /// be understood. Never throws.
    /// </summary>
    internal static Spec? ExtractRootSpec(string? rawXaml)
    {
        if (string.IsNullOrWhiteSpace(rawXaml))
        {
            return null;
        }

        try
        {
            var root = XDocument.Parse(rawXaml).Root;
            var attr = root?.Attribute(Design + "DataContext");
            if (attr is null)
            {
                return null;
            }

            return ParseExtension(root!, attr.Value);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Construct/load the sample described by <paramref name="spec"/> and assign it as
    /// <paramref name="fe"/>'s DataContext so classic <c>{Binding}</c> in the tree resolves. Never throws.
    /// </summary>
    /// <param name="baseDir">Directory used to resolve a relative <c>d:DesignData</c> Source (typically the
    /// user assembly's folder). May be null.</param>
    internal static void Apply(FrameworkElement fe, Spec spec, string? baseDir)
    {
        try
        {
            object? context = spec.Kind switch
            {
                SpecKind.DesignInstance => BuildDesignInstance(spec),
                SpecKind.DesignData => LoadDesignData(spec, baseDir),
                _ => null,
            };

            if (context is null)
            {
                App.Log($"DTD: no design-time DataContext produced ({spec.Kind} {spec.TypeFullName ?? spec.Source}).");
                return;
            }

            fe.DataContext = context;
            App.Log($"DTD: set design-time DataContext ({spec.Kind}) = {context.GetType().FullName}.");
        }
        catch (Exception ex)
        {
            App.Log($"DTD: apply failed for {spec.Kind} '{spec.TypeFullName ?? spec.Source}': {ex.GetType().Name}: {ex.Message}");
        }
    }

    // ------------------------------------------------------------------ parsing

    private static Spec? ParseExtension(XElement root, string? raw)
    {
        var text = raw?.Trim();
        if (string.IsNullOrEmpty(text) || text!.Length < 2 || text[0] != '{' || text[^1] != '}')
        {
            return null;
        }

        var inner = text.Substring(1, text.Length - 2).Trim();
        int sp = IndexOfWhitespace(inner);
        var name = (sp < 0 ? inner : inner.Substring(0, sp)).Trim();
        var argStr = sp < 0 ? string.Empty : inner.Substring(sp + 1).Trim();

        int colon = name.IndexOf(':');
        var local = colon >= 0 ? name.Substring(colon + 1) : name;

        var (positional, named) = ParseArgs(argStr);

        if (string.Equals(local, "DesignInstance", StringComparison.Ordinal))
        {
            var typeToken = named.TryGetValue("Type", out var t) ? t : positional;
            if (string.IsNullOrWhiteSpace(typeToken))
            {
                return null;
            }

            var full = ResolveTypeToken(root, typeToken!.Trim());
            if (full is null)
            {
                return null;
            }

            return new Spec
            {
                Kind = SpecKind.DesignInstance,
                TypeFullName = full,
                IsDesignTimeCreatable = named.TryGetValue("IsDesignTimeCreatable", out var c) && ParseBool(c),
                CreateList = named.TryGetValue("CreateList", out var l) && ParseBool(l),
                Raw = text,
            };
        }

        if (string.Equals(local, "DesignData", StringComparison.Ordinal))
        {
            var src = named.TryGetValue("Source", out var s) ? s : positional;
            if (string.IsNullOrWhiteSpace(src))
            {
                return null;
            }

            return new Spec { Kind = SpecKind.DesignData, Source = src!.Trim(), Raw = text };
        }

        return null;
    }

    /// <summary>Split a markup-extension argument list into an optional leading positional value and the
    /// <c>Key=Value</c> named arguments, respecting nested <c>{…}</c> and single-quoted values.</summary>
    private static (string? positional, Dictionary<string, string> named) ParseArgs(string argStr)
    {
        var named = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? positional = null;

        foreach (var part in SplitTopLevel(argStr, ','))
        {
            int eq = FindTopLevel(part, '=');
            if (eq < 0)
            {
                positional ??= part.Trim();
            }
            else
            {
                var key = part.Substring(0, eq).Trim();
                var value = part.Substring(eq + 1).Trim().Trim('\'');
                if (key.Length > 0)
                {
                    named[key] = value;
                }
            }
        }

        return (positional, named);
    }

    private static IEnumerable<string> SplitTopLevel(string s, char sep)
    {
        if (string.IsNullOrWhiteSpace(s))
        {
            yield break;
        }

        int depth = 0;
        bool quoted = false;
        int start = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char ch = s[i];
            if (ch == '\'')
            {
                quoted = !quoted;
            }
            else if (!quoted && ch == '{')
            {
                depth++;
            }
            else if (!quoted && ch == '}')
            {
                depth--;
            }
            else if (!quoted && depth == 0 && ch == sep)
            {
                var piece = s.Substring(start, i - start).Trim();
                if (piece.Length > 0)
                {
                    yield return piece;
                }

                start = i + 1;
            }
        }

        var last = s.Substring(start).Trim();
        if (last.Length > 0)
        {
            yield return last;
        }
    }

    private static int FindTopLevel(string s, char target)
    {
        int depth = 0;
        bool quoted = false;
        for (int i = 0; i < s.Length; i++)
        {
            char ch = s[i];
            if (ch == '\'')
            {
                quoted = !quoted;
            }
            else if (!quoted && ch == '{')
            {
                depth++;
            }
            else if (!quoted && ch == '}')
            {
                depth--;
            }
            else if (!quoted && depth == 0 && ch == target)
            {
                return i;
            }
        }

        return -1;
    }

    private static int IndexOfWhitespace(string s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            if (char.IsWhiteSpace(s[i]))
            {
                return i;
            }
        }

        return -1;
    }

    private static bool ParseBool(string? v) =>
        v != null && (v.Trim() is "True" or "true" or "1");

    /// <summary>Resolve a <c>prefix:TypeName</c> token to a CLR full name using the root's xmlns table.</summary>
    private static string? ResolveTypeToken(XElement root, string typeToken)
    {
        int colon = typeToken.IndexOf(':');
        var prefix = colon >= 0 ? typeToken.Substring(0, colon) : string.Empty;
        var local = colon >= 0 ? typeToken.Substring(colon + 1) : typeToken;

        XNamespace? ns = prefix.Length > 0 ? root.GetNamespaceOfPrefix(prefix) : root.GetDefaultNamespace();
        if (ns is null || string.IsNullOrEmpty(ns.NamespaceName))
        {
            return null;
        }

        var clrNs = ClrNamespaceFrom(ns.NamespaceName);
        if (clrNs is null)
        {
            return null;
        }

        return clrNs.Length == 0 ? local : clrNs + "." + local;
    }

    /// <summary>Project a WinUI <c>using:</c> or legacy <c>clr-namespace:</c> xmlns onto its CLR namespace.
    /// Framework/presentation namespaces return null (a DesignInstance of a framework type is not supported).</summary>
    private static string? ClrNamespaceFrom(string xmlns)
    {
        const string usingPrefix = "using:";
        const string clrPrefix = "clr-namespace:";

        if (xmlns.StartsWith(usingPrefix, StringComparison.Ordinal))
        {
            return xmlns.Substring(usingPrefix.Length).Trim();
        }

        if (xmlns.StartsWith(clrPrefix, StringComparison.Ordinal))
        {
            var body = xmlns.Substring(clrPrefix.Length);
            int semi = body.IndexOf(';');
            return (semi >= 0 ? body.Substring(0, semi) : body).Trim();
        }

        return null;
    }

    // ------------------------------------------------------------------ construction

    private static object? BuildDesignInstance(Spec spec)
    {
        var type = ResolveType(spec.TypeFullName!);
        if (type is null)
        {
            App.Log($"DTD: DesignInstance type '{spec.TypeFullName}' not found in loaded assemblies.");
            return null;
        }

        if (spec.CreateList)
        {
            var list = new ObservableCollection<object>();
            for (int i = 0; i < DesignListCount; i++)
            {
                var item = TryConstruct(type);
                if (item != null)
                {
                    list.Add(item);
                }
            }

            return list.Count > 0 ? list : null;
        }

        // IsDesignTimeCreatable=False is Blend's "generate a dummy" hint; we best-effort construct the real
        // type when it has a usable constructor (a VM that self-populates sample data is the common case).
        // Richer reflective fabrication for non-creatable types is the opportunistic fallback (Milestone 3).
        return TryConstruct(type);
    }

    private static object? LoadDesignData(Spec spec, string? baseDir)
    {
        var path = ResolveSourcePath(spec.Source!, baseDir);
        if (path is null)
        {
            App.Log($"DTD: DesignData source '{spec.Source}' could not be located (baseDir '{baseDir}').");
            return null;
        }

        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (Exception ex)
        {
            App.Log($"DTD: DesignData read failed '{path}': {ex.GetType().Name}: {ex.Message}");
            return null;
        }

        try
        {
            return XamlReader.Load(PrepareForXamlReader(text));
        }
        catch (Exception ex)
        {
            App.Log($"DTD: DesignData parse failed '{path}': {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// <see cref="XamlReader.Load"/> rejects a leading XML declaration (<c>&lt;?xml ...?&gt;</c>) and a UTF-8
    /// BOM, both of which real Blend/Expression sample-data files commonly carry. Strip them so those files
    /// load. Standard XML comments are tolerated by XamlReader and left in place.
    /// </summary>
    private static string PrepareForXamlReader(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text;
        }

        if (text[0] == '\uFEFF')
        {
            text = text.Substring(1);
        }

        text = text.TrimStart();
        if (text.StartsWith("<?xml", StringComparison.OrdinalIgnoreCase))
        {
            int end = text.IndexOf("?>", StringComparison.Ordinal);
            if (end >= 0)
            {
                text = text.Substring(end + 2).TrimStart();
            }
        }

        return text;
    }

    private static string? ResolveSourcePath(string source, string? baseDir)
    {
        var s = source.Trim();
        if (s.Length == 0)
        {
            return null;
        }

        // A Blend leading '/' means project-root-relative; treat it as relative to baseDir.
        var trimmed = s.TrimStart('/', '\\');

        var candidates = new List<string>();
        if (Path.IsPathRooted(s))
        {
            candidates.Add(s);
        }

        if (!string.IsNullOrEmpty(baseDir))
        {
            candidates.Add(Path.Combine(baseDir, trimmed));
        }

        try
        {
            candidates.Add(Path.Combine(AppContext.BaseDirectory, trimmed));
        }
        catch
        {
            // ignore
        }

        return candidates.FirstOrDefault(File.Exists);
    }

    private static object? TryConstruct(Type type)
    {
        try
        {
            return Activator.CreateInstance(type);
        }
        catch (Exception ex)
        {
            App.Log($"DTD: constructing '{type.FullName}' failed: {ex.GetType().Name}: {(ex.InnerException ?? ex).Message}");
            return null;
        }
    }

    /// <summary>Resolve a CLR type by full name across the loaded assemblies (user assembly + its closure).</summary>
    private static Type? ResolveType(string fullName)
    {
        var t = Type.GetType(fullName, throwOnError: false);
        if (t != null)
        {
            return t;
        }

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                t = asm.GetType(fullName, throwOnError: false, ignoreCase: false);
            }
            catch
            {
                t = null;
            }

            if (t != null)
            {
                return t;
            }
        }

        return null;
    }
}

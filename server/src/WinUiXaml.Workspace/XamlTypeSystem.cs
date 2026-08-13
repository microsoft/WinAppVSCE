using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Xml;
using Microsoft.CodeAnalysis;

namespace WinUiXaml.Workspace
{
    /// <summary>Resolves XAML namespaces, types, and members to Roslyn symbols.</summary>
    public sealed class XamlTypeSystem
    {
        /// <summary>The WinUI/WPF-style default presentation namespace.</summary>
        public const string PresentationNamespace =
            "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

        /// <summary>The XAML language namespace (<c>x:</c> — x:Class, x:Name, x:Bind, ...).</summary>
        public const string XamlLanguageNamespace =
            "http://schemas.microsoft.com/winfx/2006/xaml";

        private const string UsingScheme = "using:";
        private const string ClrNamespaceScheme = "clr-namespace:";

        // WinUI maps the presentation namespace to these CLR roots by convention.
        private static readonly string[] PresentationRoots = { "Microsoft.UI.Xaml", "Windows.UI.Xaml" };

        private readonly Compilation _compilation;
        private readonly ImmutableArray<IAssemblySymbol> _assemblies;

        // Walking the reference closure is expensive, so cache it per instance.
        private IReadOnlyList<string>? _referencedUsingNamespaces;

        private IReadOnlyList<string>? _namedColors;

        private IReadOnlyList<string>? _fontWeights;

        private IReadOnlyList<ThemeResourceInfo>? _themeResources;

        // Cache referenced controls because walking the reference closure is expensive.
        private IReadOnlyList<INamedTypeSymbol>? _referencedElementTypes;

        private readonly Dictionary<string, List<NamespaceBinding>> _xmlnsMap;
        private readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, string>> _documentationFiles =
            new(StringComparer.OrdinalIgnoreCase);

        // XAML intrinsic types are language-defined rather than namespace bindings.
        private static readonly Dictionary<string, string> XamlIntrinsicTypes = new(StringComparer.Ordinal)
        {
            ["Object"] = "System.Object",
            ["Boolean"] = "System.Boolean",
            ["Byte"] = "System.Byte",
            ["Char"] = "System.Char",
            ["Decimal"] = "System.Decimal",
            ["Single"] = "System.Single",
            ["Double"] = "System.Double",
            ["Int16"] = "System.Int16",
            ["Int32"] = "System.Int32",
            ["Int64"] = "System.Int64",
            ["String"] = "System.String",
            ["TimeSpan"] = "System.TimeSpan",
            ["Uri"] = "System.Uri",
            ["Type"] = "System.Type",
        };

        private XamlTypeSystem(
            Compilation compilation,
            ImmutableArray<IAssemblySymbol> assemblies,
            Dictionary<string, List<NamespaceBinding>> xmlnsMap)
        {
            _compilation = compilation;
            _assemblies = assemblies;
            _xmlnsMap = xmlnsMap;
        }

        /// <summary>Builds a type system from a resolved XAML file's project context.</summary>
        public static XamlTypeSystem FromResolution(XamlResolution resolution)
        {
            if (resolution is null)
            {
                throw new ArgumentNullException(nameof(resolution));
            }

            return FromCompilation(resolution.Compilation, resolution.ReferencedAssemblies);
        }

        /// <summary>Builds a type system, including the compilation's own assembly.</summary>
        public static XamlTypeSystem FromCompilation(
            Compilation compilation, ImmutableArray<IAssemblySymbol> referencedAssemblies)
        {
            if (compilation is null)
            {
                throw new ArgumentNullException(nameof(compilation));
            }

            var builder = ImmutableArray.CreateBuilder<IAssemblySymbol>();
            builder.Add(compilation.Assembly);
            if (!referencedAssemblies.IsDefault)
            {
                builder.AddRange(referencedAssemblies);
            }

            var assemblies = builder.ToImmutable();

            var xmlnsMap = BuildXmlnsMap(assemblies);
            AddConventionNamespaces(xmlnsMap, assemblies);
            return new XamlTypeSystem(compilation, assemblies, xmlnsMap);
        }

        /// <summary>Resolves an element or attached-property owner to its type.</summary>
        public INamedTypeSymbol? ResolveType(string xmlnsUri, string localName)
        {
            if (string.IsNullOrEmpty(localName))
            {
                return null;
            }

            if (string.Equals(xmlnsUri, XamlLanguageNamespace, StringComparison.Ordinal) &&
                XamlIntrinsicTypes.TryGetValue(localName, out var intrinsicMetadataName))
            {
                return _compilation.GetTypeByMetadataName(intrinsicMetadataName);
            }

            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                var type = FindType(binding, localName);
                if (type is not null)
                {
                    return type;
                }
            }

            return null;
        }

        /// <summary>Resolves a fully qualified metadata type name.</summary>
        public INamedTypeSymbol? ResolveMetadataType(string metadataName) =>
            string.IsNullOrEmpty(metadataName) ? null : _compilation.GetTypeByMetadataName(metadataName);

        /// <summary>Gets symbol documentation from Roslyn, then from XML files beside the active compilation reference.</summary>
        public string GetDocumentationCommentXml(ISymbol symbol)
        {
            var direct = symbol.GetDocumentationCommentXml();
            if (!string.IsNullOrWhiteSpace(direct) || symbol.GetDocumentationCommentId() is not { } id)
            {
                return direct ?? string.Empty;
            }

            foreach (var reference in _compilation.References.OfType<PortableExecutableReference>())
            {
                if (string.IsNullOrEmpty(reference.FilePath) ||
                    _compilation.GetAssemblyOrModuleSymbol(reference) is not IAssemblySymbol assembly ||
                    !SymbolEqualityComparer.Default.Equals(assembly, symbol.ContainingAssembly))
                {
                    continue;
                }

                foreach (var candidate in DocumentationCandidates(reference.FilePath))
                {
                    if (!File.Exists(candidate))
                    {
                        continue;
                    }

                    IReadOnlyDictionary<string, string> documentation;
                    try
                    {
                        documentation = _documentationFiles.GetOrAdd(candidate, ReadDocumentationFile);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or XmlException)
                    {
                        continue;
                    }

                    if (documentation.TryGetValue(id, out var xml))
                    {
                        return xml;
                    }
                }
            }

            return string.Empty;
        }

        private static IReadOnlyDictionary<string, string> ReadDocumentationFile(string path)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            using var reader = XmlReader.Create(path, settings);
            while (!reader.EOF)
            {
                if (reader.NodeType != XmlNodeType.Element ||
                    reader.LocalName != "member" ||
                    reader.GetAttribute("name") is not { Length: > 0 } id)
                {
                    reader.Read();
                    continue;
                }

                var element = new XmlDocument { XmlResolver = null };
                element.LoadXml(reader.ReadOuterXml());
                result[id] = element.DocumentElement?.OuterXml ?? string.Empty;
            }
            return result;
        }

        private static IEnumerable<string> DocumentationCandidates(string assemblyPath)
        {
            yield return Path.ChangeExtension(assemblyPath, ".xml");

            var directory = Path.GetDirectoryName(assemblyPath);
            if (directory is null || !TryFindPackageRoot(directory, out var packageRoot))
            {
                yield break;
            }

            var name = Path.GetFileNameWithoutExtension(assemblyPath);
            if (string.Equals(name, "Microsoft.WinUI", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "Microsoft.UI.Xaml", StringComparison.OrdinalIgnoreCase))
            {
                yield return Path.Combine(packageRoot, "metadata", "Microsoft.UI.Xaml.xml");
            }
        }

        /// <summary>Finds source namespaces declaring an instantiable type with the given name.</summary>
        public IReadOnlyList<string> FindNamespacesForTypeName(string simpleName)
        {
            if (string.IsNullOrEmpty(simpleName))
            {
                return System.Array.Empty<string>();
            }

            return _compilation
                .GetSymbolsWithName(simpleName, SymbolFilter.Type)
                .OfType<INamedTypeSymbol>()
                .Where(t => t.TypeKind == TypeKind.Class && !t.IsStatic &&
                    t.ContainingNamespace is { IsGlobalNamespace: false })
                .Select(t => t.ContainingNamespace.ToDisplayString())
                .Where(ns => !string.IsNullOrEmpty(ns))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(ns => ns, StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>The distinct CLR namespaces of the project's own SOURCE types that are usable as XAML elements — the candidate targets when completing a using</summary>
        public IReadOnlyList<string> GetUsingNamespaces()
        {
            var result = new SortedSet<string>(StringComparer.Ordinal);
            CollectUsableNamespaces(_compilation.Assembly.GlobalNamespace, result);
            return result.ToList();
        }

        /// <summary>The distinct CLR namespaces from REFERENCED assemblies (framework + libraries) usable as XAML elements via a using: xmlns</summary>
        public IReadOnlyList<string> GetReferencedUsingNamespaces()
        {
            if (_referencedUsingNamespaces is not null)
            {
                return _referencedUsingNamespaces;
            }

            var all = new SortedSet<string>(StringComparer.Ordinal);
            CollectUsableNamespaces(_compilation.GlobalNamespace, all);
            all.ExceptWith(GetUsingNamespaces());

            return _referencedUsingNamespaces = all.ToList();
        }

        /// <summary>The third-party element types available for completion — public classes assignable to Microsoft.UI.Xaml.DependencyObject from REFERENCED assemblies (NuGet packages</summary>
        public IReadOnlyList<INamedTypeSymbol> GetReferencedElementTypes()
        {
            if (_referencedElementTypes is not null)
            {
                return _referencedElementTypes;
            }

            var dependencyObject = _compilation.GetTypeByMetadataName("Microsoft.UI.Xaml.DependencyObject");
            if (dependencyObject is null)
            {
                return _referencedElementTypes = System.Array.Empty<INamedTypeSymbol>();
            }

            var result = new List<INamedTypeSymbol>();
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var namespaceName in GetReferencedUsingNamespaces())
            {
                var ns = ResolveNamespace(_compilation.GlobalNamespace, namespaceName);
                if (ns is null)
                {
                    continue;
                }

                foreach (var type in ns.GetTypeMembers())
                {
                    if (IsPublicClass(type) &&
                        !SymbolEqualityComparer.Default.Equals(type.ContainingAssembly, _compilation.Assembly) &&
                        IsAssignableTo(type, dependencyObject) &&
                        seen.Add(type))
                    {
                        result.Add(type);
                    }
                }
            }

            return _referencedElementTypes = result;
        }

        /// <summary>The distinct CLR namespaces reachable through an xmlns URI (using:, clr-namespace:, or a registered XmlnsDefinitionAttribute).</summary>
        public IEnumerable<string> ClrNamespacesForUri(string xmlnsUri)
        {
            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                yield return binding.ClrNamespace;
            }
        }

        /// <summary>The WinUI named colors — the static public property names of Microsoft.UI.Colors (AliceBlue, CornflowerBlue, …, Transparent — 141 in the current SDK)</summary>
        public IReadOnlyList<string> GetNamedColors()
        {
            if (_namedColors is not null)
            {
                return _namedColors;
            }

            var colors = _compilation.GetTypeByMetadataName("Microsoft.UI.Colors");
            if (colors is null)
            {
                return _namedColors = System.Array.Empty<string>();
            }

            var names = colors.GetMembers()
                .OfType<IPropertySymbol>()
                .Where(p => p.IsStatic && p.DeclaredAccessibility == Accessibility.Public)
                .Select(p => p.Name)
                .ToList();

            return _namedColors = names;
        }

        /// <summary>The WinUI named font weights — the static public property names of Microsoft.UI.Text.FontWeights (Thin, ExtraLight, Light, SemiLight, Normal, Medium, SemiBold, Bold, ExtraBold</summary>
        public IReadOnlyList<string> GetFontWeights()
        {
            if (_fontWeights is not null)
            {
                return _fontWeights;
            }

            var weights = _compilation.GetTypeByMetadataName("Microsoft.UI.Text.FontWeights");
            if (weights is null)
            {
                return _fontWeights = System.Array.Empty<string>();
            }

            var names = weights.GetMembers()
                .OfType<IPropertySymbol>()
                .Where(p => p.IsStatic && p.DeclaredAccessibility == Accessibility.Public)
                .Select(p => p.Name)
                .ToList();

            return _fontWeights = names;
        }

        /// <summary>Gets framework theme resources from the WinUI package referenced by this compilation.</summary>
        public IReadOnlyList<ThemeResourceInfo> GetThemeResources()
        {
            if (_themeResources is not null)
            {
                return _themeResources;
            }

            foreach (var path in GetThemeResourceCandidates())
            {
                if (!File.Exists(path))
                {
                    continue;
                }

                try
                {
                    return _themeResources = ParseThemeResources(path);
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
                catch (XmlException)
                {
                }
            }

            return _themeResources = System.Array.Empty<ThemeResourceInfo>();
        }

        private IEnumerable<string> GetThemeResourceCandidates()
        {
            var managed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var native = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var reference in _compilation.References.OfType<PortableExecutableReference>())
            {
                if (string.IsNullOrEmpty(reference.FilePath))
                {
                    continue;
                }

                var referencePath = Path.GetFullPath(reference.FilePath);
                var directory = Path.GetDirectoryName(referencePath);
                var fileName = Path.GetFileName(referencePath);
                var isManagedWinUi = string.Equals(
                    fileName, "Microsoft.WinUI.dll", StringComparison.OrdinalIgnoreCase);
                var isNativeWinUi = string.Equals(
                    fileName, "Microsoft.UI.Xaml.winmd", StringComparison.OrdinalIgnoreCase);
                if ((!isManagedWinUi && !isNativeWinUi) ||
                    directory is null ||
                    !TryFindPackageRoot(directory, out var packageRoot))
                {
                    continue;
                }

                if (isManagedWinUi)
                {
                    managed.Add(Path.Combine(directory, "Microsoft.WinUI", "Themes", "generic.xaml"));
                }

                native.Add(Path.Combine(packageRoot, "lib", "native", "Microsoft.UI", "Themes", "generic.xaml"));
            }

            return managed.Concat(native);
        }

        private static bool TryFindPackageRoot(string directory, out string packageRoot)
        {
            for (var current = new DirectoryInfo(directory); current is not null; current = current.Parent)
            {
                if (string.Equals(current.Name, "lib", StringComparison.OrdinalIgnoreCase) &&
                    current.Parent is not null)
                {
                    packageRoot = current.Parent.FullName;
                    return true;
                }
            }

            packageRoot = string.Empty;
            return false;
        }

        private static IReadOnlyList<ThemeResourceInfo> ParseThemeResources(string path)
        {
            const string xamlLanguageNamespace = "http://schemas.microsoft.com/winfx/2006/xaml";
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
            };
            var resources = new Dictionary<string, ThemeResourceInfo>(StringComparer.Ordinal);

            using var reader = XmlReader.Create(path, settings);
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element)
                {
                    continue;
                }

                var key = reader.GetAttribute("Key", xamlLanguageNamespace);
                if (!string.IsNullOrEmpty(key) && !resources.ContainsKey(key))
                {
                    resources.Add(key, new ThemeResourceInfo(key, reader.NamespaceURI, reader.LocalName));
                }
            }

            return resources.Values.OrderBy(resource => resource.Key, StringComparer.Ordinal).ToList();
        }

        private static void CollectUsableNamespaces(INamespaceSymbol ns, SortedSet<string> into)
        {
            if (!ns.IsGlobalNamespace &&
                ns.GetTypeMembers().Any(t =>
                    t.TypeKind == TypeKind.Class && !t.IsStatic &&
                    t.DeclaredAccessibility == Accessibility.Public))
            {
                into.Add(ns.ToDisplayString());
            }

            foreach (var child in ns.GetNamespaceMembers())
            {
                CollectUsableNamespaces(child, into);
            }
        }

        /// <summary> Enumerates the public, instantiable types available under an xmlns URI. This is the raw candidate set for element-name completion.</summary>
        public IEnumerable<INamedTypeSymbol> GetTypes(string xmlnsUri)
        {
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                var ns = ResolveNamespace(binding.Assembly.GlobalNamespace, binding.ClrNamespace);
                if (ns is null)
                {
                    continue;
                }

                foreach (var type in ns.GetTypeMembers())
                {
                    if (IsPublicClass(type) && seen.Add(type))
                    {
                        yield return type;
                    }
                }
            }
        }

        /// <summary>Enumerates every public type available under an xmlns URI — classes (including static classes), structs, enums, interfaces, and delegates.</summary>
        public IEnumerable<INamedTypeSymbol> GetAllTypes(string xmlnsUri)
        {
            var seen = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (var binding in NamespacesFor(xmlnsUri))
            {
                var ns = ResolveNamespace(binding.Assembly.GlobalNamespace, binding.ClrNamespace);
                if (ns is null)
                {
                    continue;
                }

                foreach (var type in ns.GetTypeMembers())
                {
                    if (IsPublicType(type) && seen.Add(type))
                    {
                        yield return type;
                    }
                }
            }
        }

        /// <summary>The XAML language intrinsic type aliases.</summary>
        public IEnumerable<KeyValuePair<string, INamedTypeSymbol>> GetXamlIntrinsicTypes(bool allTypeKinds)
        {
            foreach (var pair in XamlIntrinsicTypes)
            {
                if (_compilation.GetTypeByMetadataName(pair.Value) is { } symbol &&
                    (allTypeKinds ? IsPublicType(symbol) : IsPublicClass(symbol)))
                {
                    yield return new KeyValuePair<string, INamedTypeSymbol>(pair.Key, symbol);
                }
            }
        }

        /// <summary>True when the xmlns URI is understood by this type system — it maps to at least one CLR namespace that actually contains usable types.</summary>
        public bool IsKnownNamespace(string xmlnsUri) => GetTypes(xmlnsUri).Any();

        /// <summary>Enumerates the members usable as XAML attributes on type: public settable properties and public events, walking base types (most-derived wins on name collisions).</summary>
        public IEnumerable<XamlMemberInfo> GetMembers(INamedTypeSymbol type)
        {
            if (type is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers())
                {
                    if (member.DeclaredAccessibility != Accessibility.Public || member.IsStatic)
                    {
                        continue;
                    }

                    switch (member)
                    {
                        case IPropertySymbol { SetMethod: { DeclaredAccessibility: Accessibility.Public } } p
                            when !p.IsIndexer && seen.Add(p.Name):
                            yield return new XamlMemberInfo(p.Name, XamlMemberKind.Property, p, p.Type, t);
                            break;

                        case IEventSymbol e when seen.Add(e.Name):
                            yield return new XamlMemberInfo(e.Name, XamlMemberKind.Event, e, e.Type, t);
                            break;
                    }
                }
            }
        }

        /// <summary>Finds a single attribute member by name on a type (settable property or event).</summary>
        public XamlMemberInfo? FindMember(INamedTypeSymbol type, string memberName) =>
            GetMembers(type).FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal));

        /// <summary>True when the type or a base type declares any public instance property or event with the given name.</summary>
        public bool HasMember(INamedTypeSymbol type, string memberName)
        {
            if (type is null || string.IsNullOrEmpty(memberName))
            {
                return false;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers(memberName))
                {
                    if (member.DeclaredAccessibility == Accessibility.Public && !member.IsStatic &&
                        member is IPropertySymbol or IEventSymbol)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>Property-element validation: does type (or a base type) expose a public, non-static instance PROPERTY named memberName?</summary>
        public bool HasProperty(INamedTypeSymbol type, string memberName)
        {
            if (type is null || string.IsNullOrEmpty(memberName))
            {
                return false;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers(memberName))
                {
                    if (member.DeclaredAccessibility == Accessibility.Public && !member.IsStatic &&
                        member is IPropertySymbol)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>Candidate member NAMES for a misspelled ATTRIBUTE on type, mirroring HasMember: every public</summary>
        public IEnumerable<string> GetAttributeCandidateNames(INamedTypeSymbol type)
        {
            if (type is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers())
                {
                    if (member.DeclaredAccessibility != Accessibility.Public || member.IsStatic)
                    {
                        continue;
                    }

                    if (member is IPropertySymbol { IsIndexer: false } p && seen.Add(p.Name))
                    {
                        yield return p.Name;
                    }
                    else if (member is IEventSymbol e && seen.Add(e.Name))
                    {
                        yield return e.Name;
                    }
                }
            }
        }

        /// <summary>Candidate member NAMES for a misspelled PROPERTY ELEMENT on owner, mirroring HasProperty + HasAttachedMember: every public, non-static instance property (get-only INCLUDED,</summary>
        public IEnumerable<string> GetPropertyElementCandidateNames(INamedTypeSymbol owner)
        {
            if (owner is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? t = owner; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers())
                {
                    if (member is IPropertySymbol { IsIndexer: false } p && !p.IsStatic &&
                        p.DeclaredAccessibility == Accessibility.Public && seen.Add(p.Name))
                    {
                        yield return p.Name;
                    }
                }
            }

            foreach (var attached in GetAttachedProperties(owner))
            {
                if (seen.Add(attached.Name))
                {
                    yield return attached.Name;
                }
            }
        }

        /// <summary>Properties that can be authored in property-element form: publicly settable
        /// properties, get-only collections, and attached properties.</summary>
        public IEnumerable<XamlMemberInfo> GetPropertyElementMembers(INamedTypeSymbol owner)
        {
            if (owner is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (INamedTypeSymbol? type = owner; type is not null; type = type.BaseType)
            {
                foreach (var property in type.GetMembers().OfType<IPropertySymbol>())
                {
                    if (property.IsStatic ||
                        property.IsIndexer ||
                        property.DeclaredAccessibility != Accessibility.Public ||
                        !seen.Add(property.Name))
                    {
                        continue;
                    }

                    bool publiclySettable =
                        property.SetMethod?.DeclaredAccessibility == Accessibility.Public;
                    bool getOnlyCollection =
                        property.GetMethod?.DeclaredAccessibility == Accessibility.Public &&
                        GetCollectionElementType(property.Type) is not null;
                    if (publiclySettable || getOnlyCollection)
                    {
                        yield return new XamlMemberInfo(
                            property.Name,
                            XamlMemberKind.Property,
                            property,
                            property.Type,
                            type);
                    }
                }
            }

            foreach (var attached in GetAttachedProperties(owner))
            {
                if (seen.Add(attached.Name))
                {
                    yield return attached;
                }
            }
        }

        /// <summary>Enumerates the attached properties declared by owner — the WinUI pattern of a static GetXxx(DependencyObject) / SetXxx(DependencyObject, T) pair.</summary>
        public IEnumerable<XamlMemberInfo> GetAttachedProperties(INamedTypeSymbol owner)
        {
            if (owner is null)
            {
                yield break;
            }

            var setters = new Dictionary<string, IMethodSymbol>(StringComparer.Ordinal);
            var getters = new Dictionary<string, IMethodSymbol>(StringComparer.Ordinal);

            for (INamedTypeSymbol? t = owner; t is not null; t = t.BaseType)
            {
                foreach (var method in t.GetMembers().OfType<IMethodSymbol>())
                {
                    if (!method.IsStatic || method.DeclaredAccessibility != Accessibility.Public)
                    {
                        continue;
                    }

                    if (method.Name.StartsWith("Get", StringComparison.Ordinal) &&
                        method.Parameters.Length == 1 &&
                        !method.ReturnsVoid)
                    {
                        var name = method.Name.Substring(3);
                        if (!getters.ContainsKey(name))
                        {
                            getters[name] = method;
                        }
                    }
                    else if (method.Name.StartsWith("Set", StringComparison.Ordinal) &&
                             method.Parameters.Length == 2 &&
                             method.ReturnsVoid)
                    {
                        var name = method.Name.Substring(3);
                        if (!setters.ContainsKey(name))
                        {
                            setters[name] = method;
                        }
                    }
                }
            }

            foreach (var pair in getters)
            {
                if (setters.ContainsKey(pair.Key))
                {
                    yield return new XamlMemberInfo(
                        pair.Key, XamlMemberKind.AttachedProperty, pair.Value, pair.Value.ReturnType, owner);
                }
            }
        }

        /// <summary>Lenient check for attached-property attribute validation: does owner (or a base type) expose a public static Get{member} (1 arg, non-void) or Set{member} (2 args, void) accessor?</summary>
        public bool HasAttachedMember(INamedTypeSymbol owner, string member)
            => GetAttachedMemberType(owner, member) is not null;

        /// <summary>Enumerates the members bindable via {x:Bind} on type: public instance properties (with a getter), fields, and ordinary methods.</summary>
        public IEnumerable<ISymbol> GetBindableMembers(ITypeSymbol? type, bool includeRootNonPublic = false)
        {
            if (type is null)
            {
                yield break;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            bool isRoot = true;
            foreach (var t in SelfAndBases(type))
            {
                bool allowNonPublic = includeRootNonPublic && isRoot;
                foreach (var member in t.GetMembers())
                {
                    if ((member.DeclaredAccessibility != Accessibility.Public && !allowNonPublic) ||
                        member.IsStatic || member.IsImplicitlyDeclared)
                    {
                        continue;
                    }

                    switch (member)
                    {
                        case IPropertySymbol { IsIndexer: false, GetMethod: not null } p when seen.Add(p.Name):
                            yield return p;
                            break;

                        case IFieldSymbol f when seen.Add(f.Name):
                            yield return f;
                            break;

                        case IMethodSymbol { MethodKind: MethodKind.Ordinary } m when seen.Add(m.Name):
                            yield return m;
                            break;
                    }
                }

                isRoot = false;
            }
        }

        /// <summary>Enumerates every callable method available to an x:Bind root, preserving overloads so function-binding validation can check argument counts.</summary>
        public IEnumerable<IMethodSymbol> GetBindableMethods(ITypeSymbol? type, bool includeRootNonPublic = false)
        {
            if (type is null)
            {
                yield break;
            }

            var seenNames = new HashSet<string>(StringComparer.Ordinal);
            bool isRoot = true;
            foreach (var t in SelfAndBases(type))
            {
                bool allowNonPublic = includeRootNonPublic && isRoot;
                var methods = t.GetMembers().OfType<IMethodSymbol>()
                    .Where(method =>
                        method.MethodKind == MethodKind.Ordinary &&
                        !method.IsStatic &&
                        !method.IsImplicitlyDeclared &&
                        (method.DeclaredAccessibility == Accessibility.Public || allowNonPublic))
                    .ToArray();
                foreach (var method in methods)
                {
                    if (!seenNames.Contains(method.Name))
                    {
                        yield return method;
                    }
                }

                foreach (var name in methods.Select(method => method.Name))
                {
                    seenNames.Add(name);
                }

                isRoot = false;
            }
        }

        /// <summary>Returns the value type of an attached-property accessor, accepting either accessor half.</summary>
        public ITypeSymbol? GetAttachedMemberType(INamedTypeSymbol owner, string member)
        {
            if (owner is null || string.IsNullOrEmpty(member))
            {
                return null;
            }

            for (INamedTypeSymbol? t = owner; t is not null; t = t.BaseType)
            {
                foreach (var method in t.GetMembers())
                {
                    if (method is not IMethodSymbol { IsStatic: true, DeclaredAccessibility: Accessibility.Public } m)
                    {
                        continue;
                    }

                    if (string.Equals(m.Name, "Get" + member, StringComparison.Ordinal) &&
                        m.Parameters.Length == 1 && !m.ReturnsVoid)
                    {
                        return m.ReturnType;
                    }

                    if (string.Equals(m.Name, "Set" + member, StringComparison.Ordinal) &&
                        m.Parameters.Length == 2 && m.ReturnsVoid)
                    {
                        return m.Parameters[1].Type;
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// True for RelativePanel attached properties whose SDK getter signature marks an
        /// element-name alignment target rather than a boolean *WithPanel flag.
        /// </summary>
        public bool IsRelativePanelElementReference(INamedTypeSymbol owner, string member)
        {
            var relativePanel = ResolveMetadataType("Microsoft.UI.Xaml.Controls.RelativePanel");
            var uiElement = ResolveMetadataType("Microsoft.UI.Xaml.UIElement");
            if (relativePanel is null ||
                uiElement is null ||
                !SymbolEqualityComparer.Default.Equals(owner, relativePanel))
            {
                return false;
            }

            return GetAttachedProperties(owner)
                .FirstOrDefault(candidate => string.Equals(candidate.Name, member, StringComparison.Ordinal))
                ?.Symbol is IMethodSymbol
                {
                    ReturnType.SpecialType: SpecialType.System_Object,
                    Parameters.Length: 1,
                } getter &&
                SymbolEqualityComparer.Default.Equals(getter.Parameters[0].Type, uiElement);
        }

        /// <summary>The value type produced by a bindable member (property/field type, or method return).</summary>
        public static ITypeSymbol? GetMemberType(ISymbol member) => member switch
        {
            IPropertySymbol p => p.Type,
            IFieldSymbol f => f.Type,
            IMethodSymbol m => m.ReturnType,
            _ => null,
        };

        /// <summary>Resolves the declared type of a public instance property by name, walking base types.</summary>
        public ITypeSymbol? GetPropertyType(INamedTypeSymbol type, string propertyName)
        {
            if (type is null || string.IsNullOrEmpty(propertyName))
            {
                return null;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var member in t.GetMembers(propertyName))
                {
                    if (member is IPropertySymbol { IsStatic: false, IsIndexer: false, DeclaredAccessibility: Accessibility.Public } p)
                    {
                        return p.Type;
                    }
                }
            }

            return null;
        }

        /// <summary>The type of the elements accepted as XAML child content of type: resolves the [ContentProperty] (walking the base chain for the most-derived declaration, since XAML inherits it)</summary>
        public ITypeSymbol? GetContentPropertyType(INamedTypeSymbol type)
        {
            if (type is null)
            {
                return null;
            }

            for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
            {
                foreach (var attr in t.GetAttributes())
                {
                    if (attr.AttributeClass?.Name != "ContentPropertyAttribute")
                    {
                        continue;
                    }

                    string? propertyName = null;
                    foreach (var na in attr.NamedArguments)
                    {
                        if (na.Key == "Name" && na.Value.Value is string s)
                        {
                            propertyName = s;
                            break;
                        }
                    }

                    if (propertyName is null && attr.ConstructorArguments.Length == 1 &&
                        attr.ConstructorArguments[0].Value is string cs)
                    {
                        propertyName = cs;
                    }

                    if (string.IsNullOrEmpty(propertyName))
                    {
                        return null;
                    }

                    var propertyType = GetPropertyType(type, propertyName!);
                    if (propertyType is null)
                    {
                        return null;
                    }

                    return GetCollectionElementType(propertyType) ?? propertyType;
                }
            }

            return null;
        }

        /// <summary>If type is an array or a generic collection (implements IEnumerable{T}), returns the element type T; otherwise null.</summary>
        public static ITypeSymbol? GetCollectionElementType(ITypeSymbol? type)
        {
            if (type is null)
            {
                return null;
            }

            if (type is IArrayTypeSymbol array)
            {
                return array.ElementType;
            }

            IEnumerable<INamedTypeSymbol> interfaces = type.AllInterfaces;
            if (type is INamedTypeSymbol { TypeKind: TypeKind.Interface } iface)
            {
                interfaces = new[] { iface }.Concat(interfaces);
            }

            foreach (var i in interfaces)
            {
                if (i is { IsGenericType: true, TypeArguments.Length: 1 } &&
                    i.ConstructedFrom.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T)
                {
                    return i.TypeArguments[0];
                }
            }

            return null;
        }

        /// <summary> True when <paramref name="candidate"/> is <paramref name="target"/> or derives from it (class base chain). Used to scope property-element child completion to assignable types.</summary>
        public static bool IsAssignableTo(ITypeSymbol candidate, ITypeSymbol target)
        {
            foreach (var t in SelfAndBases(candidate))
            {
                if (SymbolEqualityComparer.Default.Equals(t, target))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>The type and its inheritance chain to draw members from: for a class, the base-type chain up to (but excluding) object; for an interface, the interface plus all it inherits.</summary>
        private static IEnumerable<ITypeSymbol> SelfAndBases(ITypeSymbol type)
        {
            if (type.TypeKind == TypeKind.Interface)
            {
                yield return type;
                foreach (var inherited in type.AllInterfaces)
                {
                    yield return inherited;
                }

                yield break;
            }

            for (ITypeSymbol? t = type; t is not null && t.SpecialType != SpecialType.System_Object; t = t.BaseType)
            {
                yield return t;
            }
        }

        // --- namespace resolution ----------------------------------------------------------------

        private IEnumerable<NamespaceBinding> NamespacesFor(string? xmlnsUri)
        {
            if (string.IsNullOrEmpty(xmlnsUri))
            {
                yield break;
            }

            if (xmlnsUri!.StartsWith(UsingScheme, StringComparison.Ordinal))
            {
                var clrNamespace = xmlnsUri.Substring(UsingScheme.Length).Trim();
                foreach (var asm in _assemblies)
                {
                    yield return new NamespaceBinding(asm, clrNamespace);
                }

                yield break;
            }

            if (xmlnsUri.StartsWith(ClrNamespaceScheme, StringComparison.Ordinal))
            {
                foreach (var binding in ParseClrNamespace(xmlnsUri))
                {
                    yield return binding;
                }

                yield break;
            }

            if (_xmlnsMap.TryGetValue(xmlnsUri, out var bindings))
            {
                foreach (var binding in bindings)
                {
                    yield return binding;
                }
            }
        }

        private IEnumerable<NamespaceBinding> ParseClrNamespace(string uri)
        {
            // clr-namespace:Some.Ns[;assembly=AsmName]
            var body = uri.Substring(ClrNamespaceScheme.Length);
            string clrNamespace = body;
            string? assemblyName = null;

            int semi = body.IndexOf(';');
            if (semi >= 0)
            {
                clrNamespace = body.Substring(0, semi).Trim();
                var rest = body.Substring(semi + 1);
                const string assemblyKey = "assembly=";
                int idx = rest.IndexOf(assemblyKey, StringComparison.OrdinalIgnoreCase);
                if (idx >= 0)
                {
                    assemblyName = rest.Substring(idx + assemblyKey.Length).Trim();
                }
            }

            IEnumerable<IAssemblySymbol> candidates = assemblyName is { Length: > 0 }
                ? _assemblies.Where(a => string.Equals(a.Name, assemblyName, StringComparison.OrdinalIgnoreCase))
                : _assemblies;

            foreach (var asm in candidates)
            {
                yield return new NamespaceBinding(asm, clrNamespace);
            }
        }

        private static INamedTypeSymbol? FindType(NamespaceBinding binding, string localName)
        {
            var ns = ResolveNamespace(binding.Assembly.GlobalNamespace, binding.ClrNamespace);
            return ns?.GetTypeMembers(localName).FirstOrDefault();
        }

        private static INamespaceSymbol? ResolveNamespace(INamespaceSymbol root, string dotted)
        {
            var current = root;
            if (string.IsNullOrEmpty(dotted))
            {
                return current;
            }

            foreach (var part in dotted.Split('.'))
            {
                current = current.GetNamespaceMembers()
                    .FirstOrDefault(n => string.Equals(n.Name, part, StringComparison.Ordinal));
                if (current is null)
                {
                    return null;
                }
            }

            return current;
        }

        private static bool IsPublicClass(INamedTypeSymbol type) =>
            type.DeclaredAccessibility == Accessibility.Public &&
            type.TypeKind == TypeKind.Class &&
            !type.IsStatic;

        private static bool IsPublicType(INamedTypeSymbol type) =>
            type.DeclaredAccessibility == Accessibility.Public &&
            type.TypeKind is TypeKind.Class or TypeKind.Struct or TypeKind.Enum
                or TypeKind.Interface or TypeKind.Delegate;

        private static Dictionary<string, List<NamespaceBinding>> BuildXmlnsMap(
            ImmutableArray<IAssemblySymbol> assemblies)
        {
            var map = new Dictionary<string, List<NamespaceBinding>>(StringComparer.Ordinal);

            foreach (var asm in assemblies)
            {
                foreach (var attr in asm.GetAttributes())
                {
                    if (attr.AttributeClass?.Name != "XmlnsDefinitionAttribute" ||
                        attr.ConstructorArguments.Length < 2)
                    {
                        continue;
                    }

                    if (attr.ConstructorArguments[0].Value is not string xmlNamespace ||
                        attr.ConstructorArguments[1].Value is not string clrNamespace)
                    {
                        continue;
                    }

                    // An optional AssemblyName named-argument can retarget the CLR namespace to another assembly; default to the declaring assembly.
                    var target = asm;
                    foreach (var named in attr.NamedArguments)
                    {
                        if (string.Equals(named.Key, "AssemblyName", StringComparison.Ordinal) &&
                            named.Value.Value is string retarget)
                        {
                            target = assemblies.FirstOrDefault(
                                a => string.Equals(a.Name, retarget, StringComparison.OrdinalIgnoreCase)) ?? asm;
                        }
                    }

                    if (!map.TryGetValue(xmlNamespace, out var list))
                    {
                        list = new List<NamespaceBinding>();
                        map[xmlNamespace] = list;
                    }

                    list.Add(new NamespaceBinding(target, clrNamespace));
                }
            }

            return map;
        }

        /// <summary>Adds the WinUI presentation-namespace convention mapping when the referenced assemblies carry no XmlnsDefinitionAttribute for it (the common case).</summary>
        private static void AddConventionNamespaces(
            Dictionary<string, List<NamespaceBinding>> map, ImmutableArray<IAssemblySymbol> assemblies)
        {
            if (map.ContainsKey(PresentationNamespace))
            {
                return;
            }

            var bindings = new List<NamespaceBinding>();
            foreach (var asm in assemblies)
            {
                foreach (var root in PresentationRoots)
                {
                    var rootNs = ResolveNamespace(asm.GlobalNamespace, root);
                    if (rootNs is null)
                    {
                        continue;
                    }

                    foreach (var ns in EnumerateSelfAndDescendants(rootNs))
                    {
                        bindings.Add(new NamespaceBinding(asm, ns.ToDisplayString()));
                    }
                }
            }

            if (bindings.Count > 0)
            {
                map[PresentationNamespace] = bindings;
            }
        }

        private static IEnumerable<INamespaceSymbol> EnumerateSelfAndDescendants(INamespaceSymbol ns)
        {
            yield return ns;
            foreach (var child in ns.GetNamespaceMembers())
            {
                foreach (var descendant in EnumerateSelfAndDescendants(child))
                {
                    yield return descendant;
                }
            }
        }

        private readonly record struct NamespaceBinding(IAssemblySymbol Assembly, string ClrNamespace);
    }

    /// <summary>A keyed resource declared by the active WinUI SDK's generic.xaml.</summary>
    public sealed class ThemeResourceInfo
    {
        public ThemeResourceInfo(string key, string typeNamespace, string localTypeName)
        {
            Key = key;
            TypeNamespace = typeNamespace;
            LocalTypeName = localTypeName;
        }

        public string Key { get; }

        public string TypeNamespace { get; }

        public string LocalTypeName { get; }
    }

    /// <summary>The kind of XAML member a <see cref="XamlMemberInfo"/> describes.</summary>
    public enum XamlMemberKind
    {
        /// <summary>A settable instance property (usable as an attribute or property element).</summary>
        Property,

        /// <summary>An event (usable as an attribute mapping to a handler).</summary>
        Event,

        /// <summary>An attached property (a static Get/Set pair.</summary>
        AttachedProperty,
    }

    /// <summary>A resolved XAML-relevant member: its name, kind, the underlying Roslyn symbol, its value type, and the type that declared it.</summary>
    public sealed class XamlMemberInfo
    {
        internal XamlMemberInfo(
            string name,
            XamlMemberKind kind,
            ISymbol symbol,
            ITypeSymbol? type,
            INamedTypeSymbol declaringType)
        {
            Name = name;
            Kind = kind;
            Symbol = symbol;
            Type = type;
            DeclaringType = declaringType;
        }

        /// <summary>The XAML-facing member name.</summary>
        public string Name { get; }

        /// <summary>Whether this is a property, event, or attached property.</summary>
        public XamlMemberKind Kind { get; }

        /// <summary>The underlying Roslyn symbol (property, event, or the attached-property getter).</summary>
        public ISymbol Symbol { get; }

        /// <summary>The member's value type (property type, event handler type, attached-property type).</summary>
        public ITypeSymbol? Type { get; }

        /// <summary>The type that declares this member (may be a base type of the queried type).</summary>
        public INamedTypeSymbol DeclaringType { get; }
    }
}

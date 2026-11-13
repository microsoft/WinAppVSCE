using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Surface;

/// <summary>
/// The value a page or view-model member holds when the page first shows, when the source proves it: the
/// member's initializer (or its type's default) plus constant writes in constructors and load/navigation code.
/// Writes from user-interaction handlers don't change the initial state; any other write (a helper method, a
/// computed value) makes it unknown, and callers fall back to generated values.
/// </summary>
internal static partial class SamplePlanner
{
    /// <summary>A proven initial value: a constant (<c>bool</c>, number, string, null) or an enum member name.</summary>
    internal readonly record struct Initial(object? Value, string? EnumMember, bool IsDefault = false);

    private static readonly Dictionary<(SampleTypeModel, ISymbol), Initial?> InitialCache = new();

    /// <summary>The proven initial value of the member a simple page-scope path ends at, or null when unknown.</summary>
    private static Initial? InitialOfPath(Context ctx, string? path)
    {
        if (ctx.Model is null || ctx.RootType is null || string.IsNullOrWhiteSpace(path))
        {
            return null;
        }
        var segments = path.Trim().Split('.');
        if (segments.Any(s => !System.Text.RegularExpressions.Regex.IsMatch(s.Trim(), @"^[A-Za-z_]\w*$")))
        {
            return null;
        }

        ITypeSymbol? owner = ctx.RootType;
        for (int i = 0; i < segments.Length - 1 && owner is not null; i++)
        {
            owner = SampleTypeModel.MemberType(owner, segments[i].Trim());
        }
        return owner is null ? null : InitialOf(ctx.Model, owner, segments[^1].Trim());
    }

    internal static Initial? InitialOf(SampleTypeModel model, ITypeSymbol owner, string member)
    {
        var symbol = FindDataMember(owner, member);
        if (symbol is null)
        {
            return null;
        }

        lock (InitialCache)
        {
            if (InitialCache.TryGetValue((model, symbol), out var cached))
            {
                return cached;
            }
        }

        Initial? result = null;
        try
        {
            result = ComputeInitial(model, symbol);
        }
        catch
        {
            result = null;
        }

        lock (InitialCache)
        {
            if (InitialCache.Count > 4096)
            {
                InitialCache.Clear();
            }
            InitialCache[(model, symbol)] = result;
        }
        return result;
    }

    /// <summary>The property or field named <paramref name="member"/> (or a toolkit <c>[ObservableProperty]</c> field for it).</summary>
    private static ISymbol? FindDataMember(ITypeSymbol owner, string member)
    {
        for (var cur = owner; cur is not null; cur = cur.BaseType)
        {
            var direct = cur.GetMembers(member).FirstOrDefault(m => m is IPropertySymbol or IFieldSymbol);
            if (direct is not null)
            {
                return direct;
            }
            foreach (var f in cur.GetMembers().OfType<IFieldSymbol>())
            {
                if (FieldPropertyName(f.Name) == member)
                {
                    return f;
                }
            }
        }
        return null;
    }

    private static Initial? ComputeInitial(SampleTypeModel model, ISymbol symbol)
    {
        if (!symbol.Locations.Any(l => l.IsInSource) || symbol.IsAbstract)
        {
            return null;
        }

        var type = symbol switch { IPropertySymbol p => p.Type, IFieldSymbol f => f.Type, _ => null };
        if (type is null)
        {
            return null;
        }

        // The symbols whose writes set this value: the member, plus the field a simple property wraps.
        var targets = new List<ISymbol> { symbol };
        Initial? value = DefaultOf(type);
        foreach (var syntaxRef in symbol.DeclaringSyntaxReferences)
        {
            var decl = syntaxRef.GetSyntax();
            var semantic = model.Compilation.GetSemanticModel(decl.SyntaxTree);
            switch (decl)
            {
                case PropertyDeclarationSyntax prop:
                {
                    if (prop.ExpressionBody is { } body)
                    {
                        // public bool IsEmpty => false;  (computed values are unknown)
                        return ConstantOf(body.Expression, semantic);
                    }
                    var getter = prop.AccessorList?.Accessors.FirstOrDefault(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
                    if (getter is { Body: not null } or { ExpressionBody: not null })
                    {
                        var returned = getter.ExpressionBody?.Expression ??
                            (getter.Body!.Statements.Count == 1 && getter.Body.Statements[0] is ReturnStatementSyntax r ? r.Expression : null);
                        if (returned is null || semantic.GetSymbolInfo(returned).Symbol is not IFieldSymbol backing ||
                            !SymbolEqualityComparer.Default.Equals(backing.ContainingType, symbol.ContainingType))
                        {
                            return null; // computed or stored elsewhere (GetValue, a dictionary)
                        }
                        targets.Add(backing);
                        var fieldInit = backing.DeclaringSyntaxReferences.Select(s => s.GetSyntax()).OfType<VariableDeclaratorSyntax>()
                            .FirstOrDefault()?.Initializer?.Value;
                        if (fieldInit is not null)
                        {
                            value = ConstantOf(fieldInit, model.Compilation.GetSemanticModel(fieldInit.SyntaxTree));
                        }
                    }
                    else if (prop.Initializer is { } init)
                    {
                        value = ConstantOf(init.Value, semantic);
                    }
                    break;
                }
                case VariableDeclaratorSyntax { Initializer: { } fieldInit }:
                    value = ConstantOf(fieldInit.Value, semantic);
                    break;
            }
        }

        // Writes: constructors first, then load/navigation code, in source order. Handlers are ignored.
        var names = new HashSet<string>(targets.Select(t => t.Name), StringComparer.Ordinal);
        var ctorWrites = new List<Initial?>();
        var loadWrites = new List<Initial?>();
        var index = AssignmentIndex(model);
        // A toolkit [ObservableProperty] field is written through its generated property, which this model
        // doesn't have; those writes don't resolve, so they count when they name the property.
        if (symbol is IFieldSymbol field && FieldPropertyName(field.Name) is { } generated)
        {
            names.Add(generated);
        }
        foreach (var name in names)
        {
            if (!index.TryGetValue(name, out var writes))
            {
                continue;
            }
            foreach (var asg in writes)
            {
                var semantic = model.Compilation.GetSemanticModel(asg.SyntaxTree);
                var written = semantic.GetSymbolInfo(asg.Left).Symbol;
                if (written is not null && !targets.Any(t => SymbolEqualityComparer.Default.Equals(t, written)))
                {
                    continue;
                }

                var method = asg.FirstAncestorOrSelf<BaseMethodDeclarationSyntax>();
                if (IsEventHandlerCode(asg.Right, method))
                {
                    continue; // user interaction, not the first state
                }

                var v = asg.IsKind(SyntaxKind.SimpleAssignmentExpression) ? ConstantOf(asg.Right, semantic) : null;
                if (method is ConstructorDeclarationSyntax ctor &&
                    SymbolEqualityComparer.Default.Equals(semantic.GetDeclaredSymbol(ctor)?.ContainingType, symbol.ContainingType))
                {
                    ctorWrites.Add(v);
                }
                else if (method is MethodDeclarationSyntax m && IsLoadMethod(m.Identifier.Text))
                {
                    loadWrites.Add(v);
                }
                else
                {
                    return null; // written somewhere we can't place in time
                }
            }
        }

        foreach (var w in ctorWrites.Concat(loadWrites))
        {
            if (w is null)
            {
                return null;
            }
            value = w;
        }
        return value;
    }

    private static bool IsLoadMethod(string name) =>
        System.Text.RegularExpressions.Regex.IsMatch(name, "^On(NavigatedTo|Loaded|Launched|Activated)$|Loaded$|^Load|^Initiali[sz]e");

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<SampleTypeModel, Dictionary<string, List<AssignmentExpressionSyntax>>> Assignments = new();

    /// <summary>Every assignment in the project, by the name it writes (<c>X = …</c>, <c>a.X = …</c>).</summary>
    private static Dictionary<string, List<AssignmentExpressionSyntax>> AssignmentIndex(SampleTypeModel model) =>
        Assignments.GetValue(model, m =>
        {
            var index = new Dictionary<string, List<AssignmentExpressionSyntax>>(StringComparer.Ordinal);
            foreach (var tree in m.Compilation.SyntaxTrees)
            {
                foreach (var asg in tree.GetRoot().DescendantNodes().OfType<AssignmentExpressionSyntax>())
                {
                    var name = asg.Left switch
                    {
                        IdentifierNameSyntax id => id.Identifier.Text,
                        MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
                        MemberBindingExpressionSyntax mb => mb.Name.Identifier.Text,
                        _ => null,
                    };
                    if (name is not null)
                    {
                        if (!index.TryGetValue(name, out var list)) index[name] = list = new();
                        list.Add(asg);
                    }
                }
            }
            return index;
        });

    /// <summary><c>_isBusy</c> / <c>m_isBusy</c> / <c>isBusy</c> → <c>IsBusy</c>; null when that's the field's own name.</summary>
    private static string? FieldPropertyName(string field)
    {
        var n = field.TrimStart('_');
        if (n.StartsWith("m_", StringComparison.Ordinal)) n = n[2..];
        if (n.Length == 0) return null;
        var p = char.ToUpperInvariant(n[0]) + n[1..];
        return p == field ? null : p;
    }

    private static Initial? DefaultOf(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T })
        {
            return new Initial(null, null, true);
        }
        if (type.TypeKind == TypeKind.Enum)
        {
            var first = type.GetMembers().OfType<IFieldSymbol>().FirstOrDefault(f => f.HasConstantValue && Convert.ToInt64(f.ConstantValue) == 0);
            return first is null ? null : new Initial(null, first.Name, true);
        }
        return type.SpecialType switch
        {
            SpecialType.System_Boolean => new Initial(false, null, true),
            SpecialType.System_Int32 or SpecialType.System_Int64 or SpecialType.System_Double or SpecialType.System_Single or
            SpecialType.System_Decimal or SpecialType.System_Int16 or SpecialType.System_Byte => new Initial(0, null, true),
            _ when type.Name == "Visibility" => new Initial(null, "Visible", true),
            _ when type.IsReferenceType => new Initial(null, null, true),
            _ => null,
        };
    }

    /// <summary>A compile-time constant, an enum member (<c>Visibility.Collapsed</c>), or null when not constant.</summary>
    private static Initial? ConstantOf(ExpressionSyntax expr, SemanticModel semantic)
    {
        while (expr is ParenthesizedExpressionSyntax p) expr = p.Expression;
        if (expr is MemberAccessExpressionSyntax { Name.Identifier.Text: var member } ma &&
            (member is "Visible" or "Collapsed") && ma.Expression.ToString().EndsWith("Visibility", StringComparison.Ordinal))
        {
            return new Initial(null, member); // the platform enum isn't referenced by the model
        }
        if (expr is LiteralExpressionSyntax lit && (lit.IsKind(SyntaxKind.NullLiteralExpression) || lit.IsKind(SyntaxKind.DefaultLiteralExpression)))
        {
            return new Initial(null, null);
        }

        var constant = semantic.GetConstantValue(expr);
        if (!constant.HasValue)
        {
            return null;
        }
        if (semantic.GetSymbolInfo(expr).Symbol is IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } f)
        {
            return new Initial(null, f.Name);
        }
        return new Initial(constant.Value, null);
    }
}

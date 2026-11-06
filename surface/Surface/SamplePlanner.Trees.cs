using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Surface;

/// <summary>
/// Node-mode <c>TreeView</c>s: the code-behind builds <c>TreeViewNode</c>s and adds them to <c>RootNodes</c>, which
/// the preview never runs, so the tree rendered empty. The planner rebuilds the nodes it can follow in the code —
/// <c>new TreeViewNode { Content = "Work" }</c>, <c>node.IsExpanded = true</c>, <c>node.Children.Add(...)</c> through
/// locals — as a markup <c>&lt;TreeView.RootNodes&gt;</c>. Content it can't read becomes "Item N".
/// </summary>
internal static partial class SamplePlanner
{
    internal const int MaxTreeNodes = 50;
    private const int MaxTreeDepth = 4;

    private static void PlanTreeNodes(Context ctx, string rootClass, SamplePlan plan)
    {
        var roots = new Dictionary<XElement, List<(ExpressionSyntax arg, BaseMethodDeclarationSyntax? method)>>();
        foreach (var (target, member, arg, method) in ctx.Model!.CollectionAdds(rootClass))
        {
            try
            {
                if (member != "RootNodes" || IsEventHandlerCode(arg, method))
                {
                    continue;
                }
                foreach (var el in TreeTargets(ctx, target, method))
                {
                    if (!roots.TryGetValue(el, out var list))
                    {
                        roots[el] = list = new();
                    }
                    list.Add((arg, method));
                }
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: tree nodes {target}.{member}: {ex.GetType().Name}: {ex.Message}");
            }
        }

        foreach (var (tree, adds) in roots)
        {
            // Data mode (ItemsSource/templates) and markup nodes are left alone; RootNodes and ItemsSource don't mix.
            if (tree.Attribute("ItemsSource") is not null || tree.Attribute("ItemTemplate") is not null ||
                tree.Attribute("ItemTemplateSelector") is not null || tree.Elements().Any() || NearestTemplate(tree) is not null)
            {
                continue;
            }

            int budget = MaxTreeNodes, n = 0;
            var holder = new XElement(tree.Name.Namespace + "TreeView.RootNodes");
            foreach (var (arg, method) in adds)
            {
                if (TreeNode(tree.Name.Namespace, arg, method, 0, ref budget, ref n) is { } node)
                {
                    holder.Add(node);
                }
            }
            if (holder.HasElements)
            {
                plan.Elements.Add((tree, holder));
            }
        }
    }

    /// <summary>The named TreeView(s) <paramref name="target"/> refers to: the element itself, or — when it's a
    /// parameter of <paramref name="method"/> — the named elements its callers pass in.</summary>
    private static IEnumerable<XElement> TreeTargets(Context ctx, string target, BaseMethodDeclarationSyntax? method)
    {
        static bool IsTree(XElement el) => el.Name.LocalName == "TreeView";

        int index = method?.ParameterList.Parameters.IndexOf(p => p.Identifier.Text == target) ?? -1;
        if (index < 0)
        {
            if (ctx.Named.TryGetValue(target, out var el) && IsTree(el))
            {
                yield return el;
            }
            yield break;
        }

        if (method is not MethodDeclarationSyntax { Identifier.Text: var methodName })
        {
            yield break;
        }
        var seen = new HashSet<XElement>();
        foreach (var call in method.SyntaxTree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var called = call.Expression switch
            {
                IdentifierNameSyntax id => id.Identifier.Text,
                MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: var nm } => nm.Identifier.Text,
                _ => null,
            };
            if (called != methodName || call.ArgumentList.Arguments.Count <= index ||
                call.ArgumentList.Arguments[index].Expression is not IdentifierNameSyntax { Identifier.Text: var passed } ||
                !ctx.Named.TryGetValue(passed, out var el) || !IsTree(el) || !seen.Add(el))
            {
                continue;
            }
            yield return el;
        }
    }

    private static XElement? TreeNode(XNamespace ns, ExpressionSyntax expr, BaseMethodDeclarationSyntax? method, int depth,
        ref int budget, ref int n)
    {
        if (depth > MaxTreeDepth || budget <= 0)
        {
            return null;
        }
        while (expr is ParenthesizedExpressionSyntax p) expr = p.Expression;

        string? local = null;
        if (expr is IdentifierNameSyntax id && method is not null)
        {
            local = id.Identifier.Text;
            expr = method.DescendantNodes().OfType<VariableDeclaratorSyntax>()
                .FirstOrDefault(v => v.Identifier.Text == local)?.Initializer?.Value ?? expr;
        }

        InitializerExpressionSyntax? init = expr switch
        {
            ObjectCreationExpressionSyntax o when o.Type.ToString().EndsWith("TreeViewNode", StringComparison.Ordinal) => o.Initializer,
            ImplicitObjectCreationExpressionSyntax io => io.Initializer,
            _ => null,
        };
        if (init is null && expr is not (ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax) && local is null)
        {
            return null; // a node from a helper/field the planner can't follow
        }

        budget--;
        n++;
        string? content = null;
        bool expanded = false;
        var children = new List<ExpressionSyntax>();

        void Member(string name, ExpressionSyntax value)
        {
            if (name == "Content" && value is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } s)
            {
                content = s.Token.ValueText;
            }
            else if (name == "IsExpanded" && value.IsKind(SyntaxKind.TrueLiteralExpression))
            {
                expanded = true;
            }
        }

        foreach (var e in init?.Expressions ?? default)
        {
            if (e is AssignmentExpressionSyntax { Left: IdentifierNameSyntax { Identifier.Text: var name } } a)
            {
                if (name == "Children" && a.Right is InitializerExpressionSyntax kids)
                {
                    children.AddRange(kids.Expressions);
                }
                else
                {
                    Member(name, a.Right);
                }
            }
        }

        if (local is not null && method is not null)
        {
            foreach (var node in method.DescendantNodes())
            {
                if (node is AssignmentExpressionSyntax
                    {
                        Left: MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.Text: var o }, Name.Identifier.Text: var prop },
                    } asg && o == local)
                {
                    Member(prop, asg.Right);
                }
                else if (node is InvocationExpressionSyntax
                    {
                        Expression: MemberAccessExpressionSyntax
                        {
                            Name.Identifier.Text: "Add",
                            Expression: MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.Text: var owner }, Name.Identifier.Text: "Children" },
                        },
                        ArgumentList.Arguments: [var child],
                    } && owner == local)
                {
                    children.Add(child.Expression);
                }
            }
        }

        var el = new XElement(ns + "TreeViewNode", new XAttribute("Content", content ?? $"Item {n}"));
        if (expanded)
        {
            el.Add(new XAttribute("IsExpanded", "True"));
        }
        var holder = new XElement(ns + "TreeViewNode.Children");
        foreach (var c in children)
        {
            if (TreeNode(ns, c, method, depth + 1, ref budget, ref n) is { } child)
            {
                holder.Add(child);
            }
        }
        if (holder.HasElements)
        {
            el.Add(holder);
        }
        return el;
    }
}

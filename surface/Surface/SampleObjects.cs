using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Reflection;

namespace Surface;

/// <summary>
/// Real instances of the app's own types for sample-data rows, when the app is built and its assembly is loaded.
/// A control that takes a whole object (<c>&lt;local:FleetTile Aircraft="{x:Bind}"/&gt;</c>) and fills itself in
/// code needs an instance of that type; a dictionary row can't bind to it. Every value is generated (from the
/// member's type and name, the same rules <see cref="SamplePlanner"/> uses for text); the app's data is never read.
/// Constructing runs the type's constructor and setters, as <c>d:DesignInstance</c> does. Never throws.
/// </summary>
internal static class SampleObjects
{
    private const int MaxDepth = 2;
    private const int ListItems = 3;

    /// <summary>Resolves <paramref name="fullName"/> (<c>Ns.Outer+Inner</c>) across the loaded assemblies.</summary>
    public static Type? ResolveType(string fullName)
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.IsDynamic)
            {
                continue;
            }
            try
            {
                if (asm.GetType(fullName, throwOnError: false, ignoreCase: false) is { } t)
                {
                    return t;
                }
            }
            catch
            {
                // a broken assembly can't hold the type
            }
        }
        return null;
    }

    /// <summary>
    /// An instance of <paramref name="type"/> for row <paramref name="index"/>, or null when it can't be built.
    /// String values in <paramref name="row"/> (the planner's text for the template's bindings) win, so the
    /// row reads the same whether the app is built or not.
    /// </summary>
    public static object? Create(Type type, IReadOnlyDictionary<string, object>? row, int index) =>
        Create(type, row, index, 0);

    private static object? Create(Type type, IReadOnlyDictionary<string, object>? row, int index, int depth)
    {
        if (depth > MaxDepth || type.IsAbstract || type.IsInterface || type.ContainsGenericParameters)
        {
            return null;
        }

        object? obj;
        try
        {
            obj = Construct(type, row, index, depth);
        }
        catch (Exception ex)
        {
            App.Log($"SAMPLE: constructing {type.FullName} failed: {(ex.InnerException ?? ex).GetType().Name}: {(ex.InnerException ?? ex).Message}");
            return null;
        }
        if (obj is null)
        {
            return null;
        }

        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.GetIndexParameters().Length > 0 || !p.CanRead || IsPlatform(p.DeclaringType))
            {
                continue;
            }
            try
            {
                Fill(obj, p, row, index, depth);
            }
            catch (Exception ex)
            {
                App.Log($"SAMPLE: {type.Name}.{p.Name}: {(ex.InnerException ?? ex).GetType().Name}");
            }
        }
        return obj;
    }

    private static object? Construct(Type type, IReadOnlyDictionary<string, object>? row, int index, int depth)
    {
        if (type.IsValueType)
        {
            return Activator.CreateInstance(type);
        }

        var ctors = type.GetConstructors(BindingFlags.Public | BindingFlags.Instance);
        if (ctors.FirstOrDefault(c => c.GetParameters().Length == 0) is { } empty)
        {
            return empty.Invoke(null);
        }

        foreach (var ctor in ctors.OrderBy(c => c.GetParameters().Length))
        {
            var ps = ctor.GetParameters();
            var args = new object?[ps.Length];
            bool ok = true;
            for (int i = 0; i < ps.Length && ok; i++)
            {
                var name = ps[i].Name ?? "Value";
                args[i] = RowValue(row, name, ps[i].ParameterType, index, depth) ?? ValueFor(ps[i].ParameterType, name, index, depth);
                ok = args[i] is not null || !ps[i].ParameterType.IsValueType;
            }
            if (ok)
            {
                return ctor.Invoke(args);
            }
        }
        return null;
    }

    private static void Fill(object obj, PropertyInfo p, IReadOnlyDictionary<string, object>? row, int index, int depth)
    {
        var current = p.GetValue(obj);

        // A get-only collection (Items { get; } = new()): add rows to it.
        if (!p.CanWrite || p.SetMethod is not { IsPublic: true })
        {
            if (current is IList list && !list.IsReadOnly && !list.IsFixedSize && list.Count == 0 &&
                ElementTypeOf(p.PropertyType) is { } et && depth < MaxDepth)
            {
                for (int i = 0; i < ListItems; i++)
                {
                    if (ValueFor(et, Singular(p.Name), i, depth + 1) is { } item)
                    {
                        list.Add(item);
                    }
                }
            }
            return;
        }

        var value = RowValue(row, p.Name, p.PropertyType, index, depth);
        if (value is null)
        {
            if (!IsUnset(current, p.PropertyType))
            {
                return; // the type's own default ("A-check") reads better than a generated one
            }
            value = ValueFor(p.PropertyType, p.Name, index, depth);
        }
        if (value is not null)
        {
            p.SetValue(obj, value);
        }
    }

    /// <summary>The planner's value for <paramref name="name"/>, when it suits <paramref name="type"/>.</summary>
    private static object? RowValue(IReadOnlyDictionary<string, object>? row, string name, Type type, int index, int depth)
    {
        if (row is null)
        {
            return null;
        }
        var key = row.Keys.FirstOrDefault(k => string.Equals(k, name, StringComparison.OrdinalIgnoreCase));
        if (key is null)
        {
            return null;
        }
        return row[key] switch
        {
            string s when type == typeof(string) || type == typeof(object) => s,
            IReadOnlyDictionary<string, object> d when !IsPlatform(type) => Create(type, d, index, depth + 1),
            _ => null,
        };
    }

    private static bool IsUnset(object? current, Type type)
    {
        if (current is null || current is string { Length: 0 })
        {
            return true;
        }
        var t = Nullable.GetUnderlyingType(type) ?? type;
        if (t.IsEnum)
        {
            return true; // every row would share the first member; vary them instead
        }
        return t.IsValueType && current.Equals(Activator.CreateInstance(t));
    }

    /// <summary>A generated value of <paramref name="type"/> for a member named <paramref name="name"/>.</summary>
    internal static object? ValueFor(Type type, string name, int index, int depth)
    {
        var t = Nullable.GetUnderlyingType(type) ?? type;
        if (t == typeof(string) || t == typeof(object)) return SamplePlanner.TextByName(name, index);
        if (t == typeof(bool)) return index % 2 == 0;
        if (t == typeof(char)) return (char)('A' + index % 26);
        if (t.IsEnum)
        {
            var values = Enum.GetValues(t);
            return values.Length == 0 ? null : values.GetValue(index % values.Length);
        }
        if (t == typeof(int) || t == typeof(long) || t == typeof(short) || t == typeof(byte) ||
            t == typeof(uint) || t == typeof(ulong) || t == typeof(ushort))
        {
            return Convert.ChangeType(SamplePlanner.IntByName(name, index), t, CultureInfo.InvariantCulture);
        }
        if (t == typeof(double) || t == typeof(float) || t == typeof(decimal))
        {
            return Convert.ChangeType(SamplePlanner.DoubleByName(name, index), t, CultureInfo.InvariantCulture);
        }
        if (t == typeof(DateTime)) return SamplePlanner.SampleDate(index);
        if (t == typeof(DateTimeOffset)) return new DateTimeOffset(SamplePlanner.SampleDate(index));
        if (t == typeof(DateOnly)) return DateOnly.FromDateTime(SamplePlanner.SampleDate(index));
        if (t == typeof(TimeSpan)) return new TimeSpan(2 + index, 15 * index % 60, 0);
        if (t == typeof(TimeOnly)) return new TimeOnly(2 + index, 15 * index % 60);
        if (t == typeof(Guid)) return new Guid($"00000000-0000-0000-0000-{1001 + index:000000000000}");
        if (t == typeof(Uri)) return new Uri("https://example.com");

        if (depth >= MaxDepth)
        {
            return null;
        }
        if (ElementTypeOf(t) is { } et)
        {
            return MakeList(t, et, name, depth);
        }
        return IsPlatform(t) ? null : Create(t, null, index, depth + 1);
    }

    private static object? MakeList(Type listType, Type itemType, string name, int depth)
    {
        var items = new List<object?>();
        for (int i = 0; i < ListItems; i++)
        {
            if (ValueFor(itemType, Singular(name), i, depth + 1) is { } item)
            {
                items.Add(item);
            }
        }

        if (listType.IsArray)
        {
            var arr = Array.CreateInstance(itemType, items.Count);
            for (int i = 0; i < items.Count; i++) arr.SetValue(items[i], i);
            return arr;
        }

        foreach (var candidate in new[] { typeof(List<>), typeof(ObservableCollection<>) })
        {
            var concrete = candidate.MakeGenericType(itemType);
            var target = listType.IsInterface || listType.IsAbstract ? concrete : listType;
            if (!listType.IsAssignableFrom(target) || target.GetConstructor(Type.EmptyTypes) is null)
            {
                continue;
            }
            var list = (IList)Activator.CreateInstance(target)!;
            foreach (var item in items) list.Add(item);
            return list;
        }
        return null;
    }

    /// <summary>The item type of a non-string collection type, else null.</summary>
    private static Type? ElementTypeOf(Type t)
    {
        if (t == typeof(string)) return null;
        if (t.IsArray) return t.GetElementType();
        var e = t.IsGenericType && t.GetGenericTypeDefinition() == typeof(IEnumerable<>)
            ? t
            : t.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        if (e is null) return null;
        var arg = e.GetGenericArguments()[0];
        return arg.IsGenericType && arg.GetGenericTypeDefinition() == typeof(KeyValuePair<,>) ? null : arg;
    }

    private static bool IsPlatform(Type? t)
    {
        var ns = t?.Namespace;
        return ns is null || ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal) ||
            ns.StartsWith("Microsoft.", StringComparison.Ordinal) || ns.StartsWith("Windows.", StringComparison.Ordinal) ||
            ns.StartsWith("WinRT", StringComparison.Ordinal);
    }

    private static string Singular(string name) =>
        name.EndsWith("ies", StringComparison.Ordinal) ? name[..^3] + "y" :
        name.EndsWith("s", StringComparison.Ordinal) && !name.EndsWith("ss", StringComparison.Ordinal) ? name[..^1] : name;
}

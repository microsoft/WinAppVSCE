using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

// LspJsonContextCoverageTests enumerates candidate payloads from the *assembly* and asks whether
// the context knows them. This file enumerates in the opposite direction -- from the context -- and
// asks whether what it claims to know can actually be read and written.
//
// The two directions catch different defects, and neither subsumes the other:
//
//   assembly -> context   a DTO nobody registered                (missing metadata)
//   context  -> wire      a registration that cannot round-trip  (unusable metadata)
//
// The second direction is the only one that sees the registrations which are not DTOs in the Lsp
// namespace at all -- List<T> closed generics, object[], bool, string. Those are invisible to an
// assembly walk filtered to concrete Lsp classes, yet they are exactly the shapes that fail under
// Native AOT, because JsonSerializerIsReflectionEnabledByDefault=false means an unusable
// registration throws NotSupportedException instead of silently falling back to reflection.
//
// It is also the only place the *inbound* path is exercised systematically. Everything else in this
// suite serializes. JsonRpcConnection.Deserialize is a separate source-generated code path, and a
// type can be writable while not being readable (most commonly: no accessible parameterless
// constructor). Round-tripping proves both halves.
public class LspJsonContextRoundTripTests
{
    /// <summary>
    /// Every type registered in the context can be written and read back with reflection
    /// unavailable, exactly as under Native AOT.
    /// </summary>
    [Fact]
    public void EveryRegisteredTypeRoundTripsWithoutReflection()
    {
        var failures = new SortedSet<string>(StringComparer.Ordinal);
        var covered = 0;

        foreach (var registered in RegisteredTypes())
        {
            var typeInfo = LspJsonContext.Default.GetTypeInfo(registered);
            if (typeInfo is null)
            {
                failures.Add($"{Describe(registered)} exposes a JsonTypeInfo property but " +
                    "GetTypeInfo returns null, so resolving it on the wire fails.");
                continue;
            }

            if (!TryCreateProbe(registered, out var instance, out var reason))
            {
                // Not every registration is constructible here (abstract shapes, types whose
                // members this probe cannot populate). Those are covered by the write-side
                // guards in LspJsonContextCoverageTests; skipping them is why the coverage
                // floor below exists.
                Assert.NotNull(reason);
                continue;
            }

            string json;
            try
            {
                json = JsonSerializer.Serialize(instance, registered, LspJsonContext.Default);
            }
            catch (Exception ex)
            {
                failures.Add($"{Describe(registered)} failed to serialize: " +
                    $"{ex.GetType().Name}: {ex.Message}");
                continue;
            }

            try
            {
                JsonSerializer.Deserialize(json, registered, LspJsonContext.Default);
            }
            catch (Exception ex)
            {
                failures.Add($"{Describe(registered)} serialized to {Clip(json)} but failed to " +
                    $"read back: {ex.GetType().Name}: {ex.Message}");
                continue;
            }

            covered++;
        }

        Assert.True(
            failures.Count == 0,
            "These types are registered in LspJsonContext but do not survive a round trip. Under " +
            "Native AOT there is no reflection fallback, so each throws on the wire:\n  " +
            string.Join("\n  ", failures));

        // A filter or construction regression that emptied this set would make the test vacuous
        // while staying green -- a check that cannot fire is indistinguishable from one that
        // passed. The floor is well under the registration count so ordinary additions do not
        // trip it, but far above zero.
        Assert.True(covered > 40, $"Expected broad round-trip coverage, only exercised {covered}.");
    }

    /// <summary>
    /// The registered <c>List&lt;T&gt;</c> closed generics round-trip with a populated element.
    /// </summary>
    /// <remarks>
    /// An empty list writes as <c>[]</c> without ever consulting element metadata, so a collection
    /// whose element is unregistered round-trips clean while empty and throws the moment a handler
    /// returns a real result. Populating is what makes this able to fail.
    /// </remarks>
    [Fact]
    public void RegisteredCollectionsRoundTripWithARealElement()
    {
        var failures = new SortedSet<string>(StringComparer.Ordinal);
        var covered = 0;

        foreach (var registered in RegisteredTypes())
        {
            if (!registered.IsGenericType ||
                registered.GetGenericTypeDefinition() != typeof(List<>))
            {
                continue;
            }

            var element = registered.GetGenericArguments()[0];
            if (!TryCreateProbe(element, out var item, out _))
            {
                continue;
            }

            var list = (System.Collections.IList)Activator.CreateInstance(registered)!;
            list.Add(item);

            try
            {
                var json = JsonSerializer.Serialize(list, registered, LspJsonContext.Default);
                Assert.NotEqual("[]", json);

                var read = (System.Collections.IList?)JsonSerializer.Deserialize(
                    json, registered, LspJsonContext.Default);

                Assert.NotNull(read);
                Assert.Single(read!);
                covered++;
            }
            catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
            {
                failures.Add($"{Describe(registered)} with one element: " +
                    $"{ex.GetType().Name}: {ex.Message}");
            }
        }

        Assert.True(
            failures.Count == 0,
            "These registered collections cannot carry a populated element across the wire:\n  " +
            string.Join("\n  ", failures));

        Assert.True(covered > 10, $"Expected several populated collections, exercised {covered}.");
    }

    /// <summary>
    /// The bare primitives a handler can return as a whole result round-trip.
    /// </summary>
    /// <remarks>
    /// These are registered precisely because a result is written by its runtime type, so a
    /// handler returning <c>true</c> or a bare string serializes as <c>bool</c>/<c>string</c>
    /// rather than as any DTO. No assembly walk over Lsp classes can see them.
    /// </remarks>
    [Theory]
    [InlineData(typeof(bool))]
    [InlineData(typeof(string))]
    public void BareResultPrimitivesRoundTrip(Type primitive)
    {
        Assert.NotNull(LspJsonContext.Default.GetTypeInfo(primitive));

        object value = primitive == typeof(bool) ? true : "probe";
        var json = JsonSerializer.Serialize(value, primitive, LspJsonContext.Default);
        var read = JsonSerializer.Deserialize(json, primitive, LspJsonContext.Default);

        Assert.Equal(value, read);
    }

    /// <summary>
    /// Enumerates the context's registrations from the context itself, via the
    /// <see cref="JsonTypeInfo{T}"/> properties the source generator emits.
    /// </summary>
    /// <remarks>
    /// Reading the registrations from the generated surface rather than from a hand-maintained
    /// list is the whole point: a list someone has to remember to update samples the context, and
    /// the registration that gets forgotten is the one that breaks.
    /// </remarks>
    private static IEnumerable<Type> RegisteredTypes() =>
        typeof(LspJsonContext)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(property => property.PropertyType)
            .Where(type => type.IsGenericType &&
                type.GetGenericTypeDefinition() == typeof(JsonTypeInfo<>))
            .Select(type => type.GetGenericArguments()[0])
            .Distinct()
            .OrderBy(type => type.FullName, StringComparer.Ordinal);

    /// <summary>
    /// Builds an instance with its string and collection members populated, so that member
    /// metadata is genuinely required rather than skipped as null.
    /// </summary>
    private static bool TryCreateProbe(Type type, out object instance, out string? reason)
    {
        instance = null!;
        reason = null;

        if (type == typeof(string))
        {
            instance = "probe";
            return true;
        }

        if (type == typeof(bool))
        {
            instance = true;
            return true;
        }

        if (type.IsArray)
        {
            reason = "array";
            return false;
        }

        if (type.IsAbstract || type.IsInterface ||
            type.GetConstructor(Type.EmptyTypes) is null)
        {
            reason = "not constructible";
            return false;
        }

        try
        {
            instance = Activator.CreateInstance(type)!;
        }
        catch (Exception ex)
        {
            reason = ex.GetType().Name;
            return false;
        }

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            // An indexer is a property whose setter takes index arguments, so SetValue(obj, value)
            // throws TargetParameterCountException. List<string> is registered and has one.
            if (!property.CanWrite || property.GetIndexParameters().Length != 0)
            {
                continue;
            }

            object? value = property.PropertyType switch
            {
                var t when t == typeof(string) => "probe",
                var t when t == typeof(List<string>) => new List<string> { "probe" },
                var t when t == typeof(string[]) => new[] { "probe" },
                _ => null,
            };

            if (value is null)
            {
                continue;
            }

            try
            {
                property.SetValue(instance, value);
            }
            catch (TargetInvocationException)
            {
                // A validating setter rejecting the probe value is a property-model concern, not a
                // serialization one. Carry on with a partially populated instance rather than
                // dropping the type from coverage entirely.
            }
        }

        return true;
    }

    private static string Describe(Type type) => type.FullName ?? type.Name;

    private static string Clip(string json) =>
        json.Length <= 120 ? json : json[..120] + "...";
}

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

// Complements assembly->context coverage by walking context->wire, catching unusable metadata.
// This sees non-Lsp DTO registrations (List<T>, object[], bool, string) that Native AOT cannot repair with reflection fallback.
// Round-tripping also exercises inbound source-generated metadata, where writable types may still be unreadable.
public class LspJsonContextRoundTripTests
{
    /// <summary>Every registered type can be written and read back with reflection unavailable, as under Native AOT.</summary>
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
                // Some registrations are not constructible here; write-side guards cover them,
                // and the coverage floor keeps these skips from making the test vacuous.
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

        // Keep filter or construction regressions from making the test vacuous while staying green;
        // the floor is below the registration count but far above zero.
        Assert.True(covered > 40, $"Expected broad round-trip coverage, only exercised {covered}.");
    }

    /// <summary>
    /// Registered List&lt;T&gt; closed generics round-trip with a populated element, so element metadata is consulted instead of hidden by an empty [].
    /// </summary>
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

    /// <summary>Round-trips bare primitive results written by runtime type, which no Lsp DTO assembly walk can see.</summary>
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
    /// Enumerates registrations from generated JsonTypeInfo&lt;T&gt; properties, avoiding a hand-maintained list that would miss the forgotten registration.
    /// </summary>
    internal static IEnumerable<Type> RegisteredTypes() =>
        typeof(LspJsonContext)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(property => property.PropertyType)
            .Where(type => type.IsGenericType &&
                type.GetGenericTypeDefinition() == typeof(JsonTypeInfo<>))
            .Select(type => type.GetGenericArguments()[0])
            .Distinct()
            .OrderBy(type => type.FullName, StringComparer.Ordinal);

    /// <summary>Builds an instance with strings and collections populated so member metadata is required, not skipped as null.</summary>
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

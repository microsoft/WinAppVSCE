using System.Reflection;
using System.Text.Json.Serialization;
using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

// The server serializes every outgoing payload by its runtime type through LspJsonContext
// (JsonRpcConnection.WriteValue). Native AOT implies JsonSerializerIsReflectionEnabledByDefault=false,
// so a payload the context has no metadata for does not degrade -- it throws NotSupportedException
// mid-response, which surfaces to the client as a JSON-RPC error on whatever request was in flight.
//
// Because the wire signature is object?, the compiler cannot catch an unregistered payload: it is a
// runtime failure on whichever code path happens to emit that message, which may be a rare error
// branch that no other test exercises. These tests turn that into a build-time failure instead.
public class LspJsonContextCoverageTests
{
    [Fact]
    public void EveryWirePayloadTypeHasSourceGeneratedMetadata()
    {
        var missing = typeof(JsonRpcConnection).Assembly
            .GetTypes()
            .Where(IsWirePayload)
            .Where(type => LspJsonContext.Default.GetTypeInfo(type) is null)
            .Select(type => type.FullName!)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.True(
            missing.Count == 0,
            "These types carry [JsonPropertyName] members but are absent from LspJsonContext, so " +
            "serializing one throws at runtime. Add a [JsonSerializable] entry for each:\n  " +
            string.Join("\n  ", missing));
    }

    [Fact]
    public void NoAnonymousTypesExistInTheServerAssembly()
    {
        // An anonymous type cannot be registered at all -- [JsonSerializable(typeof(...))] needs a
        // nameable type -- so one reaching the wire is unfixable without rewriting the call site.
        var anonymous = typeof(JsonRpcConnection).Assembly
            .GetTypes()
            .Where(type => type.Name.StartsWith("<>f__AnonymousType", StringComparison.Ordinal))
            .Select(type => type.Name)
            .ToList();

        Assert.True(
            anonymous.Count == 0,
            "Anonymous types cannot be registered with the source-generated JSON context. Replace " +
            "them with a named type registered in LspJsonContext:\n  " +
            string.Join("\n  ", anonymous));
    }

    /// <summary>
    /// A handler returning <c>List&lt;T&gt;</c> or <c>T[]</c> serializes by that closed generic
    /// type, not by <c>T</c> -- registering only the element type is not enough.
    /// </summary>
    /// <remarks>
    /// The two tests above cannot see this: a <c>List&lt;CompletionItem&gt;</c> carries no
    /// <c>[JsonPropertyName]</c> of its own and is not an anonymous type, so it passes both while
    /// still throwing on the wire. That is exactly how <c>window/showMessage</c> shipped broken
    /// past 2,000 green tests.
    /// </remarks>
    [Fact]
    public void EveryCollectionOfAWirePayloadIsRegisteredAsAClosedGeneric()
    {
        var payloads = typeof(JsonRpcConnection).Assembly
            .GetTypes()
            .Where(IsWirePayload)
            .ToHashSet();

        var missing = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var payload in payloads)
        {
            foreach (var property in payload.GetProperties(
                BindingFlags.Public | BindingFlags.Instance))
            {
                var candidate = property.PropertyType;
                var element = ElementOf(candidate);
                if (element is null || !payloads.Contains(element))
                {
                    continue;
                }

                if (LspJsonContext.Default.GetTypeInfo(candidate) is null)
                {
                    missing.Add($"{candidate} (on {payload.Name}.{property.Name})");
                }
            }
        }

        Assert.True(
            missing.Count == 0,
            "These collection types reach the wire but are not registered. Registering the " +
            "element type alone does not cover them -- add a [JsonSerializable] entry for the " +
            "closed generic itself:\n  " + string.Join("\n  ", missing));
    }

    private static Type? ElementOf(Type type)
    {
        if (type.IsArray)
        {
            return type.GetElementType();
        }

        if (!type.IsGenericType)
        {
            return null;
        }

        var arguments = type.GetGenericArguments();
        return arguments.Length switch
        {
            1 => arguments[0],
            // Dictionary<string, T> and friends: the value is the payload.
            2 => arguments[1],
            _ => null,
        };
    }

    private static bool IsWirePayload(Type type) =>
        type is { IsClass: true, IsAbstract: false, IsGenericTypeDefinition: false } &&
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Any(property => property.GetCustomAttribute<JsonPropertyNameAttribute>() is not null);
}

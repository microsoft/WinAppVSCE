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

    private static bool IsWirePayload(Type type) =>
        type is { IsClass: true, IsAbstract: false, IsGenericTypeDefinition: false } &&
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Any(property => property.GetCustomAttribute<JsonPropertyNameAttribute>() is not null);
}

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
            "These DTOs live in the Lsp namespace but are absent from LspJsonContext, so " +
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

    /// <summary>
    /// The reflection guards above prove a payload type is registered; they do not prove it can
    /// actually be written. A collection-valued property is where that gap bites -- registering
    /// the owner does not by itself guarantee metadata for the closed generic it holds -- so the
    /// build-required payload is serialized here for real, with reflection unavailable exactly as
    /// it is under Native AOT.
    /// </summary>
    [Fact]
    public void ProjectBuildRequiredPayloadSerializesWithoutReflection()
    {
        var json = System.Text.Json.JsonSerializer.Serialize(
            new ProjectBuildRequiredParams
            {
                ProjectPath = @"C:\src\App\App.csproj",
                UnresolvedAssemblies = ["MiddleLib", "SharedLib"],
            },
            typeof(ProjectBuildRequiredParams),
            LspJsonContext.Default);

        Assert.Contains("\"projectPath\"", json);
        Assert.Contains("MiddleLib", json);
        Assert.Contains("SharedLib", json);
    }

    [Fact]
    public void ProjectBuildRequiredPayloadSerializesWithNoAssembliesNamed()
    {
        var json = System.Text.Json.JsonSerializer.Serialize(
            new ProjectBuildRequiredParams { ProjectPath = @"C:\src\App\App.csproj" },
            typeof(ProjectBuildRequiredParams),
            LspJsonContext.Default);

        Assert.Contains("\"projectPath\"", json);
    }

    /// <summary>
    /// Registration is not writability. The guards above ask whether the context has metadata for
    /// a type; this one asks the only question that matters on the wire -- does writing it throw --
    /// for every payload the server can construct, rather than for the one payload someone
    /// remembered to sample.
    /// </summary>
    /// <remarks>
    /// Collection-valued properties are populated because an empty or null collection can serialize
    /// without ever needing its element metadata, which would let exactly the
    /// <c>window/showMessage</c> defect pass a test that looks exhaustive.
    /// </remarks>
    [Fact]
    public void EveryConstructibleWirePayloadActuallySerializes()
    {
        var failures = new SortedSet<string>(StringComparer.Ordinal);
        var covered = 0;

        foreach (var payload in typeof(JsonRpcConnection).Assembly
            .GetTypes()
            .Where(IsWirePayload)
            .Where(type => type.GetConstructor(Type.EmptyTypes) is not null)
            .OrderBy(type => type.FullName, StringComparer.Ordinal))
        {
            if (LspJsonContext.Default.GetTypeInfo(payload) is null)
            {
                // Already reported by EveryWirePayloadTypeHasSourceGeneratedMetadata.
                continue;
            }

            object instance;
            try
            {
                instance = Activator.CreateInstance(payload)!;
                PopulateStringMembers(instance, payload);
            }
            catch (Exception ex)
            {
                failures.Add($"{payload.FullName} could not be constructed: {ex.GetType().Name}");
                continue;
            }

            try
            {
                System.Text.Json.JsonSerializer.Serialize(instance, payload, LspJsonContext.Default);
                covered++;
            }
            catch (Exception ex)
            {
                failures.Add($"{payload.FullName} threw {ex.GetType().Name}: {ex.Message}");
            }
        }

        Assert.True(
            failures.Count == 0,
            "These payloads are registered but cannot actually be written:\n  " +
            string.Join("\n  ", failures));

        // A construction or filter regression that silently emptied this set would turn the test
        // into a tautology, so the coverage itself is asserted.
        Assert.True(covered > 20, $"Expected broad payload coverage, only exercised {covered}.");
    }

    /// <summary>Gives string-shaped members a value so their metadata is genuinely exercised.</summary>
    private static void PopulateStringMembers(object instance, Type type)
    {
        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
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

            if (value is not null)
            {
                property.SetValue(instance, value);
            }
        }
    }

    private static Type? ElementOf(Type type)
    {        if (type.IsArray)
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

    // A wire payload is any concrete DTO declared in the Lsp namespace. This deliberately does
    // NOT require [JsonPropertyName]: the context sets PropertyNamingPolicy = CamelCase, so a DTO
    // can serialize correctly with no attributes at all. Requiring the attribute made exactly
    // those types invisible to every guard here -- the same shape as the window/showMessage
    // defect, but with the detector switched off.
    private static bool IsWirePayload(Type type) =>
        type is { IsClass: true, IsAbstract: false, IsGenericTypeDefinition: false } &&
        type.Namespace == "WinUiXaml.LanguageServer.Lsp" &&
        !typeof(Exception).IsAssignableFrom(type) &&
        !typeof(JsonSerializerContext).IsAssignableFrom(type) &&
        !IsJsonConverter(type) &&
        !typeof(IDisposable).IsAssignableFrom(type) &&
        !typeof(IAsyncDisposable).IsAssignableFrom(type) &&
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Any(property =>
                property.CanRead &&
                property.SetMethod is { IsPublic: true } &&
                !typeof(Delegate).IsAssignableFrom(property.PropertyType));

    private static bool IsJsonConverter(Type type)
    {
        for (Type? current = type; current is not null; current = current.BaseType)
        {
            if (current == typeof(JsonConverter))
            {
                return true;
            }
        }

        return false;
    }
}

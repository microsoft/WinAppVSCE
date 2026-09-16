using System.Reflection;
using System.Text.Json.Serialization;
using WinUiXaml.LanguageServer.Lsp;

namespace WinUiXaml.LanguageServer.Tests;

// Outgoing payloads serialize by runtime type through LspJsonContext; Native AOT has no reflection fallback.
// Because the wire signature is object?, unregistered payloads fail only on the runtime branch that emits them.
// These tests turn those rare NotSupportedException wire failures into build-time failures.
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
    /// Verifies collection results are registered as closed generics, since List&lt;CompletionItem&gt; can pass DTO/anonymous guards yet still throw on the wire.
    /// </summary>
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
    /// Serializes the build-required payload for real, proving registered owner metadata also covers its collection-valued property under Native AOT.
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
    /// Writes every constructible payload, with collections populated, because registration alone does not prove element metadata works on the wire.
    /// </summary>
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

    // A wire payload is any concrete Lsp DTO, not just types with JsonPropertyName: camelCase policy
    // lets unattributed DTOs serialize, and filtering them out would hide window/showMessage-shaped defects.
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

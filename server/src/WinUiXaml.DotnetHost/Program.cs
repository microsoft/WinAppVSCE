using System.Reflection;
using System.Runtime.Loader;
using System.Runtime.InteropServices;

var buildHostRoot = Path.GetFullPath(
    Path.Combine(AppContext.BaseDirectory, "BuildHost-netcore"));
var assemblyIndex = Array.FindIndex(args, argument =>
{
    if (!argument.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    var candidate = Path.GetFullPath(argument);
    var relative = Path.GetRelativePath(buildHostRoot, candidate);
    return relative.Length > 0 &&
        !Path.IsPathRooted(relative) &&
        !relative.Equals("..", StringComparison.Ordinal) &&
        !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal);
});

if (assemblyIndex < 0)
{
    Console.Error.WriteLine("The bundled dotnet host only runs the WinUI XAML MSBuild BuildHost.");
    return 1;
}

var assemblyPath = Path.GetFullPath(args[assemblyIndex]);
var resolver = new AssemblyDependencyResolver(assemblyPath);
AssemblyLoadContext.Default.Resolving += (_, assemblyName) =>
{
    var dependency = resolver.ResolveAssemblyToPath(assemblyName);
    return dependency is null ? null : AssemblyLoadContext.Default.LoadFromAssemblyPath(dependency);
};
AssemblyLoadContext.Default.ResolvingUnmanagedDll += (_, libraryName) =>
{
    var dependency = resolver.ResolveUnmanagedDllToPath(libraryName);
    return dependency is null ? IntPtr.Zero : NativeLibrary.Load(dependency);
};

var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(assemblyPath);
var entryPoint = assembly.EntryPoint ??
    throw new InvalidOperationException($"BuildHost '{assemblyPath}' has no entry point.");
var buildHostArgs = args.Skip(assemblyIndex + 1).ToArray();
var invocation = entryPoint.GetParameters().Length == 0
    ? entryPoint.Invoke(null, null)
    : entryPoint.Invoke(null, new object?[] { buildHostArgs });

return invocation switch
{
    Task<int> task => await task.ConfigureAwait(false),
    Task task => await AwaitTaskAsync(task).ConfigureAwait(false),
    int exitCode => exitCode,
    _ => 0,
};

static async Task<int> AwaitTaskAsync(Task task)
{
    await task.ConfigureAwait(false);
    return 0;
}

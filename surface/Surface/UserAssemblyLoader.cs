using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;

namespace Surface;

/// <summary>
/// Loads assemblies from the user's build output without holding their files open.
/// <para>
/// <see cref="Assembly.LoadFrom(string)"/> maps the file for the life of the process, so while a preview is
/// open the project's own build fails to overwrite <c>bin\*.dll</c> (MSB3027/MSB3021). Loading an in-memory
/// copy leaves the files writable. Nothing in the host relies on <see cref="Assembly.Location"/>.
/// </para>
/// </summary>
internal static class UserAssemblyLoader
{
    public static Assembly Load(string path) => Load(path, File.ReadAllBytes(path));

    /// <summary>Loads <paramref name="image"/> (the bytes of <paramref name="path"/>, possibly patched).</summary>
    public static Assembly Load(string path, byte[] image)
    {
        // Default ALC refuses a second assembly with the same simple name, so reuse the one already loaded
        // (e.g. a closure library pulled in earlier as a dependency).
        var name = AssemblyName.GetAssemblyName(path).Name;
        var loaded = AssemblyLoadContext.Default.Assemblies.FirstOrDefault(a =>
            string.Equals(a.GetName().Name, name, StringComparison.OrdinalIgnoreCase));
        if (loaded != null)
        {
            return loaded;
        }

        try
        {
            var pdb = Path.ChangeExtension(path, ".pdb");
            using var symbols = File.Exists(pdb) ? new MemoryStream(File.ReadAllBytes(pdb)) : null;
            return AssemblyLoadContext.Default.LoadFromStream(new MemoryStream(image), symbols);
        }
        catch (BadImageFormatException)
        {
            // Mixed-mode (C++/CLI) images can only load from disk.
            return Assembly.LoadFrom(path);
        }
    }
}

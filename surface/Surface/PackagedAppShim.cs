using System;
using System.Collections.Immutable;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Runtime.Loader;

namespace Surface;

/// <summary>
/// Loads a packaged (MSIX-built) user app assembly into a host that has no package identity.
/// <para>
/// A packaged WinUI app gets the Windows App SDK <c>DeploymentManager</c> auto-initializer compiled into
/// its module initializer. It calls <c>DeploymentManager.Initialize()</c>, which throws "The process has
/// no package identity" in an unpackaged host. Because it runs in the module <c>.cctor</c>, every type in
/// the assembly (including the generated XAML metadata provider) becomes unusable.
/// </para>
/// <para>
/// The design host never needs runtime deployment, so when this process has no identity we load an
/// in-memory copy of the assembly where only the call to
/// <c>DeploymentManagerCS.AutoInitialize.AccessWindowsAppSDK()</c> is replaced by <c>nop</c>s. Other
/// initializers (bootstrap, compatibility, user module initializers) still run. The file on disk is never
/// modified. Anything unexpected falls back to the normal <see cref="Assembly.LoadFrom(string)"/>.
/// </para>
/// </summary>
internal static class PackagedAppShim
{
    private const string DeploymentNamespace = "Microsoft.Windows.ApplicationModel.WindowsAppRuntime.DeploymentManagerCS";
    private const string CommonNamespace = "Microsoft.Windows.ApplicationModel.WindowsAppRuntime.Common";
    private const int AppModelErrorNoPackage = 15700;
    private const byte CallOpcode = 0x28;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentPackageFullName(ref uint packageFullNameLength, IntPtr packageFullName);

    internal static bool HasPackageIdentity()
    {
        try
        {
            uint length = 0;
            return GetCurrentPackageFullName(ref length, IntPtr.Zero) != AppModelErrorNoPackage;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>Loads <paramref name="path"/>, neutralizing the deployment auto-initializer when needed.</summary>
    internal static Assembly LoadUserAssembly(string path, Action<string> log)
    {
        if (Environment.GetEnvironmentVariable("WXP_DISABLE_PACKAGED_SHIM") == "1")
        {
            log("Packaged-app shim disabled by WXP_DISABLE_PACKAGED_SHIM (test hook).");
        }
        else if (!HasPackageIdentity())
        {
            try
            {
                var patched = TryNeutralizeDeploymentAutoInit(File.ReadAllBytes(path), out var sites);
                if (patched != null)
                {
                    var assembly = AssemblyLoadContext.Default.LoadFromStream(new MemoryStream(patched));
                    log($"No package identity: loaded '{Path.GetFileName(path)}' with the DeploymentManager auto-initializer disabled ({sites} call site(s)).");
                    return assembly;
                }
            }
            catch (Exception ex)
            {
                log($"No package identity: could not disable the DeploymentManager auto-initializer ({ex.Message}); loading normally.");
            }
        }

        return Assembly.LoadFrom(path);
    }

    /// <summary>
    /// Marker written to stderr when the user assembly can't load for lack of package identity (the shim
    /// didn't apply). The extension reacts by registering the sparse identity and relaunching the bundled host.
    /// </summary>
    internal const string IdentityRequiredMarker = "WXP:IDENTITY-REQUIRED";

    /// <summary>True when <paramref name="ex"/> (or an inner exception) is the "no package identity" failure.</summary>
    internal static bool IsMissingIdentityFailure(Exception? ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e.HResult == unchecked((int)0x80073D54) ||
                e.Message.IndexOf("package identity", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns a copy of <paramref name="image"/> with every <c>call AccessWindowsAppSDK</c> in the module
    /// initializer path replaced by five <c>nop</c>s, or <c>null</c> when the assembly has no deployment
    /// auto-initializer (nothing to do).
    /// </summary>
    internal static byte[]? TryNeutralizeDeploymentAutoInit(byte[] image, out int patchedSites)
    {
        patchedSites = 0;
        using var pe = new PEReader(ImmutableArray.Create(image));
        if (!pe.HasMetadata)
        {
            return null;
        }

        var md = pe.GetMetadataReader();
        var target = FindMethod(md, DeploymentNamespace, "AutoInitialize", "AccessWindowsAppSDK");
        if (target.IsNil)
        {
            return null;
        }

        var token = MetadataTokens.GetToken(target);
        var copy = (byte[])image.Clone();
        foreach (var typeHandle in md.TypeDefinitions)
        {
            var type = md.GetTypeDefinition(typeHandle);
            var ns = md.GetString(type.Namespace);
            var name = md.GetString(type.Name);
            // Newer SDKs call it from Common.AutoInitialize.InitializeWindowsAppSDK; older ones mark it as
            // a [ModuleInitializer] directly, so the call lives in <Module>..cctor.
            if (!(name == "<Module>" || (ns == CommonNamespace && name == "AutoInitialize")))
            {
                continue;
            }

            foreach (var methodHandle in type.GetMethods())
            {
                var method = md.GetMethodDefinition(methodHandle);
                if (method.RelativeVirtualAddress == 0)
                {
                    continue;
                }

                var (ilStart, ilLength) = LocateIl(pe, image, method.RelativeVirtualAddress);
                for (int i = ilStart; i + 5 <= ilStart + ilLength; i++)
                {
                    if (copy[i] == CallOpcode && BitConverter.ToInt32(copy, i + 1) == token)
                    {
                        Array.Clear(copy, i, 5);
                        patchedSites++;
                        i += 4;
                    }
                }
            }
        }

        return patchedSites > 0 ? copy : null;
    }

    private static MethodDefinitionHandle FindMethod(MetadataReader md, string ns, string typeName, string methodName)
    {
        foreach (var typeHandle in md.TypeDefinitions)
        {
            var type = md.GetTypeDefinition(typeHandle);
            if (md.GetString(type.Namespace) != ns || md.GetString(type.Name) != typeName)
            {
                continue;
            }

            foreach (var methodHandle in type.GetMethods())
            {
                if (md.GetString(md.GetMethodDefinition(methodHandle).Name) == methodName)
                {
                    return methodHandle;
                }
            }
        }

        return default;
    }

    private static (int Start, int Length) LocateIl(PEReader pe, byte[] image, int rva)
    {
        var offset = -1;
        foreach (var section in pe.PEHeaders.SectionHeaders)
        {
            if (rva >= section.VirtualAddress && rva < section.VirtualAddress + Math.Max(section.VirtualSize, section.SizeOfRawData))
            {
                offset = rva - section.VirtualAddress + section.PointerToRawData;
                break;
            }
        }

        if (offset < 0 || offset >= image.Length)
        {
            throw new BadImageFormatException("Method body RVA is outside every section.");
        }

        var ilLength = pe.GetMethodBody(rva).GetILBytes().Length;
        // ECMA-335 II.25.4: tiny header is one byte (low bits 0b10); a fat header's size in dwords is the
        // high nibble of its second byte.
        var headerSize = (image[offset] & 0x3) == 0x2 ? 1 : (image[offset + 1] >> 4) * 4;
        var start = offset + headerSize;
        if (start + ilLength > image.Length)
        {
            throw new BadImageFormatException("Method body extends past the image.");
        }

        return (start, ilLength);
    }
}

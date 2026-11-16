#nullable enable

using System;
using System.IO;
using System.Runtime.InteropServices;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// The native architecture the preview host runs as. The extension ships one bundled surface per
    /// architecture (<c>Surface\</c> = x64, <c>Surface-arm64\</c> = ARM64): an x64 surface on an ARM64
    /// machine runs under emulation (markedly slower startup/render) and cannot load the user's ARM64
    /// build of their app assembly. Matched hosts are built for the same architecture.
    /// </summary>
    internal static class HostArch
    {
        public const ushort MachineI386 = 0x014c;
        public const ushort MachineAmd64 = 0x8664;
        public const ushort MachineArm64 = 0xAA64;

        private static readonly Lazy<bool> s_isArm64 = new Lazy<bool>(DetectArm64);

        /// <summary>True when the OS is natively ARM64 (regardless of the calling process's own architecture).</summary>
        public static bool IsArm64 => s_isArm64.Value;

        /// <summary>The bundled-surface folder name (next to WinUIXamlPreview.dll) for this machine.</summary>
        public static string SurfaceDirName => IsArm64 ? "Surface-arm64" : "Surface";

        /// <summary>MSBuild <c>Platform</c> for provisioner-built hosts.</summary>
        public static string Platform => IsArm64 ? "ARM64" : "x64";

        /// <summary>RuntimeIdentifier for provisioner-built hosts.</summary>
        public static string Rid => IsArm64 ? "win-arm64" : "win-x64";

        /// <summary>PE machine type the host loads natively.</summary>
        public static ushort Machine => IsArm64 ? MachineArm64 : MachineAmd64;

        /// <summary>
        /// The bundled surface directory to use: the arch-native one when present, otherwise the x64
        /// <c>Surface\</c> folder (an older/x64-only VSIX still works on ARM64, just emulated).
        /// </summary>
        public static string? BundledSurfaceDir(string extensionDir)
        {
            var native = Path.Combine(extensionDir, SurfaceDirName);
            if (File.Exists(Path.Combine(native, "Surface.exe")))
            {
                return native;
            }

            var x64 = Path.Combine(extensionDir, "Surface");
            return File.Exists(Path.Combine(x64, "Surface.exe")) ? x64 : null;
        }

        /// <summary>
        /// Reads the PE header <c>Machine</c> of <paramref name="path"/>, or null if unreadable. An IL-only
        /// (AnyCPU) assembly reports I386 and loads in either host.
        /// </summary>
        public static ushort? ReadMachine(string path)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var br = new BinaryReader(fs);
                if (fs.Length < 0x40 || br.ReadUInt16() != 0x5A4D)
                {
                    return null;
                }

                fs.Position = 0x3C;
                var peOffset = br.ReadInt32();
                if (peOffset <= 0 || peOffset + 6 > fs.Length)
                {
                    return null;
                }

                fs.Position = peOffset;
                if (br.ReadUInt32() != 0x00004550)
                {
                    return null;
                }

                return br.ReadUInt16();
            }
            catch
            {
                return null;
            }
        }

        /// <summary>True when the host can load <paramref name="dllPath"/> (same machine, AnyCPU, or unknown).</summary>
        public static bool CanHostLoad(string dllPath)
        {
            var machine = ReadMachine(dllPath);
            return machine == null || machine == Machine || (machine == MachineI386 && !IsX86Only(dllPath));
        }

        /// <summary>
        /// BB-024: the build architecture of <paramref name="dllPath"/> when the host can't load it ("x86", "x64",
        /// "ARM64"), else null.
        /// </summary>
        public static string? MismatchedArch(string? dllPath)
        {
            if (string.IsNullOrEmpty(dllPath) || CanHostLoad(dllPath!))
            {
                return null;
            }

            switch (ReadMachine(dllPath!))
            {
                case MachineAmd64: return "x64";
                case MachineArm64: return "ARM64";
                case MachineI386: return "x86";
                default: return null;
            }
        }

        private const uint CorFlags32BitRequired = 0x2;
        private const uint CorFlags32BitPreferred = 0x20000;

        /// <summary>
        /// True for an x86-only managed assembly: an I386 PE whose CLR header requires a 32-bit process (AnyCPU
        /// and AnyCPU-prefer-32-bit also report I386 but load in a 64-bit host). Never throws.
        /// </summary>
        public static bool IsX86Only(string path)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var br = new BinaryReader(fs);
                if (fs.Length < 0x40 || br.ReadUInt16() != 0x5A4D)
                {
                    return false;
                }

                fs.Position = 0x3C;
                var peOffset = br.ReadInt32();
                if (peOffset <= 0 || peOffset + 24 > fs.Length)
                {
                    return false;
                }

                fs.Position = peOffset;
                if (br.ReadUInt32() != 0x00004550 || br.ReadUInt16() != MachineI386)
                {
                    return false;
                }

                var sections = br.ReadUInt16();
                fs.Position += 12;
                var optionalSize = br.ReadUInt16();
                fs.Position += 2;
                var optional = fs.Position;
                if (br.ReadUInt16() != 0x10b) // PE32
                {
                    return false;
                }

                // Data directory 14 (CLR runtime header) of a PE32 optional header.
                var clrDir = optional + 96 + (14 * 8);
                if (clrDir + 8 > optional + optionalSize || clrDir + 8 > fs.Length)
                {
                    return false;
                }

                fs.Position = clrDir;
                var rva = br.ReadUInt32();
                if (rva == 0)
                {
                    return false;
                }

                var table = optional + optionalSize;
                for (var i = 0; i < sections; i++)
                {
                    fs.Position = table + (i * 40) + 8;
                    var virtualSize = br.ReadUInt32();
                    var virtualAddress = br.ReadUInt32();
                    var rawSize = br.ReadUInt32();
                    var rawPointer = br.ReadUInt32();
                    if (rva < virtualAddress || rva >= virtualAddress + Math.Max(virtualSize, rawSize))
                    {
                        continue;
                    }

                    // IMAGE_COR20_HEADER.Flags sits 16 bytes in.
                    var flagsAt = (long)rawPointer + (rva - virtualAddress) + 16;
                    if (flagsAt + 4 > fs.Length)
                    {
                        return false;
                    }

                    fs.Position = flagsAt;
                    var flags = br.ReadUInt32();
                    return (flags & CorFlags32BitRequired) != 0 && (flags & CorFlags32BitPreferred) == 0;
                }

                return false;
            }
            catch
            {
                return false;
            }
        }

        private static bool DetectArm64()
        {
            try
            {
                if (IsWow64Process2(GetCurrentProcess(), out _, out var native))
                {
                    return native == MachineArm64;
                }
            }
            catch (EntryPointNotFoundException)
            {
                // Pre-1709 Windows: no ARM64 desktop support anyway.
            }
            catch
            {
            }

            return false;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
    }
}

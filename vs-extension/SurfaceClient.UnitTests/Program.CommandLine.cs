#nullable enable

using System;
using System.Runtime.InteropServices;
using WinUIXamlPreview.Protocol;

namespace WinUIXamlPreview.UnitTests;

// CommandLine.Quote: paths handed to Surface.exe and the host provisioner must reach them verbatim. Each case
// is round-tripped through Windows' own parser (CommandLineToArgvW), which matches .NET's argv splitting.
internal static partial class Program
{
    private static void CommandLineTests()
    {
        string[] cases =
        {
            @"C:\Users\zteutsch\App\bin\App.dll",
            @"C:\Users\Jane Doe\My Projects\App (v2) & co\bin\App.dll",
            @"C:\Users\Jane Doe\AppData\Local\Temp\wsr-v2\abc\",
            @"C:\cache\",
            @"\\server\share\Some Folder\",
            @"C:\with\tab	inside",
            "C:\\odd\\\"quoted\"\\name",
            @"C:\a\\\b",
            @"C:\ends with two\\",
            "",
            "plain",
        };

        foreach (var c in cases)
        {
            var round = RoundTrip(CommandLine.Quote(c));
            Check($"round-trips: [{c}]", round.Length == 1 && round[0] == c, $"quoted={CommandLine.Quote(c)} -> [{string.Join("|", round)}]");
        }

        // The old SurfaceClient quoting broke on a trailing backslash: "C:\My Dir\" escapes the closing quote.
        var joined = CommandLine.Quote(@"C:\My Dir\") + " --next " + CommandLine.Quote("value");
        var argv = RoundTrip(joined);
        Check("trailing backslash does not swallow the next argument",
            argv.Length == 3 && argv[0] == @"C:\My Dir\" && argv[1] == "--next" && argv[2] == "value", string.Join("|", argv));

        Eq("no spaces: left unquoted", @"C:\x\y.dll", CommandLine.Quote(@"C:\x\y.dll"));
        Eq("spaces: quoted", "\"C:\\a b\\y.dll\"", CommandLine.Quote(@"C:\a b\y.dll"));
        Eq("empty: quoted so it isn't dropped", "\"\"", CommandLine.Quote(""));
    }

    // Parses "prog <args>" so argv[0] handling doesn't affect the arguments under test.
    private static string[] RoundTrip(string args)
    {
        IntPtr p = CommandLineToArgvW("prog.exe " + args, out int n);
        if (p == IntPtr.Zero)
        {
            return Array.Empty<string>();
        }

        try
        {
            var result = new string[n - 1];
            for (int i = 1; i < n; i++)
            {
                result[i - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, i * IntPtr.Size))!;
            }

            return result;
        }
        finally
        {
            LocalFree(p);
        }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string cmdLine, out int numArgs);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr mem);
}

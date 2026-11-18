using System.Text;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Builds Windows command-line arguments that the standard parser (CommandLineToArgvW / the C runtime / .NET)
    /// reads back verbatim. Paths are quoted when they contain spaces, tabs or quotes; backslashes that precede a
    /// quote — including a trailing backslash such as <c>C:\My Dir\</c> — are doubled so they don't escape it.
    /// </summary>
    internal static class CommandLine
    {
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
            {
                return arg;
            }

            var sb = new StringBuilder(arg.Length + 2);
            sb.Append('"');
            int backslashes = 0;
            foreach (char ch in arg)
            {
                if (ch == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (ch == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                }
                else
                {
                    sb.Append('\\', backslashes);
                }

                backslashes = 0;
                sb.Append(ch);
            }

            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }
    }
}

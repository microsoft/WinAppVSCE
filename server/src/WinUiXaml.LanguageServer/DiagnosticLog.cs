using System.Text;

namespace WinUiXaml.LanguageServer;

/// <summary>
/// Optional server-side diagnostics sink. When the <c>WINUI_XAML_LOG</c> environment variable names
/// a file, all <see cref="Console.Error"/> output (the server's log stream) is additionally appended
/// to that file. This gives tests and the red-team loop real visibility into server behavior, which
/// is otherwise trapped in the language client's non-readable output channel.
/// </summary>
internal static class DiagnosticLog
{
    public static void Initialize()
    {
        var path = Environment.GetEnvironmentVariable("WINUI_XAML_LOG");
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            var file = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
            {
                AutoFlush = true,
            };
            Console.SetError(new TeeTextWriter(Console.Error, file));
        }
        catch
        {
            // Logging is best-effort; never let it break the server.
        }
    }

    private sealed class TeeTextWriter(TextWriter primary, TextWriter secondary) : TextWriter
    {
        public override Encoding Encoding => primary.Encoding;

        public override void Write(char value)
        {
            primary.Write(value);
            secondary.Write(value);
        }

        public override void Write(string? value)
        {
            primary.Write(value);
            secondary.Write(value);
        }

        public override void WriteLine(string? value)
        {
            primary.WriteLine(value);
            secondary.WriteLine(value);
        }

        public override void Flush()
        {
            primary.Flush();
            secondary.Flush();
        }
    }
}

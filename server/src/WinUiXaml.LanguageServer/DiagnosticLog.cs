using System.Text;

namespace WinUiXaml.LanguageServer;

/// <summary>Copies server errors to the optional <c>WINUI_XAML_LOG</c> file.</summary>
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

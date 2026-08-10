using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;

// Optional file logging (WINUI_XAML_LOG) — set up before any Console.Error write so nothing is lost.
DiagnosticLog.Initialize();

// Roslyn's netcore MSBuild BuildHost normally starts through a machine-installed `dotnet`. Self-contained bundles include a constrained host shim beside this executable instead.
var bundledDotnetHost = Path.Combine(AppContext.BaseDirectory, "dotnet.exe");
if (File.Exists(bundledDotnetHost))
{
    Environment.SetEnvironmentVariable("DOTNET_HOST_PATH", bundledDotnetHost);
}

// LSP speaks over stdio: stdin carries client->server, stdout carries server->client. All logging must go to stderr so it never corrupts the protocol stream.
using var stdin = Console.OpenStandardInput();
using var stdout = Console.OpenStandardOutput();

var connection = new JsonRpcConnection(stdin, stdout);
using var resolver = new XamlProjectResolver();
_ = new XamlLanguageServer(connection, resolver);

Console.Error.WriteLine("[winui-xaml-ls] ready");
await connection.RunAsync().ConfigureAwait(false);
Console.Error.WriteLine("[winui-xaml-ls] input closed; exiting");

using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;

// Optional file logging (WINUI_XAML_LOG) — set up before any Console.Error write so nothing is lost.
DiagnosticLog.Initialize();

// Register the SDK's MSBuild before any Microsoft.Build type loads, so the resolver's design-time
// builds work. Idempotent; safe to call once at startup.
MsBuildRegistrar.EnsureRegistered();
Console.Error.WriteLine($"[winui-xaml-ls] msbuild: {MsBuildRegistrar.Registered?.MSBuildPath ?? "defaults"}");

// LSP speaks over stdio: stdin carries client->server, stdout carries server->client. All logging
// must go to stderr so it never corrupts the protocol stream.
using var stdin = Console.OpenStandardInput();
using var stdout = Console.OpenStandardOutput();

var connection = new JsonRpcConnection(stdin, stdout);
using var resolver = new XamlProjectResolver();
_ = new XamlLanguageServer(connection, resolver);

Console.Error.WriteLine("[winui-xaml-ls] ready");
await connection.RunAsync().ConfigureAwait(false);
Console.Error.WriteLine("[winui-xaml-ls] input closed; exiting");

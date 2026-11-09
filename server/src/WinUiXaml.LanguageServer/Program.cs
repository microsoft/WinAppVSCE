using System.Text;
using WinUiXaml.LanguageServer;
using WinUiXaml.LanguageServer.Lsp;
using WinUiXaml.Workspace;

// Redirected stderr must use UTF-8 too. LSP stdout uses its own raw byte stream.
Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

// Set up optional file logging before any Console.Error write.
DiagnosticLog.Initialize();

// LSP speaks over stdio: stdin carries client->server, stdout carries server->client. All logging must go to stderr so it never corrupts the protocol stream.
using var stdin = Console.OpenStandardInput();
using var stdout = Console.OpenStandardOutput();

var connection = new JsonRpcConnection(stdin, stdout);
using var resolver = new XamlProjectResolver();
var server = new XamlLanguageServer(connection, resolver);

Console.Error.WriteLine("[winui-xaml-ls] ready");
await connection.RunAsync().ConfigureAwait(false);
Console.Error.WriteLine("[winui-xaml-ls] input closed; exiting");
return server.ExitCode;

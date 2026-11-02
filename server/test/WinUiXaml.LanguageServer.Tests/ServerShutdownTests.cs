using System.Diagnostics;
using System.Text;
using System.Text.Json;
using WinUiXaml.LanguageServer;

namespace WinUiXaml.LanguageServer.Tests;

public sealed class ServerShutdownTests
{
    [Theory]
    [InlineData("shutdown", 0)]
    [InlineData("exit", 1)]
    [InlineData("eof", 1)]
    public async Task ClosingTheServerTerminatesItsProjectLoadChildren(string mode, int expectedCode)
    {
        var root = Path.Combine(Path.GetTempPath(), "winui-shutdown-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var server = new Process();
        bool started = false;
        try
        {
            File.WriteAllText(Path.Combine(root, "wait.ps1"),
                "[IO.File]::WriteAllText((Join-Path $PSScriptRoot \"$PID.pid\"), \"$PID\"); Start-Sleep -Seconds 120");
            File.WriteAllText(Path.Combine(root, "Test.csproj"), """
                <Project>
                  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk"/>
                  <PropertyGroup><TargetFramework>net10.0-windows</TargetFramework><UseWinUI>true</UseWinUI></PropertyGroup>
                  <ItemGroup><PackageReference Include="Microsoft.WindowsAppSDK" Version="2.2.0"/><Page Include="Page.xaml"/></ItemGroup>
                  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk"/>
                  <Target Name="ResolveReferences">
                    <Exec Command="powershell.exe -NoProfile -NonInteractive -File &quot;$(MSBuildProjectDirectory)\wait.ps1&quot;"/>
                  </Target>
                  <Target Name="CoreCompile"/>
                </Project>
                """);
            var xaml = Path.Combine(root, "Page.xaml");
            File.WriteAllText(xaml, "<Page/>");
            var testAssembly = typeof(ServerShutdownTests).Assembly.Location;
            server.StartInfo = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
            {
                ArgumentList =
                {
                    "exec", "--runtimeconfig", Path.ChangeExtension(testAssembly, ".runtimeconfig.json"),
                    "--depsfile", Path.ChangeExtension(testAssembly, ".deps.json"),
                    typeof(XamlLanguageServer).Assembly.Location,
                },
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                UseShellExecute = false, CreateNoWindow = true,
            };
            server.Start();
            started = true;
            var stderr = server.StandardError.ReadToEndAsync();
            await Send(server, new { id = 1, method = "initialize", @params = new { rootUri = new Uri(root + Path.DirectorySeparatorChar).AbsoluteUri } });
            await WaitForResponse(server, 1);
            await Send(server, new { method = "textDocument/didOpen", @params = new
            {
                textDocument = new { uri = new Uri(xaml).AbsoluteUri, languageId = "xaml", version = 1, text = "<Page/>" },
            } });
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while (Directory.GetFiles(root, "*.pid").Length == 0)
            {
                await Task.Delay(50, timeout.Token);
            }
            if (mode == "shutdown")
            {
                await Send(server, new { id = 2, method = "shutdown" });
                await WaitForResponse(server, 2);
            }
            if (mode == "eof")
            {
                server.StandardInput.Close();
            }
            else
            {
                await Send(server, new { method = "exit" });
            }
            await server.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Assert.True(server.ExitCode == expectedCode, await stderr);
            foreach (var file in Directory.GetFiles(root, "*.pid"))
            {
                Assert.False(IsRunning(int.Parse(File.ReadAllText(file))), $"Owned child from {file} survived {mode}.");
            }
        }
        finally
        {
            if (started && !server.HasExited)
            {
                server.Kill(entireProcessTree: true);
                await server.WaitForExitAsync();
            }
            foreach (var file in Directory.GetFiles(root, "*.pid"))
            {
                var id = int.Parse(File.ReadAllText(file));
                if (IsRunning(id))
                {
                    using var child = Process.GetProcessById(id);
                    child.Kill(entireProcessTree: true);
                    await child.WaitForExitAsync();
                }
            }
            Directory.Delete(root, recursive: true);
        }
    }

    private static bool IsRunning(int id)
    {
        try
        {
            using var process = Process.GetProcessById(id);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static async Task Send(Process server, object message)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(message);
        await server.StandardInput.BaseStream.WriteAsync(Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n"));
        await server.StandardInput.BaseStream.WriteAsync(body);
        await server.StandardInput.BaseStream.FlushAsync();
    }

    private static async Task WaitForResponse(Process server, int id)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var stream = server.StandardOutput.BaseStream;
        var one = new byte[1];
        while (true)
        {
            var header = new StringBuilder();
            while (!header.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                await stream.ReadExactlyAsync(one, timeout.Token);
                header.Append((char)one[0]);
            }
            var length = int.Parse(header.ToString().Split("\r\n")[0].Split(':')[1]);
            var body = new byte[length];
            await stream.ReadExactlyAsync(body, timeout.Token);
            using var message = JsonDocument.Parse(body);
            if (message.RootElement.TryGetProperty("id", out var responseId) && responseId.GetInt32() == id)
            {
                Assert.False(message.RootElement.TryGetProperty("error", out _), message.RootElement.ToString());
                return;
            }
        }
    }
}

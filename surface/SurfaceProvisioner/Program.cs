using SurfaceProvisioner;

// stdout is exactly one versioned JSON result. Diagnostics are stderr, in BOTH build and overlay modes.
using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
// net472 clients cannot send Ctrl+C reliably; closing stdin cooperatively cancels their owned build.
if (args.Contains("--cancel-on-stdin"))
    _ = Task.Run(() => { Console.In.ReadToEnd(); cancellation.Cancel(); });
return ProvisionerCommand.Run(args, cancellation.Token, Console.Out, Console.Error.WriteLine);

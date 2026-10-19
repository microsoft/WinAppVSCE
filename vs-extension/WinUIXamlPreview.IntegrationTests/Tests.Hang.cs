using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        /// <summary>
        /// B8: a hung Surface must not leave VS frozen. The reparented window shares VS's input queue, so the
        /// watchdog kills an unresponsive Surface and the preview recovers on a new one.
        /// </summary>
        private static void Group_Hang()
        {
            Run("Hang: an unresponsive Surface is killed and the preview recovers", () =>
            {
                Fresh();
                Process? hung = null;
                try
                {
                    var pid = Pid(Preview(OpenRendered(_fx.MainPage), _fx.MainPage)!, "clientPid");
                    hung = Process.GetProcessById(pid);
                    var mark = LogMark();
                    if (NtSuspendProcess(hung.Handle) != 0) throw new Exception("NtSuspendProcess failed.");

                    WaitForLog(mark, "Surface window stopped responding");
                    WaitFor("hung Surface exited", _ => hung.HasExited, 30_000);
                    WaitFor("recovered on a new Surface", x => Preview(x, _fx.MainPage) is JsonObject p
                                                               && Pid(p, "clientPid") is var c && c != 0 && c != pid
                                                               && Rendered(p), 60_000);
                }
                finally
                {
                    try { if (hung is { HasExited: false }) hung.Kill(); } catch { }
                    Call("closeAll");
                }
            });
        }

        [DllImport("ntdll.dll")]
        private static extern int NtSuspendProcess(IntPtr process);
    }
}

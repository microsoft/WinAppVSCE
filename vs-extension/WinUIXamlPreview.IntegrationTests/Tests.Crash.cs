using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Threading;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        internal static void Kill(int pid)
        {
            try { using var p = Process.GetProcessById(pid); p.Kill(); p.WaitForExit(5_000); }
            catch (ArgumentException) { } // already gone
            catch (InvalidOperationException) { }
        }

        private static int Pid(JsonObject preview, string field) => (int?)preview[field] ?? 0;

        /// <summary>
        /// Kills every surface and spare MainPage gets until the budget runs out. A good render resets the budget,
        /// so each replacement dies before it can render. The last death can land mid-startup, which ends on the
        /// "Could not start" card rather than the reconnect banner; both offer Reload.
        /// </summary>
        private static (JsonObject preview, int killed) ExhaustRestarts()
        {
            var killed = new HashSet<int>();
            var s = WaitFor("restarts exhausted with Reload offered", x =>
            {
                var p = Preview(x, _fx.MainPage);
                if (p == null) return false;
                if (p["restartsExhausted"]!.GetValue<bool>() && p["statusActionVisible"]!.GetValue<bool>()) return true;
                foreach (var f in new[] { "clientPid", "sparePid" })
                {
                    var pid = Pid(p, f);
                    if (pid != 0 && killed.Add(pid)) Kill(pid);
                }
                return false;
            }, 90_000);
            return (Preview(s, _fx.MainPage)!, killed.Count);
        }

        /// <summary>Surface death: auto-recovery, risky-doc recycling, bounded restarts, manual Reload, spare death.</summary>
        private static void Group_Crash()
        {
            Run("Crash: a killed surface recovers automatically on a new process", () =>
            {
                Fresh();
                var pid = Pid(Preview(OpenRendered(_fx.MainPage), _fx.MainPage)!, "clientPid");
                Kill(pid);
                var s = WaitFor("recovered", x => Preview(x, _fx.MainPage) is JsonObject p
                                                 && Pid(p, "clientPid") is var c && c != 0 && c != pid
                                                 && Rendered(p), 60_000);
                var pv = Preview(s, _fx.MainPage)!;
                Eq(true, pv["isRisky"]!.GetValue<bool>(), "document learned as risky");
                Eq(0, (int)pv["restartAttempts"]!, "restart budget reset after a good render");
                Eq(false, pv["reconnectShown"]!.GetValue<bool>(), "reconnect banner");
            });

            Run("Crash: edits to a risky document recycle onto the warm spare", () =>
            {
                Fresh();
                var pid = Pid(Preview(OpenRendered(_fx.MainPage), _fx.MainPage)!, "clientPid");
                Kill(pid);
                var s = WaitFor("recovered with a ready spare", x => Preview(x, _fx.MainPage) is JsonObject p
                                                                    && Pid(p, "clientPid") != pid && Rendered(p)
                                                                    && p["spareReady"]!.GetValue<bool>(), 60_000);
                var before = Pid(Preview(s, _fx.MainPage)!, "clientPid");
                var spare = Pid(Preview(s, _fx.MainPage)!, "sparePid");
                var mark = LogMark();
                Edit(_fx.MainPage, "Hello preview", "Risky edit");
                WaitForLog(mark, "recycled onto the warm spare");
                s = WaitFor("rendered on the promoted spare", x => Preview(x, _fx.MainPage) is JsonObject p
                                                                  && Pid(p, "clientPid") == spare && Rendered(p), 30_000);
                var end = DateTime.UtcNow.AddSeconds(15);
                while (DateTime.UtcNow < end && IsAlive(before)) Thread.Sleep(200);
                Assert(!IsAlive(before), $"recycled surface {before} still running");
            });

            Run("Crash: repeated deaths before a render exhaust the restart budget", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                var (pv, killed) = ExhaustRestarts();
                Eq("Preview disconnected", (string?)pv["statusText"], "terminal status");
                Eq(true, pv["reconnectShown"]!.GetValue<bool>(), "reconnect card shown");
                Eq(false, pv["statusSpinner"]!.GetValue<bool>(), "spinner stopped");
                Assert(killed >= 4, $"only {killed} surfaces were killed");
            });

            Run("Crash: Reload from the disconnected state starts a fresh session", () =>
            {
                Fresh();
                OpenRendered(_fx.MainPage);
                ExhaustRestarts();
                Call("click", new { path = _fx.MainPage, automationId = "PreviewReconnectReload" });
                var s = WaitFor("recovered", x => Preview(x, _fx.MainPage) is JsonObject p && Rendered(p)
                                                 && !p["reconnectShown"]!.GetValue<bool>(), 60_000);
                var pv = Preview(s, _fx.MainPage)!;
                Eq(0, (int)pv["restartAttempts"]!, "restart attempts");
                Eq(false, pv["restartsExhausted"]!.GetValue<bool>(), "restarts exhausted");
            });

            Run("Crash: a dead spare does not disturb the active preview", () =>
            {
                Fresh();
                Call("open", new { path = _fx.MainPage });
                var s = WaitFor("spare ready", x => Preview(x, _fx.MainPage) is JsonObject p && Rendered(p) && p["spareReady"]!.GetValue<bool>(), 60_000);
                var pid = Pid(Preview(s, _fx.MainPage)!, "clientPid");
                Kill(Pid(Preview(s, _fx.MainPage)!, "sparePid"));
                Holds("active surface untouched", x => Preview(x, _fx.MainPage) is JsonObject p && Pid(p, "clientPid") == pid
                                                       && Rendered(p) && !p["reconnectShown"]!.GetValue<bool>(), 3_000);
                Eq(0, (int)Preview(Snap(), _fx.MainPage)!["restartAttempts"]!, "restart attempts");
            });
        }
    }
}

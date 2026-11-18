using System.IO;
using System.Text.Json.Nodes;

namespace WinUIXamlPreview.IntegrationTests
{
    internal static partial class Program
    {
        /// <summary>B8: a restore or rebuild of the previewed project relaunches the preview (no reopen needed).</summary>
        private static void Group_Rebuild()
        {
            var obj = Path.Combine(_fx.WinUiDir, "obj");

            Run("Rebuild: a restore while open relaunches the preview and re-checks the version", () =>
            {
                Fresh();
                if (Directory.Exists(obj)) Directory.Delete(obj, recursive: true);
                try
                {
                    var pid = Pid(Preview(OpenRendered(_fx.MainPage), _fx.MainPage)!, "clientPid");
                    var mark = LogMark();
                    Directory.CreateDirectory(obj);
                    File.WriteAllText(Path.Combine(obj, "project.assets.json"), "{\"version\":3,\"libraries\":{}}");
                    WaitForLog(mark, "Project restore changed");
                    WaitForLog(mark, "WASDK discovery");
                    WaitFor("relaunched and rendered", x => Preview(x, _fx.MainPage) is JsonObject p
                                                           && Pid(p, "clientPid") is var c && c != 0 && c != pid
                                                           && Rendered(p), 60_000);

                    // A rewrite that leaves the file unchanged doesn't restart anything.
                    var now = Pid(Preview(Snap(), _fx.MainPage)!, "clientPid");
                    var assets = Path.Combine(obj, "project.assets.json");
                    var stamp = File.GetLastWriteTimeUtc(assets);
                    File.WriteAllText(assets, File.ReadAllText(assets));
                    File.SetLastWriteTimeUtc(assets, stamp);
                    Holds("no restart for an unchanged rewrite", x => Preview(x, _fx.MainPage) is JsonObject p
                                                                      && Pid(p, "clientPid") == now, 5_000);
                }
                finally
                {
                    Call("closeAll");
                    if (Directory.Exists(obj)) Directory.Delete(obj, recursive: true);
                }
            });
        }
    }
}

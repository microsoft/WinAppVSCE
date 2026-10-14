using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.TextManager.Interop;
using Newtonsoft.Json.Linq;
using Task = System.Threading.Tasks.Task;

namespace WinUIXamlPreview.TestAgent
{
    /// <summary>
    /// Test-only automation agent. When VS is launched with WINUI_PREVIEW_TEST_PIPE=&lt;name&gt; it serves one
    /// client at a time on that named pipe: one JSON request per line in, one JSON response per line out
    /// (<c>{"ok":true,"result":...}</c> / <c>{"ok":false,"error":"..."}</c>). Every command runs on the UI thread.
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid("6b0c3a4e-2f5d-4b8e-9a51-7c3e2d9f1a60")]
    public sealed class TestAgentPackage : AsyncPackage
    {
        private const string PipeEnv = "WINUI_PREVIEW_TEST_PIPE";
        private static readonly Guid ProductPackageGuid = new Guid("d4245f7f-5871-4a4d-97c1-84595921b383");

        private string? _pipeName;
        private Type? _hooks;

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            _pipeName = Environment.GetEnvironmentVariable(PipeEnv);
            if (string.IsNullOrEmpty(_pipeName))
            {
                return;
            }

            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            var thread = new System.Threading.Thread(ServeLoop) { IsBackground = true, Name = "WinUIPreviewTestAgent" };
            thread.Start();
        }

        private void ServeLoop()
        {
            while (true)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream(_pipeName!, PipeDirection.InOut, 1, PipeTransmissionMode.Byte);
                    pipe.WaitForConnection();
                    using var reader = new StreamReader(pipe, new UTF8Encoding(false));
                    using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
                    string? line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        JObject response;
                        try
                        {
                            var req = JObject.Parse(line);
                            var result = ThreadHelper.JoinableTaskFactory.Run(async () =>
                            {
                                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                                return Dispatch(req);
                            });
                            response = new JObject { ["ok"] = true, ["result"] = result };
                        }
                        catch (Exception ex)
                        {
                            var inner = ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                            response = new JObject { ["ok"] = false, ["error"] = inner.GetType().Name + ": " + inner.Message };
                        }
                        writer.WriteLine(response.ToString(Newtonsoft.Json.Formatting.None));
                        if ((string?)JObject.Parse(line)["cmd"] == "quit")
                        {
                            return;
                        }
                    }
                }
                catch (Exception)
                {
                    System.Threading.Thread.Sleep(200);
                }
            }
        }

        // ---------------------------------------------------------------------------------------------------
        // Commands (UI thread)
        // ---------------------------------------------------------------------------------------------------

        private JToken? Dispatch(JObject req)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var cmd = (string?)req["cmd"] ?? throw new ArgumentException("missing cmd");
            switch (cmd)
            {
                case "ping": return "pong";
                case "snapshot": return JToken.Parse((string)Hooks().GetMethod("Snapshot", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null)!);
                case "resetOptions": Hooks().GetMethod("ResetOptions", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null); return true;
                case "setOption": return SetOption(Str(req, "name"), req["value"]!);
                case "open": return Open(Str(req, "path"));
                case "isOpen": return VsShellUtilities.IsDocumentOpen(this, Str(req, "path"), Guid.Empty, out _, out _, out _);
                case "close": return Close(Str(req, "path"), (bool?)req["save"] ?? false);
                case "closeAll": Dte().Documents.CloseAll(vsSaveChanges.vsSaveChangesNo); return RevertDirtyDocData();
                case "activate": return Activate(Str(req, "path"));
                case "text": return View(Str(req, "path")).TextBuffer.CurrentSnapshot.GetText();
                case "setText": return Replace(Str(req, "path"), 0, -1, Str(req, "text"));
                case "replace": return Replace(Str(req, "path"), (int)req["start"]!, (int)req["length"]!, Str(req, "text"));
                case "caret": return MoveCaret(Str(req, "path"), (int)req["offset"]!);
                case "viewInfo":
                {
                    var v = View(Str(req, "path"));
                    return new JObject
                    {
                        ["contentType"] = v.TextBuffer.ContentType.TypeName,
                        ["baseTypes"] = new JArray(v.TextBuffer.ContentType.BaseTypes.Select(b => b.TypeName)),
                        ["roles"] = new JArray(v.Roles.Select(r => r)),
                        ["view"] = v.GetType().FullName,
                    };
                }
                case "projects":
                {
                    var sol = Dte().Solution;
                    var arr = new JArray();
                    if (sol != null && sol.IsOpen)
                    {
                        foreach (Project p in sol.Projects)
                        {
                            string? full = null;
                            try { full = p.FullName; } catch { }
                            arr.Add(new JObject { ["name"] = p.Name, ["fullName"] = full, ["kind"] = p.Kind });
                        }
                    }
                    return arr;
                }
                case "caretOf": return View(Str(req, "path")).Caret.Position.BufferPosition.Position;
                case "save": return Save(Str(req, "path"), (string?)req["newPath"]);
                case "click": return Click((string?)req["path"], Str(req, "automationId"));
                case "menu": return Menu((string?)req["path"], Str(req, "button"), Str(req, "item"));
                case "find": return Find((string?)req["path"], Str(req, "automationId")) is FrameworkElement fe ? Describe(fe) : null;
                case "designerSelect":
                    return (bool)Hooks().GetMethod("SimulateDesignerSelection", BindingFlags.Public | BindingFlags.Static)!
                        .Invoke(null, new object[] { Str(req, "path"), Str(req, "elementPath") })!;
                case "raise": return Raise(Str(req, "guid"), (int)req["id"]!);
                case "dteCommand": Dte().ExecuteCommand(Str(req, "name"), (string?)req["args"] ?? ""); return true;
                case "toolWindowVisible": return ToolWindowVisible(Str(req, "guid"));
                case "quit":
                    Dte().Documents.CloseAll(vsSaveChanges.vsSaveChangesNo);
                    try { Dte().Solution.Close(false); } catch { }
                    _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
                    {
                        await Task.Delay(300);
                        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                        Dte().Quit();
                    });
                    return true;
                default: throw new ArgumentException("unknown cmd " + cmd);
            }
        }

        private static string Str(JObject req, string name) => (string?)req[name] ?? throw new ArgumentException("missing " + name);

        private DTE2 Dte() => (DTE2)GetGlobalService(typeof(SDTE));

        // Closing a tab without saving doesn't always discard the buffer: a loaded project can keep the doc
        // data alive (dirty) in the RDT, and reopening shows the stale edits. Reload any such doc from disk.
        private int RevertDirtyDocData()
        {
            var rdt = (IVsRunningDocumentTable)GetGlobalService(typeof(SVsRunningDocumentTable));
            if (rdt.GetRunningDocumentsEnum(out var docs) != 0 || docs == null)
            {
                return 0;
            }

            var reverted = 0;
            var cookie = new uint[1];
            while (docs.Next(1, cookie, out var fetched) == 0 && fetched == 1)
            {
                rdt.GetDocumentInfo(cookie[0], out _, out _, out _, out var moniker, out _, out _, out var punk);
                if (punk == IntPtr.Zero)
                {
                    continue;
                }

                try
                {
                    if (Marshal.GetObjectForIUnknown(punk) is IVsPersistDocData data
                        && data.IsDocDataDirty(out var dirty) == 0 && dirty != 0)
                    {
                        data.ReloadDocData(0);
                        reverted++;
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Revert {moniker} failed: {ex.Message}");
                }
                finally
                {
                    Marshal.Release(punk);
                }
            }

            return reverted;
        }

        private Type Hooks()
        {
            if (_hooks != null)
            {
                return _hooks;
            }

            var asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "WinUIXamlPreview");
            if (asm == null)
            {
                var shell = (IVsShell)GetGlobalService(typeof(SVsShell));
                var guid = ProductPackageGuid;
                shell.LoadPackage(ref guid, out _);
                asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "WinUIXamlPreview")
                    ?? throw new InvalidOperationException("WinUIXamlPreview assembly not loaded");
            }

            _hooks = asm.GetType("WinUIXamlPreview.Testing.TestHooks", throwOnError: true)!;
            return _hooks;
        }

        /// <summary>Sets a persisted <c>WinUIXamlPreview.Editor.PreviewOptions</c> property (as a new session would see it).</summary>
        private bool SetOption(string name, JToken value)
        {
            var options = Hooks().Assembly.GetType("WinUIXamlPreview.Editor.PreviewOptions", throwOnError: true)!;
            var prop = options.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                ?? throw new ArgumentException("no option " + name);
            object converted = prop.PropertyType.IsEnum
                ? Enum.Parse(prop.PropertyType, (string)value!)
                : value.ToObject(prop.PropertyType)!;
            prop.SetValue(null, converted);
            return true;
        }

        private bool Open(string path)
        {
            VsShellUtilities.OpenDocument(this, path, Guid.Empty, out _, out _, out var frame);
            frame?.Show();
            return frame != null;
        }

        private IVsWindowFrame Frame(string path)
        {
            if (!VsShellUtilities.IsDocumentOpen(this, path, Guid.Empty, out _, out _, out var frame) || frame == null)
            {
                throw new InvalidOperationException("not open: " + path);
            }
            return frame;
        }

        private bool Close(string path, bool save)
        {
            if (!VsShellUtilities.IsDocumentOpen(this, path, Guid.Empty, out _, out _, out var frame) || frame == null)
            {
                return false;
            }
            frame.CloseFrame((uint)(save ? __FRAMECLOSE.FRAMECLOSE_SaveIfDirty : __FRAMECLOSE.FRAMECLOSE_NoSave));
            return true;
        }

        private bool Activate(string path)
        {
            Frame(path).Show();
            return true;
        }

        private IWpfTextView View(string path)
        {
            var vsView = VsShellUtilities.GetTextView(Frame(path)) ?? throw new InvalidOperationException("no text view: " + path);
            var cm = (IComponentModel)GetGlobalService(typeof(SComponentModel));
            return cm.GetService<IVsEditorAdaptersFactoryService>().GetWpfTextView(vsView)
                ?? throw new InvalidOperationException("no wpf view: " + path);
        }

        private bool Replace(string path, int start, int length, string text)
        {
            var buffer = View(path).TextBuffer;
            var snap = buffer.CurrentSnapshot;
            if (length < 0)
            {
                length = snap.Length - start;
            }
            buffer.Replace(new Span(start, length), text);
            return true;
        }

        private int MoveCaret(string path, int offset)
        {
            var view = View(path);
            var snap = view.TextBuffer.CurrentSnapshot;
            var point = new SnapshotPoint(snap, Math.Max(0, Math.Min(offset, snap.Length)));
            view.Selection.Clear();
            view.Caret.MoveTo(point);
            return point.Position;
        }

        private bool Save(string path, string? newPath)
        {
            var doc = Dte().Documents.Cast<Document>().FirstOrDefault(d => string.Equals(d.FullName, path, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException("no DTE document: " + path);
            if (string.IsNullOrEmpty(newPath))
            {
                doc.Save();
            }
            else
            {
                doc.Save(newPath);
            }
            return true;
        }

        private IEnumerable<DependencyObject> Roots(string? path)
        {
            if (!string.IsNullOrEmpty(path))
            {
                var root = Hooks().GetMethod("MarginRoot", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, new object[] { path! }) as DependencyObject;
                if (root == null)
                {
                    throw new InvalidOperationException("no margin for " + path);
                }
                yield return root;
                yield break;
            }

            foreach (PresentationSource src in PresentationSource.CurrentSources)
            {
                if (src.RootVisual != null)
                {
                    yield return src.RootVisual;
                }
            }
        }

        private static IEnumerable<DependencyObject> Walk(DependencyObject root)
        {
            var stack = new Stack<DependencyObject>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var node = stack.Pop();
                yield return node;
                int n = node is Visual || node is System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetChildrenCount(node) : 0;
                for (int i = n - 1; i >= 0; i--)
                {
                    stack.Push(VisualTreeHelper.GetChild(node, i));
                }
            }
        }

        private FrameworkElement? Find(string? path, string automationId)
        {
            FrameworkElement? fallback = null;
            foreach (var root in Roots(path))
            {
                foreach (var node in Walk(root))
                {
                    if (node is FrameworkElement fe && AutomationProperties.GetAutomationId(fe) == automationId)
                    {
                        if (fe.IsVisible)
                        {
                            return fe;
                        }
                        fallback ??= fe;
                    }
                }
            }
            return fallback;
        }

        private static JObject Describe(FrameworkElement fe) => new JObject
        {
            ["type"] = fe.GetType().Name,
            ["visible"] = fe.IsVisible,
            ["enabled"] = fe.IsEnabled,
            ["name"] = AutomationProperties.GetName(fe),
            ["checked"] = fe is ToggleButton tb ? tb.IsChecked : null,
        };

        private JObject Click(string? path, string automationId)
        {
            var fe = Find(path, automationId) ?? throw new InvalidOperationException("not found: " + automationId);
            if (!fe.IsEnabled)
            {
                throw new InvalidOperationException("disabled: " + automationId);
            }

            if (fe is ToggleButton toggle)
            {
                // OnClick flips IsChecked and raises Click, matching a real user click.
                typeof(ButtonBase).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(toggle, null);
            }
            else if (fe is ButtonBase button)
            {
                typeof(ButtonBase).GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(button, null);
            }
            else if (fe is MenuItem mi)
            {
                mi.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent, mi));
            }
            else
            {
                throw new InvalidOperationException("not clickable: " + fe.GetType().Name);
            }
            return Describe(fe);
        }

        private bool Menu(string? path, string buttonId, string itemId)
        {
            var button = Find(path, buttonId) ?? throw new InvalidOperationException("not found: " + buttonId);
            var menu = button.ContextMenu ?? throw new InvalidOperationException("no context menu: " + buttonId);
            var item = FindMenuItem(menu.Items, itemId) ?? throw new InvalidOperationException("no menu item: " + itemId);
            item.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent, item));
            return true;
        }

        private static MenuItem? FindMenuItem(ItemCollection items, string id)
        {
            foreach (var o in items)
            {
                if (o is MenuItem mi)
                {
                    if (AutomationProperties.GetAutomationId(mi) == id)
                    {
                        return mi;
                    }
                    var nested = FindMenuItem(mi.Items, id);
                    if (nested != null)
                    {
                        return nested;
                    }
                }
            }
            return null;
        }

        private bool Raise(string guid, int id)
        {
            object? customIn = null, customOut = null;
            Dte().Commands.Raise("{" + new Guid(guid).ToString().ToUpperInvariant() + "}", id, ref customIn, ref customOut);
            return true;
        }

        private bool ToolWindowVisible(string guid)
        {
            var shell = (IVsUIShell)GetGlobalService(typeof(SVsUIShell));
            var g = new Guid(guid);
            if (shell.FindToolWindow((uint)__VSFINDTOOLWIN.FTW_fFindFirst, ref g, out var frame) != 0 || frame == null)
            {
                return false;
            }
            return frame.IsVisible() == 0;
        }
    }
}

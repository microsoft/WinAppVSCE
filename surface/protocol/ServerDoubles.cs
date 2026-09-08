// Test-only boundaries. FrameServer is linked unchanged; WinUI, rendering, hit-testing,
// property conversion and HWND management are NOT exercised by this harness.
namespace Microsoft.UI.Dispatching
{
    internal sealed class DispatcherQueue
    {
        public static bool Reject { get; set; }
        public static DispatcherQueue GetForCurrentThread() => new();
        public bool TryEnqueue(Action callback)
        {
            if (Reject) return false;
            callback();
            return true;
        }
    }
}

namespace Surface
{
    internal static class App
    {
        public static void Log(string message) { }
    }

    internal sealed class RenderHost
    {
        public event Action<DesignSelectionPayload>? SelectionChanged;
        public event Action<DesignSelectionPayload>? PropsRefreshed;
        public (string Xaml, double Width, double Height, double Scale)? LastRender;
        public (string Xaml, bool Prepare)? LastHost;
        public (double, double)? Canvas;
        public bool Design;
        public bool Restored;
        public string? Path;
        public (double X, double Y)? Point;
        public (int Id, string Name, string Value)? Property;
        public int Renders;
        public int Hosts;
        public RenderResult Render = new()
        {
            Success = true,
            Image = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="),
            Width = 1, Height = 1, DipWidth = 1, DipHeight = 1,
        };
        public LiveResult Live = new()
        {
            Success = true, Hwnd = new IntPtr(4294967297),
            DipWidth = 640, DipHeight = 480, PixelWidth = 800, PixelHeight = 600, DpiScale = 1.25,
        };
        public Task<RenderResult> RenderAsync(string xaml, double width, double height, double scale)
        {
            LastRender = (xaml, width, height, scale);
            Renders++;
            return Task.FromResult(Render);
        }
        public Task<LiveResult> HostLiveAsync(string xaml, bool prepareWindow)
        {
            LastHost = (xaml, prepareWindow);
            Hosts++;
            return Task.FromResult(Live);
        }
        public void RestoreRenderWindowOffscreen() => Restored = true;
        public void SetDesignMode(bool design) => Design = design;
        public bool SelectByPath(string? path) { Path = path; return false; }
        public bool PickAt(double x, double y) { Point = (x, y); return false; }
        public bool SetProperty(int id, string name, string value) { Property = (id, name, value); return false; }
        public void SetCanvasSizeOverride((double, double)? size) => Canvas = size;
        public Dictionary<string, string> CollectContentProps() => new() { ["ControlExample"] = "Example", ["Card"] = "Body" };
        public void Select(DesignSelectionPayload payload) => SelectionChanged?.Invoke(payload);
        public void Refresh(DesignSelectionPayload payload) => PropsRefreshed?.Invoke(payload);
    }

    internal sealed class RenderResult
    {
        public bool Success { get; init; }
        public byte[]? Image { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        public int DipWidth { get; init; }
        public int DipHeight { get; init; }
        public string? Phase { get; init; }
        public string? Message { get; init; }
        public int? Line { get; init; }
        public int? Column { get; init; }
        public bool NotDesignable { get; init; }
        public static RenderResult Fail(string phase, string message) => new() { Phase = phase, Message = message };
    }

    internal sealed class LiveResult
    {
        public bool Success { get; init; }
        public IntPtr Hwnd { get; init; }
        public int DipWidth { get; init; }
        public int DipHeight { get; init; }
        public int PixelWidth { get; init; }
        public int PixelHeight { get; init; }
        public double DpiScale { get; init; }
        public string? Phase { get; init; }
        public string? Message { get; init; }
        public int? Line { get; init; }
        public int? Column { get; init; }
        public bool NotDesignable { get; init; }
        public static LiveResult Fail(string phase, string message) => new() { Phase = phase, Message = message };
    }

    internal sealed class DesignSelectionPayload
    {
        public int Id;
        public string TypeName = "";
        public string? Name;
        public string? Path;
        public double X;
        public double Y;
        public double W;
        public double H;
        public List<DesignPropInfo> Props = new();
    }

    internal sealed class DesignPropInfo
    {
        public string Name = "";
        public string Category = "";
        public string TypeName = "";
        public string Value = "";
        public bool ReadOnly;
        public List<string>? Options;
    }
}

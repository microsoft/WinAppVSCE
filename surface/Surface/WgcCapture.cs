using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using WinRT;

namespace Surface;

/// <summary>
/// S5 Part 2 — a minimal <c>Windows.Graphics.Capture</c> (WGC) path for the warm render window,
/// used ONLY by the <c>--wgc</c> benchmark. It answers the feasibility question: can a DXGI/DWM
/// screen-capture grab our HEADLESS (cloaked / off-screen) render window, and is its capture→CPU
/// cost cheaper than the RTB GPU→CPU readback? The default live path keeps using RTB regardless.
///
/// <para>The interop is deliberately tiny: <c>D3D11CreateDevice</c> (P/Invoke) to build a Direct3D
/// device, one source-generated <c>IGraphicsCaptureItemInterop</c> to turn an HWND into a
/// <see cref="GraphicsCaptureItem"/>, and the WinRT helper
/// <see cref="SoftwareBitmap.CreateCopyFromSurfaceAsync"/> for the GPU→CPU copy (so we don't
/// hand-roll a staging texture). Adapted from public samples (e.g. the pattern in
/// <c>microsoft/winappCli</c>'s <c>WgcCapture.cs</c>) — clean-room, no VS designer source.</para>
///
/// Every failure mode (unsupported, item-creation failure, frame timeout, blank frame) is returned
/// in <see cref="WgcResult"/> rather than thrown, so the benchmark can record a precise finding.
/// </summary>
internal static partial class WgcCapture
{
    private static readonly Guid GraphicsCaptureItemGuid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid GraphicsCaptureItemInteropGuid = new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
    private static readonly Guid DxgiDeviceGuid = new("54EC77FA-1377-44E6-8C32-88FD5F44C84C");

    private const uint D3D_DRIVER_TYPE_HARDWARE = 1;
    private const uint D3D_DRIVER_TYPE_WARP = 5;
    private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
    private const uint D3D11_SDK_VERSION = 7;

    /// <summary>Whether this OS/session advertises WGC support (false ⇒ clean negative result).</summary>
    internal static bool IsSupported()
    {
        try { return GraphicsCaptureSession.IsSupported(); }
        catch { return false; }
    }

    /// <summary>Outcome of one WGC capture attempt, incl. the honest capture→CPU sub-timings.</summary>
    internal sealed class WgcResult
    {
        public bool Success { get; set; }
        public string? Error { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Blank { get; set; }
        public string DeviceKind { get; set; } = "";
        public byte[]? Pixels { get; set; }        // BGRA8
        public double SetupMs { get; set; }        // device + item + pool + session + StartCapture (one-time)
        public double FirstFrameMs { get; set; }   // StartCapture -> first FrameArrived delivered
        public double ReadbackMs { get; set; }     // CreateCopyFromSurfaceAsync + CopyToBuffer (GPU->CPU)
    }

    /// <summary>
    /// One-shot capture of <paramref name="hwnd"/>: fresh D3D device + frame pool + session, wait up
    /// to <paramref name="timeoutMs"/> for the first frame, then copy it to CPU (BGRA8). A fresh
    /// session per call is intentional — it reliably delivers one frame of the window's CURRENT
    /// composed content even for a static scene (a reused session on a static window can starve).
    /// </summary>
    internal static async Task<WgcResult> CaptureWindowAsync(IntPtr hwnd, int timeoutMs)
    {
        var r = new WgcResult();
        if (!IsSupported())
        {
            r.Error = "GraphicsCaptureSession.IsSupported()=false";
            return r;
        }

        IDirect3DDevice? device = null;
        Direct3D11CaptureFramePool? pool = null;
        GraphicsCaptureSession? session = null;
        long tSetup = Stopwatch.GetTimestamp();
        try
        {
            device = CreateDirect3DDevice(out var deviceKind);
            r.DeviceKind = deviceKind;

            var item = CreateItemForWindow(hwnd);
            var size = item.Size;
            if (size.Width <= 0 || size.Height <= 0)
            {
                r.Error = $"GraphicsCaptureItem.Size empty ({size.Width}x{size.Height})";
                return r;
            }

            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device, DirectXPixelFormat.B8G8R8A8UIntNormalized, numberOfBuffers: 2, size);
            session = pool.CreateCaptureSession(item);
            try { session.IsCursorCaptureEnabled = false; } catch { /* older builds */ }
            try { session.IsBorderRequired = false; } catch { /* needs capability / newer OS */ }

            var tcs = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
            TypedEventHandler<Direct3D11CaptureFramePool, object> handler = (sender, _) =>
            {
                try
                {
                    var f = sender.TryGetNextFrame();
                    if (f is null) return;
                    if (!tcs.TrySetResult(f)) f.Dispose();
                }
                catch (Exception ex) { tcs.TrySetException(ex); }
            };
            pool.FrameArrived += handler;

            long tFrame = Stopwatch.GetTimestamp();
            session.StartCapture();
            r.SetupMs = RenderHost.ElapsedMs(tSetup);

            using var cts = new CancellationTokenSource(timeoutMs);
            Direct3D11CaptureFrame frame;
            try
            {
                frame = await tcs.Task.WaitAsync(cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                r.Error = $"no frame within {timeoutMs}ms (window not composed by DWM?)";
                return r;
            }
            r.FirstFrameMs = RenderHost.ElapsedMs(tFrame);

            using (frame)
            {
                long tRead = Stopwatch.GetTimestamp();
                using var raw = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface).AsTask().ConfigureAwait(false);
                SoftwareBitmap bgra = raw.BitmapPixelFormat == BitmapPixelFormat.Bgra8
                    ? raw
                    : SoftwareBitmap.Convert(raw, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
                int w = bgra.PixelWidth, h = bgra.PixelHeight;
                var pixels = new byte[checked(w * h * 4)];
                bgra.CopyToBuffer(pixels.AsBuffer());
                r.ReadbackMs = RenderHost.ElapsedMs(tRead);
                if (!ReferenceEquals(bgra, raw)) bgra.Dispose();

                r.Width = w;
                r.Height = h;
                r.Pixels = pixels;
                r.Blank = IsBlank(pixels);
                r.Success = true;
            }
            return r;
        }
        catch (Exception ex)
        {
            r.Error = ex.GetType().Name + ": " + ex.Message;
            return r;
        }
        finally
        {
            try { session?.Dispose(); } catch { }
            try { pool?.Dispose(); } catch { }
            (device as IDisposable)?.Dispose();
        }
    }

    /// <summary>
    /// Build a WinRT <see cref="IDirect3DDevice"/> over a fresh D3D11 device. Tries a hardware device
    /// first, then falls back to WARP (software) — important on headless / VM / RDP hosts with no GPU.
    /// </summary>
    private static IDirect3DDevice CreateDirect3DDevice(out string kind)
    {
        if (TryCreateDevice(D3D_DRIVER_TYPE_HARDWARE, out var dev))
        {
            kind = "hardware";
            return dev!;
        }
        if (TryCreateDevice(D3D_DRIVER_TYPE_WARP, out dev))
        {
            kind = "warp";
            return dev!;
        }
        throw new COMException("D3D11CreateDevice failed for both HARDWARE and WARP driver types.");
    }

    private static unsafe bool TryCreateDevice(uint driverType, out IDirect3DDevice? device)
    {
        device = null;
        IntPtr devicePtr = IntPtr.Zero, contextPtr = IntPtr.Zero, dxgiPtr = IntPtr.Zero, inspectablePtr = IntPtr.Zero;
        try
        {
            int hr = D3D11CreateDevice(
                IntPtr.Zero, driverType, IntPtr.Zero, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                IntPtr.Zero, 0, D3D11_SDK_VERSION,
                out devicePtr, out _, out contextPtr);
            if (hr < 0 || devicePtr == IntPtr.Zero) return false;

            int qi = Marshal.QueryInterface(devicePtr, in DxgiDeviceGuid, out dxgiPtr);
            if (qi < 0) return false;

            int cr = CreateDirect3D11DeviceFromDXGIDevice(dxgiPtr, out inspectablePtr);
            if (cr < 0 || inspectablePtr == IntPtr.Zero) return false;

            // FromAbi takes ownership of the IInspectable*; null the local so finally won't release it.
            device = MarshalInspectable<IDirect3DDevice>.FromAbi(inspectablePtr);
            inspectablePtr = IntPtr.Zero;
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (inspectablePtr != IntPtr.Zero) Marshal.Release(inspectablePtr);
            if (dxgiPtr != IntPtr.Zero) Marshal.Release(dxgiPtr);
            // The WinRT IDirect3DDevice holds its own ref on the underlying device, so releasing our
            // raw device/context refs here is safe.
            if (contextPtr != IntPtr.Zero) Marshal.Release(contextPtr);
            if (devicePtr != IntPtr.Zero) Marshal.Release(devicePtr);
        }
    }

    private static unsafe GraphicsCaptureItem CreateItemForWindow(IntPtr hwnd)
    {
        using var factory = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");
        IntPtr interopPtr = IntPtr.Zero, itemPtr = IntPtr.Zero;
        try
        {
            Marshal.QueryInterface(factory.ThisPtr, in GraphicsCaptureItemInteropGuid, out interopPtr)
                .ThrowIfNeg("QueryInterface(IGraphicsCaptureItemInterop)");

            var interop = ComInterfaceMarshaller<IGraphicsCaptureItemInterop>.ConvertToManaged((void*)interopPtr)!;
            interopPtr = IntPtr.Zero; // ownership transferred to the managed wrapper

            interop.CreateForWindow(hwnd, in GraphicsCaptureItemGuid, out itemPtr)
                .ThrowIfNeg("IGraphicsCaptureItemInterop.CreateForWindow");

            var item = MarshalInspectable<GraphicsCaptureItem>.FromAbi(itemPtr);
            itemPtr = IntPtr.Zero;
            return item;
        }
        finally
        {
            if (itemPtr != IntPtr.Zero) Marshal.Release(itemPtr);
            if (interopPtr != IntPtr.Zero) ComInterfaceMarshaller<IGraphicsCaptureItemInterop>.Free((void*)interopPtr);
        }
    }

    private static bool IsBlank(byte[] pixels)
    {
        var span = MemoryMarshal.Cast<byte, long>(pixels.AsSpan());
        foreach (var chunk in span)
        {
            if (chunk != 0) return false;
        }
        for (int i = span.Length * sizeof(long); i < pixels.Length; i++)
        {
            if (pixels[i] != 0) return false;
        }
        return true;
    }

    private static void ThrowIfNeg(this int hr, string op)
    {
        if (hr < 0) throw new COMException($"{op} failed with HRESULT 0x{hr:X8}.", hr);
    }

    [LibraryImport("d3d11.dll")]
    private static partial int D3D11CreateDevice(
        IntPtr pAdapter, uint driverType, IntPtr software, uint flags,
        IntPtr pFeatureLevels, uint featureLevels, uint sdkVersion,
        out IntPtr ppDevice, out uint pFeatureLevel, out IntPtr ppImmediateContext);

    [LibraryImport("d3d11.dll")]
    private static partial int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [GeneratedComInterface]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    internal partial interface IGraphicsCaptureItemInterop
    {
        [PreserveSig]
        int CreateForWindow(IntPtr window, in Guid iid, out IntPtr result);

        [PreserveSig]
        int CreateForMonitor(IntPtr monitor, in Guid iid, out IntPtr result);
    }
}

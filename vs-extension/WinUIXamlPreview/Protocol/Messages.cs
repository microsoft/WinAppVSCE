#nullable enable

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace WinUIXamlPreview.Protocol
{
    /// <summary>
    /// Newline-delimited JSON wire protocol for the WinUI visualizer surface. Kept in lockstep
    /// with <c>client/src/visualizer/protocol.ts</c> and the surface's <c>FrameServer</c>.
    /// Image frames are base64 (no embedded newlines) so newline framing is safe.
    /// </summary>
    internal static class Wire
    {
        public const int ProtocolVersion = 1;
    }

    // ---- Client -> Surface --------------------------------------------------

    internal sealed class HelloMsg
    {
        [JsonPropertyName("type")] public string Type => "Hello";
        [JsonPropertyName("client")] public string Client { get; set; } = "vs";
        [JsonPropertyName("caps")] public string[] Caps { get; set; } = new[] { "frame-stream", "native-hwnd" };
        [JsonPropertyName("protocol")] public int Protocol { get; set; } = Wire.ProtocolVersion;
    }

    internal sealed class LoadXamlMsg
    {
        [JsonPropertyName("type")] public string Type => "LoadXaml";
        [JsonPropertyName("xaml")] public string Xaml { get; set; } = "";
        [JsonPropertyName("width")] public int Width { get; set; }
        [JsonPropertyName("height")] public int Height { get; set; }
        [JsonPropertyName("scale")] public double Scale { get; set; }
    }

    internal sealed class UpdateXamlMsg
    {
        [JsonPropertyName("type")] public string Type => "UpdateXaml";
        [JsonPropertyName("xaml")] public string Xaml { get; set; } = "";
    }

    internal sealed class ResizeMsg
    {
        [JsonPropertyName("type")] public string Type => "Resize";
        [JsonPropertyName("width")] public int Width { get; set; }
        [JsonPropertyName("height")] public int Height { get; set; }
        [JsonPropertyName("scale")] public double Scale { get; set; }
    }

    /// <summary>
    /// Enter native-HWND mode: the surface hosts the document live in its warm window and returns the
    /// window's HWND (an <see cref="HwndMsg"/>) for the client to reparent into the tool window.
    /// </summary>
    internal sealed class EnterNativeMsg
    {
        [JsonPropertyName("type")] public string Type => "EnterNative";
        [JsonPropertyName("xaml")] public string Xaml { get; set; } = "";
        [JsonPropertyName("width")] public double Width { get; set; }
        [JsonPropertyName("height")] public double Height { get; set; }
        [JsonPropertyName("scale")] public double Scale { get; set; }
    }

    /// <summary>Leave native mode: the surface re-cloaks its window off-screen and resumes frame mode.</summary>
    internal sealed class ExitNativeMsg
    {
        [JsonPropertyName("type")] public string Type => "ExitNative";
    }

    /// <summary>
    /// Toggle the design surface between "design" (clicks select an element) and "interact" (clicks reach
    /// the live content). A runtime toggle — the surface applies it live to the mounted design surface with
    /// no re-render (plan §41).
    /// </summary>
    internal sealed class SetModeMsg
    {
        [JsonPropertyName("type")] public string Type => "SetMode";
        [JsonPropertyName("design")] public bool Design { get; set; }
    }

    /// <summary>
    /// Client -> surface: select the element at an authored-tree index path (editor caret -> designer, plan
    /// §41 #2). The client computes the path from the XAML source; the surface resolves it to a live element
    /// and replies with the usual <see cref="SelectedMsg"/>/props.
    /// </summary>
    internal sealed class SelectByPathMsg
    {
        [JsonPropertyName("type")] public string Type => "SelectByPath";
        [JsonPropertyName("path")] public string? Path { get; set; }
    }

    /// <summary>
    /// Client -> surface: TEST-ONLY (bug D3 regression). Headless equivalent of a design-mode pointer click at
    /// (<see cref="X"/>, <see cref="Y"/>) in artboard/host DIP coordinates. The surface runs its real
    /// PickForClick path and replies with the usual <see cref="SelectedMsg"/>. Not sent by the production VS
    /// margin; the D3 UI test uses it to assert point -> element selection without synthesizing pointer input.
    /// </summary>
    internal sealed class PickAtMsg
    {
        [JsonPropertyName("type")] public string Type => "PickAt";
        [JsonPropertyName("x")] public double X { get; set; }
        [JsonPropertyName("y")] public double Y { get; set; }
    }

    /// <summary>
    /// Client -> surface: apply a live property edit from the panel to the element with the given id (plan §41
    /// Phase C). The surface converts <see cref="Value"/> to the property's type, sets it on the live element,
    /// and replies with a fresh <see cref="ElementPropsMsg"/> (applied value, or reverted if it didn't convert).
    /// </summary>
    internal sealed class SetPropertyMsg
    {
        [JsonPropertyName("type")] public string Type => "SetProperty";
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("value")] public string? Value { get; set; }
    }

    /// <summary>
    /// Client -> surface: preview the mounted page under a different theme (Light/Dark/Default). The surface
    /// applies it live to the mounted design canvas's <c>RequestedTheme</c> (<c>{ThemeResource}</c> brushes
    /// re-resolve) with no re-render, and persists it so subsequent re-hosts keep the chosen theme.
    /// </summary>
    internal sealed class SetThemeMsg
    {
        [JsonPropertyName("type")] public string Type => "SetTheme";
        [JsonPropertyName("theme")] public string Theme { get; set; } = "Light"; // Light | Dark | Default
    }

    /// <summary>
    /// Client -> surface: override the design-canvas size to a device preset so the page lays out at a fixed
    /// artboard size (the WPF/Blend "device" presets). <see cref="Width"/>/<see cref="Height"/> &lt;= 0 clears
    /// the override (auto — the page's own size / default canvas). The surface re-hosts and replies with a
    /// fresh <see cref="HwndMsg"/>; the design surface re-fits the new board into the pane.
    /// </summary>
    internal sealed class SetCanvasSizeMsg
    {
        [JsonPropertyName("type")] public string Type => "SetCanvasSize";
        [JsonPropertyName("width")] public double Width { get; set; }
        [JsonPropertyName("height")] public double Height { get; set; }
    }

    // ---- Surface -> Client --------------------------------------------------

    internal sealed class ReadyMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("protocol")] public int Protocol { get; set; }
        [JsonPropertyName("caps")] public List<string>? Caps { get; set; }
        [JsonPropertyName("wasdk")] public string? Wasdk { get; set; }
    }

    internal sealed class FrameMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("format")] public string? Format { get; set; }

        /// <summary>Encoded pixel dimensions (supersampled: dip * outputScale).</summary>
        [JsonPropertyName("width")] public int Width { get; set; }
        [JsonPropertyName("height")] public int Height { get; set; }

        /// <summary>Logical design size in DIPs — the size to DISPLAY the image at.</summary>
        [JsonPropertyName("dipWidth")] public int DipWidth { get; set; }
        [JsonPropertyName("dipHeight")] public int DipHeight { get; set; }

        [JsonPropertyName("data")] public string? Data { get; set; }
    }

    internal sealed class ErrorMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("phase")] public string? Phase { get; set; }
        [JsonPropertyName("message")] public string? Message { get; set; }
        [JsonPropertyName("line")] public int? Line { get; set; }
        [JsonPropertyName("column")] public int? Column { get; set; }

        /// <summary>P1: true when this is a structurally non-designable root (ResourceDictionary/Window/
        /// template placeholder), not a broken preview — the UI can show a "not a page" note instead of an error.</summary>
        [JsonPropertyName("notDesignable")] public bool NotDesignable { get; set; }
    }

    /// <summary>
    /// Native-mode reply: the HWND of the live surface window to reparent, plus its logical (DIP) and
    /// physical (pixel) size and the surface's DPI scale so the client can size its host ~1:1.
    /// </summary>
    internal sealed class HwndMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("hwnd")] public long Hwnd { get; set; }
        [JsonPropertyName("dipWidth")] public double DipWidth { get; set; }
        [JsonPropertyName("dipHeight")] public double DipHeight { get; set; }
        [JsonPropertyName("pixelWidth")] public int PixelWidth { get; set; }
        [JsonPropertyName("pixelHeight")] public int PixelHeight { get; set; }
        [JsonPropertyName("scale")] public double Scale { get; set; }
    }

    /// <summary>Acknowledgement that the surface left native mode (window re-cloaked off-screen).</summary>
    internal sealed class NativeExitedMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
    }

    /// <summary>
    /// Surface -> client: the user picked an element in the design surface (plan §41). Carries the element's
    /// runtime id (stable for the mounted document), type, optional x:Name, and the adorner bounds (in
    /// artboard coordinates — echoed for reference; the adorner itself is drawn in the surface window).
    /// </summary>
    internal sealed class SelectedMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("elementType")] public string? ElementType { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("path")] public string? Path { get; set; }
        [JsonPropertyName("x")] public double X { get; set; }
        [JsonPropertyName("y")] public double Y { get; set; }
        [JsonPropertyName("w")] public double W { get; set; }
        [JsonPropertyName("h")] public double H { get; set; }
    }

    /// <summary>A single reflected property row for the design-time property panel.</summary>
    internal sealed class PropItemMsg
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("category")] public string? Category { get; set; }
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("value")] public string? Value { get; set; }
        [JsonPropertyName("readOnly")] public bool ReadOnly { get; set; }
        [JsonPropertyName("options")] public List<string>? Options { get; set; }
    }

    /// <summary>Surface -> client: the reflected property rows for the just-selected element (id matches).</summary>
    internal sealed class ElementPropsMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("props")] public List<PropItemMsg>? Props { get; set; }
    }

    /// <summary>
    /// Surface -> client: the authored subtree's CUSTOM content-property names, keyed by simple runtime type
    /// name -> content-property name (e.g. <c>{ "ControlExample": "Example" }</c>) — bug D1. The client feeds
    /// this into <c>XamlSourceMap</c> so it recurses into explicit property elements
    /// (<c>&lt;controls:ControlExample.Example&gt;</c>) and derives the SAME authored-tree paths the surface
    /// does. Only non-standard content properties are sent ({Children, Content, Child, Items} are implicit).
    /// Sent after each (re)host. Kept in lockstep with the surface's <c>FrameServer</c> and
    /// <c>client/src/visualizer/protocol.ts</c>.
    /// </summary>
    internal sealed class ContentPropsMsg
    {
        [JsonPropertyName("type")] public string? Type { get; set; }        // "ContentProps"
        [JsonPropertyName("map")] public Dictionary<string, string>? Map { get; set; } // simpleTypeName -> contentPropName
    }
}

# Surface wire contract — version 1

This is the shared, **descriptive** contract for the existing Surface process and
its IDE clients. It does not introduce a new protocol version, change the
renderer, or wire a new client into either extension.

Authority, in order:

1. `surface\Surface\FrameServer.cs`: actual command dispatch and server serialization.
2. `vs-extension\WinUIXamlPreview\Protocol\Messages.cs`: existing C# DTOs.
3. `vs-extension\WinUIXamlPreview\Protocol\SurfaceClient.cs` and `LineDecoder.cs`:
   existing C# transport, dispatch, and default behavior.

`protocol.ts` names the canonical message shapes for future TypeScript consumers.
It is not a runtime validator or a replacement transport. All strings and JSON
property names below are case-sensitive on the wire. Additional object fields
are allowed for forward compatibility. The test-only shape oracle checks valid
canonical messages; it is deliberately stricter than several legacy receivers.

## Transport and process boundary

- Surface listens on **127.0.0.1**, an ephemeral TCP port, and accepts **one client**.
  Stdout announces `SURFACE_PORT=<decimal-port>` on its own line and is flushed;
  diagnostics go to stderr. This announcement is not a JSON message.
- Each socket record is a UTF-8 JSON object followed by LF (`\n`), without a BOM.
  Readers also tolerate CRLF. A TCP read may contain part of a UTF-8 character,
  part of a record, or many records. Do not equate socket reads with messages.
- Embedded markup, quotes, backslashes, and newlines are JSON-escaped. Frame data
  is unwrapped base64, not raw image bytes or a data URL. Both serializers preserve
  content, but C# client escaping and the server's relaxed escaping need not be
  byte-identical. JSON object member order is not significant.
- Surface trims lines and skips blank lines. Its `StreamReader.ReadLine` can
  process a final nonterminated line at EOF. The C# client's `LineDecoder` emits
  only LF-terminated lines: a partial tail at disconnect is not dispatched.
- There is no message-length limit, authentication handshake, compression,
  batch envelope, request ID, document ID, sequence number, cancellation message,
  retry protocol, or reconnect/resume protocol in v1.
- Socket disconnect ends the real Surface process. Stdin EOF causes shutdown only
  if stdin previously delivered bytes; an immediately closed/ignored stdin does
  not. Process launch, loading user assemblies, provisioner/cache behavior, and
  binary/version selection are outside the JSON contract.
- The C# client has a caller-supplied startup timeout and reports transport/process
  closure locally through `Closed`; these are not wire messages. It sends no
  automatic heartbeat. Surface serializes individual writes with a lock. The C#
  client does not provide a send lock: callers should serialize their writes.

## Handshake and capabilities

Recommended first exchange:

```json
{"type":"Hello","client":"vs","caps":["frame-stream","native-hwnd"],"protocol":1,"minProtocol":1}
{"type":"Ready","protocol":1,"minProtocol":1,"caps":["frame-stream","native-hwnd"],"wasdk":"2.2.0"}
```

`Hello.client` is an informational string and `caps` a string array; FrameServer
does not inspect them. `protocol` is the newest version a side speaks and
`minProtocol` the oldest it still speaks (both integers, both optional on the wire).

**Negotiation rule** (`isCompatible` in `protocol.ts`, `Wire.IsCompatible` in
`Messages.cs`, `FrameServer.IsCompatible`; one shared table in `fixtures.json`
drives all three): two peers are compatible when each side's `protocol` is at least
the other side's `minProtocol`. A missing or nonpositive `protocol` means legacy
v1; a missing `minProtocol` means the peer only speaks its own `protocol` (a
`minProtocol` above `protocol` is clamped to it). Adding `minProtocol` is
additive, so it did not bump the version: pre-negotiation peers still interoperate
as v1.

- **Surface** checks Hello. Compatible: `Ready` with its own range. Incompatible:
  an `Error` with phase `protocol` **instead of** Ready; the connection stays open,
  but the client must not proceed. Surface still accepts commands before Hello and
  answers repeated Hellos.
- **SurfaceClient** checks Ready. Incompatible, or a `protocol`-phase Error at any
  time, faults the client permanently (`IsProtocolMismatch`, a
  `SurfaceProtocolException` from `StartAsync`, one `Closed`). It never raises
  `Ready`/`Error` events for those. The VS UI shows a clear incompatibility
  message and does **not** auto-restart, since relaunching the same exe can't help.

In practice a mismatch only happens with a `WINUI_SURFACE_EXE` override pointing
at a different build: bundled and version-matched hosts are built from the engine
source shipped in the same VSIX.

`Ready` always includes `protocol`, `minProtocol`, `caps`, and `wasdk` in the
current server; legacy surfaces omit `minProtocol`.
`frame-stream` means PNG frame replies; `native-hwnd` means native-window hosting.
Capabilities are advertisements, not an intersection negotiated from Hello; there
are no separate selection/property/theme flags or capability gates in dispatch.
Ignore unknown capability names. Absence of `native-hwnd` should prevent a
consumer choosing native hosting; do not infer support from a version string.

`wasdk` is the Windows App SDK version the surface binary was **built against**:
`Surface.csproj` stamps `$(WinUISurfaceWasdkVersion)` into an
`AssemblyMetadata("WinUISurfaceWasdkVersion", …)` attribute that FrameServer reads
(`"unknown"` if absent). The bundled host reports 2.2.0; a provisioned matched
host reports its target version. It is build metadata, not a probe of the WASDK
runtime actually loaded. The VS client logs it and warns if a matched host
reports a version other than the one it was built for.

## Client → Surface messages

Every row includes a required exact string `type`. `?` means the field may be
omitted by a sender; receiver behavior for omission, null, or invalid input is
spelled out rather than inferred from C# property types.

| Type | Other fields | Actual behavior / reply |
| --- | --- | --- |
| `Hello` | `client?: string`, `caps?: string[]`, `protocol?: integer`, `minProtocol?: integer` | `Ready`, or `Error` phase `protocol` when no version is shared (see Handshake). `client`/`caps` ignored. |
| `Ping` | none | `Pong`. No production C# Ping DTO/public send method. |
| `LoadXaml` | `xaml: string`, `width?: number`, `height?: number`, `scale?: number`, `sampleData?: boolean` | Save XAML and viewport; `Frame` or `Error`. **Always uses frame rendering, even while native mode is set**, and does not clear the native flag. |
| `UpdateXaml` | `xaml: string`, `sampleData?: boolean` | Save XAML; reuse saved viewport. Frame mode: `Frame`/`Error`. Native mode: rehost with `prepareWindow=false`, then `Hwnd` + `ContentProps`, or `Error`. Extra size fields are ignored. A prior LoadXaml is not required. |
| `Resize` | `width?: number`, `height?: number`, `scale?: number` | Update saved viewport. Render a `Frame`/`Error` only when a document exists and native mode is off. With no document, store silently. Native mode stores values but sends no reply and does not resize the live child. |
| `EnterNative` | `xaml: string`, `width?: number`, `height?: number`, `scale?: number`, `sampleData?: boolean`, `paneWidthPx?: integer`, `paneHeightPx?: integer`, `view?: { fit: boolean, zoom: number, offsetX: number, offsetY: number }` | Save document/viewport, set native flag **before** hosting, call host with `prepareWindow=true`. `paneWidthPx`/`paneHeightPx` are the final pane size in device pixels so the canvas fits before reparenting (positive values only; else no hint). `view` restores zoom/scroll carried from a replaced surface (absent = zoom to fit; `fit` must be JSON `true`; nonpositive zoom/offsets fall back to 1/0). The C# client echoes a received `View` message here, so `view` may also carry `type: "View"`. Success: `Hwnd` then `ContentProps`; failure: `Error` (native flag remains set). |
| `ExitNative` | none | Clear native flag, enqueue offscreen restoration, send `NativeExited`. No automatic frame. Ack is sent even if dispatcher rejects restoration; it is not proof the window was restored. |
| `SetMode` | `design?: boolean` | Only JSON `true` enables design selection; everything else disables it. Enqueue runtime mode change; no ack/frame. |
| `SelectByPath` | `path?: string \| null` | String forwarded; absent/null/non-string becomes null. A newly resolved selection can emit `Selected` then `ElementProps`. Unresolved, empty, stale, or already-selected paths need not emit anything. |
| `PickAt` | `x: number`, `y: number` | **Test-only** headless pick in artboard/host DIP coordinates. Negative/fractional coordinates are accepted. A hit can cause selection events; a miss is silent. Not sent by production VS UI. |
| `SetProperty` | `id: integer`, `name: string`, `value?: string \| null` | Require nonnegative Int32 ID and nonempty name. Missing/null/non-string value becomes `""`. Forward a live edit; a host property refresh emits `ElementProps` only, not `Selected` or `Frame`. There is no success ack. |
| `SetTheme` | `theme?: string` (convention: `Light`, `Dark`, `Default`) | **Compatibility no-op**, only logged. Missing/non-string becomes `"Light"` for logging. Change themes by relaunching with `SURFACE_THEME`; DTO/client comments claiming live application are stale. |
| `SetCanvasSize` | `width?: number`, `height?: number` | Both positive numbers set the design-canvas override; otherwise clear **both** dimensions to auto. Rehost/reply only when native mode and a document are present. Frame mode stores the override silently for the next render. |

### Viewport and default distinctions

FrameServer starts with no document, frame mode, and saved width **800**, height
**600**, scale **1.0**. For LoadXaml, EnterNative, and Resize, each positive JSON
number independently replaces its saved value. Missing, null, wrong-kind, zero,
or negative values preserve it. Fractional sizes are accepted by the server.
Send finite numbers; the helper only checks `> 0`, not `IsFinite`, so very large
JSON exponents are not a supported validation/normalization mechanism.

`sampleData` (WS2-F6) on LoadXaml, UpdateXaml, and EnterNative is sticky server state,
initially **true**. A JSON boolean replaces it before the document is hosted; absent or
non-boolean values keep it. When true, `{x:Bind}` text properties render a placeholder
and bound lists get dummy rows; when false, `{x:Bind}` attributes are dropped. The C#
DTOs use `bool?` and omit the field when null.

These are **server state defaults**, not DTO construction defaults:

- `LoadXamlMsg`/`ResizeMsg` use Int32 width/height and double scale, all initially
  **0**, and serialize those zeros (the server interprets them as “keep previous”).
- `EnterNativeMsg` uses double width/height/scale, also initially 0.
- XAML DTO strings default to `""`; an explicitly empty XAML string passes the
  wire check and may then fail renderer parsing. Missing/null/non-string XAML is
  a protocol parse error, despite what a default-constructed DTO might supply.
- `SetModeMsg.Design` defaults false; `SetThemeMsg.Theme` defaults `"Light"`;
  nullable request path/name/value fields default null. Default serialization
  includes nulls and zeros; no “omit default values” options are configured.

Viewport size is **not a promise about returned design-canvas size**. RenderHost
chooses the canvas from an explicit device override, authored page/design sizes,
or its default canvas; incoming panel width/height are non-authoritative.
Requested scale affects frame raster density (subject to renderer clamping).
Native hosting uses the host's DPI and canvas sizing, not the saved request
scale; the saved viewport can still affect a subsequent frame request.

## Surface → client messages

All listed fields are present in current FrameServer output unless explicitly
marked otherwise. Nullable and optional are distinct: `null` is a JSON value,
while an omitted member is absent. The TypeScript types permit the documented
optional compatibility fields.

| Type | Fields and meaning |
| --- | --- |
| `Ready` | `protocol: integer`, `minProtocol?: integer` (always sent by current surfaces), `caps: string[]`, `wasdk: string` (build-time WASDK). See Handshake. |
| `Pong` | Only `type`. C# client deliberately discards it; no Pong DTO/event. |
| `Frame` | `format: "png"`; `width`, `height`: encoded pixel integer dimensions; `dipWidth`, `dipHeight`: logical display integer dimensions; `data: string`: base64 PNG. Display using DIP dimensions, not encoded pixels. Frames are full replacements, not deltas. Old JPEG comments are not authoritative. |
| `Error` | `phase: string`, `message: string`; `line`, `column`: nullable integers; `notDesignable?: boolean`. See below. |
| `Hwnd` | `hwnd`: JSON signed Int64; `dipWidth`, `dipHeight`: logical dimensions (current host emits integers; C# DTO accepts doubles); `pixelWidth`, `pixelHeight`: integer device-pixel dimensions; `scale`: host DPI scale. This is a native OS window handle, **not image data**. |
| `NativeExited` | Only `type`. It acknowledges the exit request, with the dispatcher caveat above. |
| `Selected` | `id: integer`, `elementType: string`, `name: string \| null`, `path: string \| null`, `x`, `y`, `w`, `h`: numeric artboard bounds in DIPs. `name` is optional authored x:Name; `path` may be unresolved. Receivers can tolerate omission of name/path. |
| `ElementProps` | `id: integer`, `props: PropItem[]` (may be empty). ID identifies the described runtime element. |
| `ContentProps` | `map: { [simpleRuntimeTypeName: string]: contentPropertyName }` (may be empty), e.g. `{"ControlExample":"Example"}`. Sent after successful native (re)hosting, following Hwnd. If collection fails the server sends an empty map; if collection cannot be enqueued, it sends no ContentProps. |
| `View` | `fit: boolean`, `zoom: number`, `offsetX: number`, `offsetY: number`. Unsolicited, native mode only: the design surface's zoom/scroll changed. The client stores the latest value and sends it back as `EnterNative.view` when it swaps processes, so zoom survives a recycle. |

Each `PropItem` includes `name`, `category`, `type`, `value` (all strings),
`readOnly: boolean`, and `options: string[] | null`. `type` here is the reflected
property type, **not** a message discriminator. `value` is formatted text even
for numeric and boolean properties; options are enum/boolean choice strings
(`"True"`, `"False"`), or null for free text. Consumers may tolerate omitted
options. Read-only status and choices guide editing; do not coerce values to
JSON booleans/numbers when sending SetProperty.

The native client owns reparenting and physical child placement. Resize in
native mode does not perform that work for it. Handles belong to the current
process lifetime: do not persist or reuse them after disconnect/relaunch.
C# preserves the full Int64 number; JavaScript `number` does not. A JS consumer
must reject `!Number.isSafeInteger(hwnd)` before native interop (or use an
explicit lossless JSON strategy). v1 has **no decimal-string HWND alternative**.
Do not use 32-bit bitwise coercion even for safe integers.

### Errors and tolerant parsing

- Known phases: `parse` (wire/XAML parsing), `activation` (user type activation),
  `render` (rendering/hosting/infrastructure failure), `nonpage` (structurally
  non-designable root), `protocol` (Hello rejected: no shared protocol version;
  fatal for the connection, see Handshake). Preserve/display unknown phase strings.
- Renderer/host failure replies include nullable `line`/`column` and a boolean
  `notDesignable`, including false. `nonpage` with true represents a
  ResourceDictionary/Window/template-like root that is not a designable page,
  not necessarily malformed XAML. Coordinates are renderer-supplied diagnostic
  positions; the wire performs no source-map correction.
- FrameServer's generic error helper emits `line: null`, `column: null` and
  **omits `notDesignable`**. C# deserializes the missing bool as false. Missing
  diagnostic coordinates deserialize as null. Do not require notDesignable
  to be present or infer “not a page” from arbitrary error text.
- Missing/non-string `type`, unknown command names, missing XAML, and explicit
  semantic validation failures produce helper errors with phase `parse`.
- Malformed JSON or a non-object root hits the outer read-loop catch, producing
  phase **`render`**, message prefixed `"Server error: "`. This is not uniformly a
  `parse` error. Wrong JSON kinds for PickAt coordinates or SetProperty ID can
  also throw from `TryGetDouble`/`TryGetInt32` and follow that path. Missing
  coordinates or numeric non-Int32 IDs follow their explicit parse-error paths.
  Exception text is implementation/runtime-dependent, not a stable error code.
- Extra fields are ignored by FrameServer and C# DTO readers. Unknown commands
  are **not** ignored by the server; they get an Error. Unknown server types
  are logged and ignored by SurfaceClient.
- SurfaceClient extracts exact lowercase `type` first; message type **values**
  are exact-case. After dispatch its DTO property matching is case-insensitive.
  Invalid JSON/non-string type is silently ignored. A known message containing
  an invalid typed field (e.g. `"width":"800"`) can throw during deserialization
  and end the socket read task; it is **not** reliably ignored. Missing required
  response fields become DTO null/zero/false defaults rather than validation
  failures. Canonical senders should always supply the response fields above.

## Selection, property editing, and stale results

Paths are dot-separated nonnegative authored-child indices, e.g. `"0.1.0"`,
relative to the host, not XPath, an x:Name, a visual-template path, or a file path.
Custom content properties are keyed by **simple** runtime type name. The standard
`Children`, `Content`, `Child`, and `Items` relationships are implicit and excluded
from the custom map. Refresh the custom map after rehosting so explicit custom
property elements produce the same authored path on both sides.

IDs are stable only within a mounted design tree; they are not stable across
rehosts and can be reused. The design surface starts allocating at 1 (wire
validation accepts 0). Property editing requires a resolvable live ID and design
mode. Conversion failure can refresh the old property values; an unresolved ID,
interact mode, dispatcher rejection, or host failure can be silent. There is no
separate conversion-error response and no transactional source-file edit on the
wire. Existing-property conversion and editor writeback are host/client concerns.

Selection events emit `Selected` then `ElementProps` for the same ID; property
refresh emits only ElementProps. These pairs are **not an atomic envelope**:
the write lock protects individual records, not a pair. No request correlation
distinguishes user clicks, caret selection, or unrelated property refresh.

**There is no stale-result protection on the wire in v1 or in SurfaceClient dispatch.**
A field named `requestId` is merely unknown and ignored. Two local mechanisms
narrow the window without changing the wire:

- Surface replies strictly in request order and, while a render is in flight,
  collapses adjacent queued `UpdateXaml` messages to the newest one (any other
  message is an ordering barrier). Every performed render still replies.
- The VS UI binds each handler to the client that raised it and drops replies
  from a client that is no longer active (document switch, spare promotion,
  matched-host upgrade). It also filters ElementProps against its latest
  selected ID.

These are not wire guarantees. A consumer should retire callbacks from old
clients, reset selection, property and content maps on rehost/document switches,
and ignore property updates for a different selection. ID checks alone cannot
distinguish reused IDs across documents. Late Frame/Error/Hwnd replies from the
same client cannot be unambiguously matched to an edit; serialize work or replace
the session when a strict boundary is needed. There is no cancellation message.

## Headless compatibility checks

Prerequisites: repository's already-installed Node/TypeScript/tsx and .NET 10 SDK.
No NuGet package references, new npm dependencies, VS/VS Code UI, user application,
native HWND, or WinUI runtime are needed. All new files and build products stay
under this directory; `bin` and `obj` are ignored.

From the repository root in PowerShell:

```powershell
node .\node_modules\typescript\bin\tsc -p .\surface\protocol\tsconfig.json
dotnet build .\surface\protocol\Compatibility.csproj --no-restore --nologo -v:q
# Only if the initial build reports missing project.assets.json:
dotnet restore .\surface\protocol\Compatibility.csproj --nologo -v:q
node .\node_modules\tsx\dist\cli.mjs --test .\surface\protocol\compatibility.test.ts
```

The restore only creates SDK assets; this project uses its own directory as its
package source and has no package dependencies. The TS test rebuilds the C#
harness with `--no-restore`, then sends the JSON-stringified shared corpus through
stdin and parses actual C# serializer output from stdout. No shell output
redirection or report files are used. For a standalone C# run after building:

```powershell
dotnet .\surface\protocol\bin\Debug\net10.0\Compatibility.dll .\surface\protocol\fixtures.json
```

Coverage:

- All 13 request and 10 response names; 45 shared serialized fixtures, including
  defaults, omitted fields, nulls, unknown capabilities/phases, empty collections,
  Unicode/emoji/newlines, PNG IHDR dimensions, property choices, native sizes,
  pane/view restore, and legacy (pre-`minProtocol`) Ready.
- One shared **negotiation table** (`fixtures.json` → `negotiation`) is checked
  against the TypeScript rule, `Wire.IsCompatible`, `FrameServer.IsCompatible`,
  the real server's Hello reply (Ready vs `protocol` Error) and the real client's
  Ready handling (startup vs permanent mismatch fault).
- Strict no-emit typecheck includes positive unions and expected compile errors;
  `tsx` alone is **not** a typecheck. Runtime negative assertions reject bad
  canonical shapes rather than accepting unchecked JSON casts.
- The C# project **links production** Messages, SurfaceClient,
  LineDecoder, and FrameServer. Tests exercise actual DTO readers/writers and
  dispatch, unknown fields, protocol negotiation, unsafe Int64s, one-byte UTF-8
  fragmentation/coalescing, CRLF, and unterminated tails. Like `Surface.csproj`,
  `Compatibility.csproj` stamps the WASDK build metadata (fixed at 2.2.0 here).
- FrameServer's real read loop runs over an ephemeral loopback test connection,
  checks reply content/order and silent commands using a Ping barrier, and tests
  viewport persistence, native transitions/failures, no-op theme, canvas auto,
  selection/property serialization, error-shape distinctions, and dispatcher
  rejection. Its real `Start`, `AcceptLoop`, and process-exiting `Shutdown` are
  **never** invoked. Finite timeouts make unexpected missing replies fail.
- `ServerDoubles.cs` substitutes only the WinUI dispatcher, host, result payloads,
  and log boundary. Captured PNG/handle/selection values are fixtures, **not a
  real rendered window**. Actual rendering, XAML activation, hit-testing,
  property conversion, HWND reparenting, full-process lifetime and UI stale-state
  guards are not tested here. Live integration testing remains separate.

Tests fail on field/content/default drift, not just changed constants. The
fixture corpus and TypeScript contract must be reviewed alongside deliberate
production protocol changes; this foundation does not generate production DTOs.

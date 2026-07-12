using System.Text.Json;
using System.Text.Json.Serialization;

namespace WinUiXaml.LanguageServer.Lsp;

/// <summary>Shared JSON options for the LSP wire format (camelCase, omit nulls).</summary>
internal static class LspJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
    };
}

// --- Base protocol envelope -------------------------------------------------

internal sealed class IncomingMessage
{
    [JsonPropertyName("jsonrpc")] public string? JsonRpc { get; set; }
    [JsonPropertyName("id")] public JsonElement? Id { get; set; }
    [JsonPropertyName("method")] public string? Method { get; set; }
    [JsonPropertyName("params")] public JsonElement? Params { get; set; }
}

internal sealed class ResponseError
{
    public ResponseError(int code, string message)
    {
        Code = code;
        Message = message;
    }

    [JsonPropertyName("code")] public int Code { get; set; }
    [JsonPropertyName("message")] public string Message { get; set; }
}

// --- Lifecycle --------------------------------------------------------------

internal sealed class InitializeParams
{
    [JsonPropertyName("processId")] public int? ProcessId { get; set; }
    [JsonPropertyName("rootUri")] public string? RootUri { get; set; }
    [JsonPropertyName("rootPath")] public string? RootPath { get; set; }
}

internal sealed class InitializeResult
{
    [JsonPropertyName("capabilities")] public ServerCapabilities Capabilities { get; set; } = new();
    [JsonPropertyName("serverInfo")] public ServerInfo? ServerInfo { get; set; }
}

internal sealed class ServerInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "WinUI XAML Language Server";
    [JsonPropertyName("version")] public string? Version { get; set; }
}

internal sealed class ServerCapabilities
{
    [JsonPropertyName("textDocumentSync")] public TextDocumentSyncOptions TextDocumentSync { get; set; } = new();
    [JsonPropertyName("definitionProvider")] public bool DefinitionProvider { get; set; }
    [JsonPropertyName("referencesProvider")] public bool ReferencesProvider { get; set; }
    [JsonPropertyName("documentHighlightProvider")] public bool DocumentHighlightProvider { get; set; }
    [JsonPropertyName("hoverProvider")] public bool HoverProvider { get; set; }
    [JsonPropertyName("documentSymbolProvider")] public bool DocumentSymbolProvider { get; set; }
    [JsonPropertyName("documentFormattingProvider")] public bool DocumentFormattingProvider { get; set; }
    [JsonPropertyName("documentRangeFormattingProvider")] public bool DocumentRangeFormattingProvider { get; set; }
    [JsonPropertyName("foldingRangeProvider")] public bool FoldingRangeProvider { get; set; }
    [JsonPropertyName("colorProvider")] public bool ColorProvider { get; set; }
    [JsonPropertyName("selectionRangeProvider")] public bool SelectionRangeProvider { get; set; }
    [JsonPropertyName("linkedEditingRangeProvider")] public bool LinkedEditingRangeProvider { get; set; }
    [JsonPropertyName("documentLinkProvider")] public DocumentLinkOptions? DocumentLinkProvider { get; set; }
    [JsonPropertyName("renameProvider")] public RenameOptions? RenameProvider { get; set; }
    [JsonPropertyName("semanticTokensProvider")] public SemanticTokensOptions? SemanticTokensProvider { get; set; }
    [JsonPropertyName("codeActionProvider")] public CodeActionOptions? CodeActionProvider { get; set; }
    [JsonPropertyName("completionProvider")] public CompletionOptions? CompletionProvider { get; set; }
}

internal sealed class CompletionOptions
{
    /// <summary>Characters that re-trigger completion (start tag, attribute gap, member dot, prefix).</summary>
    [JsonPropertyName("triggerCharacters")] public string[]? TriggerCharacters { get; set; }
    [JsonPropertyName("resolveProvider")] public bool ResolveProvider { get; set; }
}

internal sealed class TextDocumentSyncOptions
{
    [JsonPropertyName("openClose")] public bool OpenClose { get; set; }

    /// <summary>0 = None, 1 = Full, 2 = Incremental.</summary>
    [JsonPropertyName("change")] public int Change { get; set; }
}

// --- Geometry ---------------------------------------------------------------

internal struct Position
{
    public Position(int line, int character)
    {
        Line = line;
        Character = character;
    }

    [JsonPropertyName("line")] public int Line { get; set; }
    [JsonPropertyName("character")] public int Character { get; set; }
}

internal struct Range
{
    public Range(Position start, Position end)
    {
        Start = start;
        End = end;
    }

    [JsonPropertyName("start")] public Position Start { get; set; }
    [JsonPropertyName("end")] public Position End { get; set; }
}

internal sealed class Location
{
    [JsonPropertyName("uri")] public string Uri { get; set; } = string.Empty;
    [JsonPropertyName("range")] public Range Range { get; set; }
}

// --- Text document sync -----------------------------------------------------

internal sealed class TextDocumentIdentifier
{
    [JsonPropertyName("uri")] public string Uri { get; set; } = string.Empty;
}

internal sealed class TextDocumentItem
{
    [JsonPropertyName("uri")] public string Uri { get; set; } = string.Empty;
    [JsonPropertyName("languageId")] public string LanguageId { get; set; } = string.Empty;
    [JsonPropertyName("version")] public int Version { get; set; }
    [JsonPropertyName("text")] public string Text { get; set; } = string.Empty;
}

internal sealed class DidOpenTextDocumentParams
{
    [JsonPropertyName("textDocument")] public TextDocumentItem TextDocument { get; set; } = new();
}

internal sealed class DidChangeTextDocumentParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("contentChanges")] public List<TextDocumentContentChangeEvent> ContentChanges { get; set; } = new();
}

internal sealed class TextDocumentContentChangeEvent
{
    /// <summary>Under full sync (the only mode we advertise), this is the whole document text.</summary>
    [JsonPropertyName("text")] public string Text { get; set; } = string.Empty;
}

internal sealed class DidCloseTextDocumentParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
}

internal sealed class TextDocumentPositionParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("position")] public Position Position { get; set; }
}

internal sealed class ReferenceContext
{
    [JsonPropertyName("includeDeclaration")] public bool IncludeDeclaration { get; set; }
}

internal sealed class ReferenceParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("position")] public Position Position { get; set; }
    [JsonPropertyName("context")] public ReferenceContext? Context { get; set; }
}

/// <summary>An occurrence of a symbol to highlight. <see cref="Kind"/>: 1=Text, 2=Read, 3=Write.</summary>
internal sealed class DocumentHighlight
{
    [JsonPropertyName("range")] public Range Range { get; set; } = new();
    [JsonPropertyName("kind")] public int Kind { get; set; }
}

// --- Diagnostics ------------------------------------------------------------

internal sealed class PublishDiagnosticsParams
{
    [JsonPropertyName("uri")] public string Uri { get; set; } = string.Empty;
    [JsonPropertyName("diagnostics")] public List<Diagnostic> Diagnostics { get; set; } = new();
}

internal sealed class Diagnostic
{
    [JsonPropertyName("range")] public Range Range { get; set; }

    /// <summary>1 = Error, 2 = Warning, 3 = Information, 4 = Hint.</summary>
    [JsonPropertyName("severity")] public int Severity { get; set; }
    [JsonPropertyName("code")] public string? Code { get; set; }
    [JsonPropertyName("source")] public string Source { get; set; } = "winui-xaml";
    [JsonPropertyName("message")] public string Message { get; set; } = string.Empty;

    /// <summary>
    /// Opaque payload preserved by the client between <c>publishDiagnostics</c> and a later
    /// <c>codeAction</c> request (LSP 3.16+). We stash a <see cref="DiagnosticData"/> of spelling
    /// suggestions here so the code-action handler can build quick fixes without re-resolving the symbol.
    /// On the outbound side it is a <see cref="DiagnosticData"/>; on the inbound (code-action) side it
    /// deserializes to a <see cref="JsonElement"/>.
    /// </summary>
    [JsonPropertyName("data")] public object? Data { get; set; }
}

/// <summary>
/// The <see cref="Diagnostic.Data"/> payload for an unknown-name diagnostic: the mistyped token plus the
/// nearest valid names, best first, so a "Did you mean 'X'?" quick fix needs no symbol re-resolution.
/// </summary>
internal sealed class DiagnosticData
{
    [JsonPropertyName("bad")] public string Bad { get; set; } = string.Empty;
    [JsonPropertyName("suggestions")] public string[] Suggestions { get; set; } = System.Array.Empty<string>();
}

// --- Hover ------------------------------------------------------------------

internal sealed class Hover
{
    [JsonPropertyName("contents")] public MarkupContent Contents { get; set; } = new();
    [JsonPropertyName("range")] public Range? Range { get; set; }
}

internal sealed class MarkupContent
{
    /// <summary>"plaintext" or "markdown".</summary>
    [JsonPropertyName("kind")] public string Kind { get; set; } = "markdown";
    [JsonPropertyName("value")] public string Value { get; set; } = string.Empty;
}

// --- Completion -------------------------------------------------------------

internal sealed class CompletionList
{
    /// <summary>When true, the client re-queries as the user keeps typing (partial result set).</summary>
    [JsonPropertyName("isIncomplete")] public bool IsIncomplete { get; set; }
    [JsonPropertyName("items")] public List<CompletionItem> Items { get; set; } = new();
}

internal sealed class CompletionItem
{
    [JsonPropertyName("label")] public string Label { get; set; } = string.Empty;

    /// <summary>LSP CompletionItemKind: 7 = Class, 10 = Property, 23 = Event, 14 = Keyword.</summary>
    [JsonPropertyName("kind")] public int Kind { get; set; }
    [JsonPropertyName("detail")] public string? Detail { get; set; }
    [JsonPropertyName("documentation")] public MarkupContent? Documentation { get; set; }
    [JsonPropertyName("insertText")] public string? InsertText { get; set; }
    [JsonPropertyName("filterText")] public string? FilterText { get; set; }
    [JsonPropertyName("sortText")] public string? SortText { get; set; }
    [JsonPropertyName("textEdit")] public TextEdit? TextEdit { get; set; }

    /// <summary>LSP InsertTextFormat: 1 = PlainText, 2 = Snippet. Null = client default (PlainText).</summary>
    [JsonPropertyName("insertTextFormat")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? InsertTextFormat { get; set; }

    /// <summary>
    /// Additional edits applied together with the primary <see cref="TextEdit"/> (e.g. inserting an
    /// <c>xmlns:</c> declaration on the root element when completing a type from an undeclared namespace).
    /// </summary>
    [JsonPropertyName("additionalTextEdits")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<TextEdit>? AdditionalTextEdits { get; set; }
}

internal sealed class TextEdit
{
    [JsonPropertyName("range")] public Range Range { get; set; }
    [JsonPropertyName("newText")] public string NewText { get; set; } = string.Empty;
}

// --- Formatting -------------------------------------------------------------

/// <summary>LSP <c>FormattingOptions</c> (the subset we honor). Extra client-supplied keys are ignored.</summary>
internal sealed class FormattingOptions
{
    /// <summary>Size of a tab stop in spaces.</summary>
    [JsonPropertyName("tabSize")] public int TabSize { get; set; } = 4;

    /// <summary>Indent using spaces (true) or a tab character (false).</summary>
    [JsonPropertyName("insertSpaces")] public bool InsertSpaces { get; set; } = true;
}

internal sealed class DocumentFormattingParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("options")] public FormattingOptions Options { get; set; } = new();
}

internal sealed class DocumentRangeFormattingParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("range")] public Range Range { get; set; } = new();
    [JsonPropertyName("options")] public FormattingOptions Options { get; set; } = new();
}

// --- Folding ranges ---------------------------------------------------------

/// <summary>LSP <c>FoldingRangeKind</c> values (the ones we emit).</summary>
internal static class FoldingRangeKind
{
    public const string Comment = "comment";
    public const string Region = "region";
}

internal sealed class FoldingRangeParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
}

/// <summary>
/// A collapsible range of lines (LSP <c>FoldingRange</c>). Lines are zero-based. When <see cref="Kind"/>
/// is null it is omitted from the wire, yielding a generic (structural) fold.
/// </summary>
internal sealed class FoldingRange
{
    [JsonPropertyName("startLine")] public int StartLine { get; set; }
    [JsonPropertyName("endLine")] public int EndLine { get; set; }

    [JsonPropertyName("kind")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Kind { get; set; }
}

// --- Document color ---------------------------------------------------------

internal sealed class DocumentColorParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
}

/// <summary>An RGBA color with each channel in the range 0..1 (LSP <c>Color</c>).</summary>
internal sealed class Color
{
    [JsonPropertyName("red")] public double Red { get; set; }
    [JsonPropertyName("green")] public double Green { get; set; }
    [JsonPropertyName("blue")] public double Blue { get; set; }
    [JsonPropertyName("alpha")] public double Alpha { get; set; }
}

/// <summary>A color literal and the range it occupies (LSP <c>ColorInformation</c>).</summary>
internal sealed class ColorInformation
{
    [JsonPropertyName("range")] public Range Range { get; set; }
    [JsonPropertyName("color")] public Color Color { get; set; } = new();
}

internal sealed class ColorPresentationParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("color")] public Color Color { get; set; } = new();
    [JsonPropertyName("range")] public Range Range { get; set; }
}

/// <summary>One way to write a picked color back into the document (LSP <c>ColorPresentation</c>).</summary>
internal sealed class ColorPresentation
{
    [JsonPropertyName("label")] public string Label { get; set; } = string.Empty;
    [JsonPropertyName("textEdit")] public TextEdit? TextEdit { get; set; }
}

// --- Selection ranges -------------------------------------------------------

internal sealed class SelectionRangeParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("positions")] public Position[] Positions { get; set; } = System.Array.Empty<Position>();
}

/// <summary>
/// A range the editor can select, plus its enclosing range (LSP <c>SelectionRange</c>). The chain runs
/// from the innermost range outward via <see cref="Parent"/>; each parent strictly contains its child.
/// </summary>
internal sealed class SelectionRange
{
    [JsonPropertyName("range")] public Range Range { get; set; }

    [JsonPropertyName("parent")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SelectionRange? Parent { get; set; }
}

// --- Linked editing ranges --------------------------------------------------

/// <summary>
/// LSP <c>LinkedEditingRanges</c>: a set of ranges the editor keeps in sync during a rename (for XAML,
/// an element's open and end tag names). <see cref="WordPattern"/> constrains the characters a user can
/// type before the link is broken; we supply one that permits XAML prefixes and dotted names.
/// </summary>
internal sealed class LinkedEditingRanges
{
    [JsonPropertyName("ranges")] public Range[] Ranges { get; set; } = System.Array.Empty<Range>();

    [JsonPropertyName("wordPattern")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? WordPattern { get; set; }
}

// --- Document links ---------------------------------------------------------

/// <summary>Options for the LSP <c>documentLinkProvider</c> capability. We resolve targets eagerly, so
/// <see cref="ResolveProvider"/> is false (no <c>documentLink/resolve</c> round-trip).</summary>
internal sealed class DocumentLinkOptions
{
    [JsonPropertyName("resolveProvider")] public bool ResolveProvider { get; set; }
}

internal sealed class DocumentLinkParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
}

/// <summary>
/// LSP <c>DocumentLink</c>: a clickable <see cref="Range"/> in the document plus the <see cref="Target"/>
/// URI the editor opens on ctrl+click. For XAML this is a <c>ResourceDictionary Source</c> resolved to a
/// file URI.
/// </summary>
internal sealed class DocumentLink
{
    [JsonPropertyName("range")] public Range Range { get; set; }

    [JsonPropertyName("target")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Target { get; set; }

    [JsonPropertyName("tooltip")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Tooltip { get; set; }
}

// --- Rename -----------------------------------------------------------------

/// <summary>Options for the LSP <c>renameProvider</c> capability. <see cref="PrepareProvider"/> advertises
/// <c>textDocument/prepareRename</c>, so the editor validates the caret and shows the current name as the
/// rename placeholder before the edit box appears.</summary>
internal sealed class RenameOptions
{
    [JsonPropertyName("prepareProvider")] public bool PrepareProvider { get; set; }
}

internal sealed class RenameParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("position")] public Position Position { get; set; }
    [JsonPropertyName("newName")] public string NewName { get; set; } = string.Empty;
}

/// <summary>LSP <c>prepareRename</c> result: the exact token <see cref="Range"/> the editor makes editable
/// plus the <see cref="Placeholder"/> it seeds the rename box with (the symbol's current name).</summary>
internal sealed class PrepareRenameResult
{
    [JsonPropertyName("range")] public Range Range { get; set; }
    [JsonPropertyName("placeholder")] public string Placeholder { get; set; } = string.Empty;
}

/// <summary>LSP <c>WorkspaceEdit</c> (the subset we emit): a per-document map of <see cref="TextEdit"/>s.
/// Rename produces edits for a single document (the open XAML file).</summary>
internal sealed class WorkspaceEdit
{
    [JsonPropertyName("changes")] public Dictionary<string, List<TextEdit>> Changes { get; set; } = new();
}

// --- Code actions -----------------------------------------------------------

/// <summary>LSP <c>codeActionProvider</c> options advertising the kinds we produce (quick fixes only).</summary>
internal sealed class CodeActionOptions
{
    [JsonPropertyName("codeActionKinds")] public string[] CodeActionKinds { get; set; } = System.Array.Empty<string>();
}

internal sealed class CodeActionParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("range")] public Range Range { get; set; }
    [JsonPropertyName("context")] public CodeActionContext Context { get; set; } = new();
}

/// <summary>The <c>context</c> of a code-action request: the diagnostics under the cursor (carrying our
/// round-tripped <see cref="Diagnostic.Data"/>) and an optional <c>only</c> kind filter.</summary>
internal sealed class CodeActionContext
{
    [JsonPropertyName("diagnostics")] public List<Diagnostic> Diagnostics { get; set; } = new();
    [JsonPropertyName("only")] public string[]? Only { get; set; }
}

/// <summary>An LSP <c>CodeAction</c> — here always a <c>quickfix</c> carrying a single-document
/// <see cref="WorkspaceEdit"/> and the diagnostic it resolves.</summary>
internal sealed class CodeAction
{
    [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;
    [JsonPropertyName("kind")] public string? Kind { get; set; }
    [JsonPropertyName("diagnostics")] public List<Diagnostic>? Diagnostics { get; set; }
    [JsonPropertyName("isPreferred")] public bool? IsPreferred { get; set; }
    [JsonPropertyName("edit")] public WorkspaceEdit? Edit { get; set; }
}

// --- Semantic tokens --------------------------------------------------------

/// <summary>LSP <c>semanticTokensProvider</c> options: the <see cref="Legend"/> mapping our encoded
/// token-type/modifier indices to names, plus <see cref="Full"/> = whole-document tokenization.</summary>
internal sealed class SemanticTokensOptions
{
    [JsonPropertyName("legend")] public SemanticTokensLegend Legend { get; set; } = new();
    [JsonPropertyName("full")] public bool Full { get; set; }
    [JsonPropertyName("range")] public bool Range { get; set; }
}

internal sealed class SemanticTokensLegend
{
    [JsonPropertyName("tokenTypes")] public string[] TokenTypes { get; set; } = System.Array.Empty<string>();
    [JsonPropertyName("tokenModifiers")] public string[] TokenModifiers { get; set; } = System.Array.Empty<string>();
}

internal sealed class SemanticTokensParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
}

/// <summary>LSP <c>SemanticTokensRangeParams</c>: tokens are requested for the visible
/// <see cref="Range"/> only (VS Code sends this for large documents before the full set).</summary>
internal sealed class SemanticTokensRangeParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
    [JsonPropertyName("range")] public Range Range { get; set; } = new();
}

/// <summary>LSP <c>SemanticTokens</c>: the flat, 5-ints-per-token, delta-encoded array
/// (deltaLine, deltaStartChar, length, tokenType, tokenModifiers).</summary>
internal sealed class SemanticTokens
{
    [JsonPropertyName("data")] public int[] Data { get; set; } = System.Array.Empty<int>();
}

/// <summary>LSP CompletionItemKind constants (subset we emit).</summary>
internal static class CompletionItemKind
{
    public const int Class = 7;
    public const int Interface = 8;
    public const int Enum = 13;
    public const int Struct = 22;
    public const int Method = 2;
    public const int Field = 5;
    public const int Property = 10;
    public const int Event = 23;
    public const int Keyword = 14;
    public const int Value = 12;
    public const int EnumMember = 20;
    public const int Module = 9;
    public const int Color = 16;
}

// --- Document symbols (outline) ---------------------------------------------

internal sealed class DocumentSymbolParams
{
    [JsonPropertyName("textDocument")] public TextDocumentIdentifier TextDocument { get; set; } = new();
}

/// <summary>A node in the hierarchical document outline (LSP <c>DocumentSymbol</c>).</summary>
internal sealed class DocumentSymbol
{
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("detail")] public string? Detail { get; set; }
    [JsonPropertyName("kind")] public int Kind { get; set; }

    /// <summary>The full span of the symbol (used for scope/breadcrumb selection).</summary>
    [JsonPropertyName("range")] public Range Range { get; set; }

    /// <summary>The span to reveal/select — the element name — must be contained by <see cref="Range"/>.</summary>
    [JsonPropertyName("selectionRange")] public Range SelectionRange { get; set; }
    [JsonPropertyName("children")] public List<DocumentSymbol>? Children { get; set; }
}

/// <summary>LSP SymbolKind constants (subset we emit).</summary>
internal static class SymbolKind
{
    public const int Class = 5;
    public const int Property = 7;
    public const int Field = 8;
    public const int Object = 19;
}

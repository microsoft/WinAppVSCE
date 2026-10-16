using System.Text.Json.Serialization;

namespace WinUiXaml.LanguageServer.Lsp;
// Source-generated metadata for every JSON-RPC wire type; Native AOT has no reflection fallback.
// Serialization resolves by exact runtime type, so unregistered results throw NotSupportedException at runtime.
// Register closed collection types too (List<Location>, not IList<Location>).
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNameCaseInsensitive = true)]
// Envelope
[JsonSerializable(typeof(IncomingMessage))]
[JsonSerializable(typeof(ResponseError))]
// Lifecycle
[JsonSerializable(typeof(InitializeParams))]
[JsonSerializable(typeof(ShowMessageParams))]
[JsonSerializable(typeof(InitializationOptions))]
[JsonSerializable(typeof(DidChangeConfigurationParams))]
[JsonSerializable(typeof(InitializeResult))]
[JsonSerializable(typeof(ServerInfo))]
[JsonSerializable(typeof(ServerCapabilities))]
[JsonSerializable(typeof(CompletionOptions))]
[JsonSerializable(typeof(TextDocumentSyncOptions))]
[JsonSerializable(typeof(DocumentOnTypeFormattingOptions))]
[JsonSerializable(typeof(DocumentLinkOptions))]
[JsonSerializable(typeof(RenameOptions))]
[JsonSerializable(typeof(CodeActionOptions))]
[JsonSerializable(typeof(SemanticTokensOptions))]
[JsonSerializable(typeof(SemanticTokensLegend))]
// Core geometry
[JsonSerializable(typeof(Position))]
[JsonSerializable(typeof(Range))]
[JsonSerializable(typeof(Location))]
[JsonSerializable(typeof(List<Location>))]
// Text sync
[JsonSerializable(typeof(TextDocumentIdentifier))]
[JsonSerializable(typeof(TextDocumentItem))]
[JsonSerializable(typeof(DidOpenTextDocumentParams))]
[JsonSerializable(typeof(DidChangeTextDocumentParams))]
[JsonSerializable(typeof(TextDocumentContentChangeEvent))]
[JsonSerializable(typeof(DidCloseTextDocumentParams))]
[JsonSerializable(typeof(FileEvent))]
[JsonSerializable(typeof(DidChangeWatchedFilesParams))]
[JsonSerializable(typeof(TextDocumentPositionParams))]
// Navigation
[JsonSerializable(typeof(ReferenceContext))]
[JsonSerializable(typeof(ReferenceParams))]
[JsonSerializable(typeof(DocumentHighlight))]
[JsonSerializable(typeof(List<DocumentHighlight>))]
[JsonSerializable(typeof(Hover))]
[JsonSerializable(typeof(MarkupContent))]
// Diagnostics
[JsonSerializable(typeof(PublishDiagnosticsParams))]
[JsonSerializable(typeof(Diagnostic))]
[JsonSerializable(typeof(List<Diagnostic>))]
[JsonSerializable(typeof(DiagnosticData))]
// Completion
[JsonSerializable(typeof(CompletionList))]
[JsonSerializable(typeof(CompletionItem))]
[JsonSerializable(typeof(List<CompletionItem>))]
[JsonSerializable(typeof(Command))]
// Command.Arguments is object[]; each element's runtime type must be declared for the
// polymorphic write path to resolve. WinUiXaml.LanguageServer namespace, not Lsp.
[JsonSerializable(typeof(PromptedTextEditCommandArguments))]
[JsonSerializable(typeof(GuardedTextEditCommandArguments))]
[JsonSerializable(typeof(object[]))]
// Formatting
[JsonSerializable(typeof(TextEdit))]
[JsonSerializable(typeof(List<TextEdit>))]
[JsonSerializable(typeof(FormattingOptions))]
[JsonSerializable(typeof(DocumentFormattingParams))]
[JsonSerializable(typeof(DocumentRangeFormattingParams))]
[JsonSerializable(typeof(DocumentOnTypeFormattingParams))]
// Folding / color / selection
[JsonSerializable(typeof(FoldingRangeParams))]
[JsonSerializable(typeof(FoldingRange))]
[JsonSerializable(typeof(List<FoldingRange>))]
[JsonSerializable(typeof(DocumentColorParams))]
[JsonSerializable(typeof(Color))]
[JsonSerializable(typeof(ColorInformation))]
[JsonSerializable(typeof(List<ColorInformation>))]
[JsonSerializable(typeof(ColorPresentationParams))]
[JsonSerializable(typeof(ColorPresentation))]
[JsonSerializable(typeof(List<ColorPresentation>))]
[JsonSerializable(typeof(SelectionRangeParams))]
[JsonSerializable(typeof(SelectionRange))]
[JsonSerializable(typeof(List<SelectionRange>))]
[JsonSerializable(typeof(LinkedEditingRanges))]
// Links
[JsonSerializable(typeof(DocumentLinkParams))]
[JsonSerializable(typeof(DocumentLink))]
[JsonSerializable(typeof(List<DocumentLink>))]
// Rename
[JsonSerializable(typeof(RenameParams))]
[JsonSerializable(typeof(PrepareRenameResult))]
[JsonSerializable(typeof(WorkspaceEdit))]
// Code actions
[JsonSerializable(typeof(CodeActionParams))]
[JsonSerializable(typeof(CodeActionContext))]
[JsonSerializable(typeof(CodeAction))]
[JsonSerializable(typeof(List<CodeAction>))]
// Semantic tokens
[JsonSerializable(typeof(SemanticTokensParams))]
[JsonSerializable(typeof(SemanticTokensRangeParams))]
[JsonSerializable(typeof(SemanticTokens))]
// Document symbols
[JsonSerializable(typeof(DocumentSymbolParams))]
[JsonSerializable(typeof(DocumentSymbol))]
[JsonSerializable(typeof(List<DocumentSymbol>))]
// winui-xaml/* notifications
[JsonSerializable(typeof(ProjectContextStatusParams))]
[JsonSerializable(typeof(ProjectRestoreRequiredParams))]
[JsonSerializable(typeof(ProjectBuildRequiredParams))]
// Primitives that can appear as a bare result
[JsonSerializable(typeof(bool))]
[JsonSerializable(typeof(string))]
internal sealed partial class LspJsonContext : JsonSerializerContext
{
}

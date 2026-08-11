using WinUiXaml.LanguageServer.Lsp;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
    private async Task PublishDiagnosticsAsync(TextDocument doc)
    {
        var syntactic = new List<Diagnostic>(doc.Parsed.Diagnostics.Count);
        foreach (var d in doc.Parsed.Diagnostics)
        {
            syntactic.Add(new Diagnostic
            {
                Range = doc.RangeOf(d.Span),
                Severity = MapSeverity(d.Severity),
                Code = d.Id,
                Message = d.Message,
            });
        }

        await _connection.SendNotificationAsync(
            "textDocument/publishDiagnostics",
            new PublishDiagnosticsParams { Uri = doc.Uri, Diagnostics = syntactic }).ConfigureAwait(false);

        // Semantic validation needs the project's type system (async; the first load is slow). Run it off the hot path and re-publish a combined set, but only while this remains the current document.
        _ = Task.Run(() => PublishSemanticDiagnosticsAsync(doc, syntactic));
    }

    /// <summary>Computes semantic diagnostics against the loaded type system and re-publishes them combined with the already-sent syntactic set.</summary>
    private async Task PublishSemanticDiagnosticsAsync(TextDocument doc, List<Diagnostic> syntactic)
    {
        try
        {
            // Give immediate editor requests a short head start before the CPU-heavy design-time
            // build. This is still eager background initialization, without competing with the
            // first hover/completion immediately after didOpen.
            await Task.Delay(500).ConfigureAwait(false);
            if (!IsCurrent(doc))
            {
                return;
            }

            var typeSystem = await GetTypeSystemAsync(doc.Uri).ConfigureAwait(false);
            if (typeSystem == null || !IsCurrent(doc))
            {
                return;
            }

            var semantic = XamlValidator.Validate(doc, typeSystem);
            if (semantic.Count == 0 || !IsCurrent(doc))
            {
                // No semantic issues: the syntactic-only publish already sent is the correct final state.
                return;
            }

            var combined = new List<Diagnostic>(syntactic.Count + semantic.Count);
            combined.AddRange(syntactic);
            combined.AddRange(semantic);

            if (!IsCurrent(doc))
            {
                return;
            }

            await _connection.SendNotificationAsync(
                "textDocument/publishDiagnostics",
                new PublishDiagnosticsParams { Uri = doc.Uri, Diagnostics = combined }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] semantic validation failed: {ex.Message}");
        }
    }

    private bool IsCurrent(TextDocument doc) =>
        _documents.TryGetValue(doc.Uri, out var current) && ReferenceEquals(current, doc);

}

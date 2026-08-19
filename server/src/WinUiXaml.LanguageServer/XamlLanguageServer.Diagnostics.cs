using WinUiXaml.LanguageServer.Lsp;
using Diagnostic = WinUiXaml.LanguageServer.Lsp.Diagnostic;

namespace WinUiXaml.LanguageServer;

internal sealed partial class XamlLanguageServer
{
    private async Task PublishDiagnosticsAsync(TextDocument doc)
    {
        var diagnosticsGeneration = Volatile.Read(ref _diagnosticsGeneration);
        var diagnosticsLevel = _diagnosticsLevel;
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
        syntactic = FilterDiagnosticsForLevel(syntactic, diagnosticsLevel);

        if (!await PublishCurrentDiagnosticsAsync(
            doc,
            syntactic,
            diagnosticsGeneration).ConfigureAwait(false))
        {
            return;
        }

        // Semantic validation needs the project's type system (async; the first load is slow). Run it off the hot path and re-publish a combined set, but only while this remains the current document.
        if (diagnosticsLevel != "off")
        {
            ScheduleSemanticDiagnostics(doc, syntactic, diagnosticsLevel, diagnosticsGeneration);
        }
        else
        {
            CancelSemanticDiagnostics(doc.Uri);
        }
    }

    private void ScheduleSemanticDiagnostics(
        TextDocument doc,
        List<Diagnostic> syntactic,
        string diagnosticsLevel,
        int diagnosticsGeneration)
    {
        AsyncCancellationLifetime cancellation;
        lock (_semanticDiagnosticsGate)
        {
            // Concurrent didChange handlers can finish sending their syntactic publication out of
            // order. A superseded handler must not cancel the current version's semantic worker.
            if (!IsCurrentDiagnostics(doc, diagnosticsGeneration))
            {
                return;
            }

            cancellation = new AsyncCancellationLifetime();
            if (_semanticDiagnosticCancellations.TryGetValue(doc.Uri, out var previous))
            {
                previous.Cancel();
            }

            _semanticDiagnosticCancellations[doc.Uri] = cancellation;
        }

        _ = PublishSemanticDiagnosticsAsync(
            doc,
            syntactic,
            diagnosticsLevel,
            diagnosticsGeneration,
            cancellation);
    }

    private void CancelSemanticDiagnostics(string uri)
    {
        lock (_semanticDiagnosticsGate)
        {
            if (_semanticDiagnosticCancellations.TryRemove(uri, out var cancellation))
            {
                cancellation.Cancel();
            }
        }
    }

    /// <summary>Computes semantic diagnostics against the loaded type system and re-publishes them combined with the already-sent syntactic set.</summary>
    private async Task PublishSemanticDiagnosticsAsync(
        TextDocument doc,
        List<Diagnostic> syntactic,
        string diagnosticsLevel,
        int diagnosticsGeneration,
        AsyncCancellationLifetime cancellation)
    {
        try
        {
            // Give immediate editor requests a short head start before the CPU-heavy design-time
            // build. This is still eager background initialization, without competing with the
            // first hover/completion immediately after didOpen.
            await Task.Delay(500, cancellation.Token).ConfigureAwait(false);
            if (!IsCurrentDiagnostics(doc, diagnosticsGeneration))
            {
                return;
            }

            var context = TryGetAcceptedContext(doc, out var accepted) &&
                accepted.Stage == XamlProjectStage.Full
                ? accepted
                : await GetFullContextAsync(doc.Uri, cancellation.Token).ConfigureAwait(false);
            if (context == null || !IsCurrentDiagnostics(doc, diagnosticsGeneration))
            {
                return;
            }

            var resourceKeys = GetAppResourceKeys(context)
                .Concat(context.TypeSystem.GetThemeResources().Select(resource => resource.Key))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            var semantic = FilterDiagnosticsForLevel(
                XamlValidator.Validate(doc, context.TypeSystem, resourceKeys),
                diagnosticsLevel);
            if (semantic.Count == 0 || !IsCurrentDiagnostics(doc, diagnosticsGeneration))
            {
                // No semantic issues: the syntactic-only publish already sent is the correct final state.
                return;
            }

            var combined = new List<Diagnostic>(syntactic.Count + semantic.Count);
            combined.AddRange(syntactic);
            combined.AddRange(semantic);

            await PublishCurrentDiagnosticsAsync(
                doc,
                combined,
                diagnosticsGeneration).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[winui-xaml-ls] semantic validation failed: {ex.Message}");
        }
        finally
        {
            lock (_semanticDiagnosticsGate)
            {
                if (_semanticDiagnosticCancellations.TryGetValue(doc.Uri, out var current) &&
                    ReferenceEquals(current, cancellation))
                {
                    _semanticDiagnosticCancellations.TryRemove(doc.Uri, out _);
                }

            }

            await cancellation.DisposeAsync().ConfigureAwait(false);
        }
    }

    private bool IsCurrent(TextDocument doc) =>
        _documents.TryGetValue(doc.Uri, out var current) && ReferenceEquals(current, doc);

    private bool IsCurrentDiagnostics(TextDocument doc, int diagnosticsGeneration) =>
        diagnosticsGeneration == Volatile.Read(ref _diagnosticsGeneration) &&
        IsCurrent(doc);

    private async Task<bool> PublishCurrentDiagnosticsAsync(
        TextDocument doc,
        List<Diagnostic> diagnostics,
        int diagnosticsGeneration)
    {
        await _diagnosticsPublicationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!IsCurrentDiagnostics(doc, diagnosticsGeneration))
            {
                return false;
            }

            await _connection.SendNotificationAsync(
                "textDocument/publishDiagnostics",
                new PublishDiagnosticsParams
                {
                    Uri = doc.Uri,
                    Version = doc.Version,
                    Diagnostics = diagnostics,
                }).ConfigureAwait(false);
            return true;
        }
        finally
        {
            _diagnosticsPublicationGate.Release();
        }
    }

    internal static List<Diagnostic> FilterDiagnosticsForLevel(
        IEnumerable<Diagnostic> diagnostics,
        string level) =>
        level switch
        {
            "off" => new List<Diagnostic>(),
            "error" => diagnostics
                .Where(diagnostic => diagnostic.Severity == 1)
                .ToList(),
            _ => diagnostics.ToList(),
        };

}

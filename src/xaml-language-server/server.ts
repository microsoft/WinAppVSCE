import {
	createConnection,
	Diagnostic,
	InitializeParams,
	InitializeResult,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getCompletions, setCompletionSettings } from './completion-provider';
import { getDefinition, getReferences } from './definition-provider';
import { getDiagnostics, setDiagnosticsLevel } from './diagnostics-provider';
import { formatDocument, formatRange } from './formatting-provider';
import { getHover } from './hover-provider';

interface ServerSettings {
	enable: boolean;
	diagnosticsLevel: 'off' | 'error' | 'warning';
	trace: boolean;
	includeCustomControls: boolean;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let settings: ServerSettings = {
	enable: true,
	diagnosticsLevel: 'warning',
	trace: false,
	includeCustomControls: true
};

function log(message: string): void {
	if (settings.trace) {
		connection.console.log(`[xaml-server] ${message}`);
	}
}

function normalizeSettings(raw: unknown): ServerSettings {
	const winapp = typeof raw === 'object' && raw ? raw as { xaml?: unknown } : {};
	const xaml = typeof winapp.xaml === 'object' && winapp.xaml ? winapp.xaml as Record<string, unknown> : {};
	const languageServer = typeof xaml.languageServer === 'object' && xaml.languageServer ? xaml.languageServer as Record<string, unknown> : {};
	const diagnostics = typeof xaml.diagnostics === 'object' && xaml.diagnostics ? xaml.diagnostics as Record<string, unknown> : {};
	const trace = typeof xaml.trace === 'object' && xaml.trace ? xaml.trace as Record<string, unknown> : {};
	const completion = typeof xaml.completion === 'object' && xaml.completion ? xaml.completion as Record<string, unknown> : {};

	return {
		enable: languageServer.enable !== false,
		diagnosticsLevel: diagnostics.level === 'off' || diagnostics.level === 'error' ? diagnostics.level : 'warning',
		trace: trace.server === true,
		includeCustomControls: completion.includeCustomControls !== false
	};
}

async function refreshSettings(): Promise<void> {
	if (!hasConfigurationCapability) {
		return;
	}
	settings = normalizeSettings(await connection.workspace.getConfiguration('winapp'));
	setCompletionSettings({ includeCustomControls: settings.includeCustomControls });
	setDiagnosticsLevel(settings.diagnosticsLevel);
	log(`Settings refreshed: ${JSON.stringify(settings)}`);
}

async function validateDocument(document: TextDocument): Promise<void> {
	if (!settings.enable || settings.diagnosticsLevel === 'off') {
		connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
		return;
	}
	const diagnostics: Diagnostic[] = getDiagnostics(document.getText(), document.uri);
	connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
	hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				triggerCharacters: ['<', ' ', '.', '"', '{', '=']
			},
			hoverProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			documentFormattingProvider: true,
			documentRangeFormattingProvider: true
		}
	};
});

connection.onInitialized(async () => {
	await refreshSettings();
});

connection.onDidChangeConfiguration(async (change) => {
	settings = normalizeSettings(change.settings);
	setCompletionSettings({ includeCustomControls: settings.includeCustomControls });
	setDiagnosticsLevel(settings.diagnosticsLevel);
	for (const document of documents.all()) {
		await validateDocument(document);
	}
});

documents.onDidOpen(async (event) => {
	await validateDocument(event.document);
});

documents.onDidChangeContent(async (event) => {
	await validateDocument(event.document);
});

documents.onDidClose((event) => {
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params) => {
	if (!settings.enable) {
		return [];
	}
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}
	return getCompletions(document.getText(), params.position, params.textDocument.uri);
});

connection.onHover((params) => {
	if (!settings.enable) {
		return null;
	}
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return null;
	}
	return getHover(document.getText(), params.position);
});

connection.onDefinition((params) => {
	if (!settings.enable) {
		return null;
	}
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return null;
	}
	return getDefinition(document.getText(), params.position, params.textDocument.uri);
});

connection.onReferences((params) => {
	if (!settings.enable) {
		return [];
	}
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}
	return getReferences(document.getText(), params.position, params.textDocument.uri);
});

connection.onDocumentFormatting((params) => {
	if (!settings.enable) {
		return [];
	}
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}
	return formatDocument(document.getText(), params.options);
});

connection.onDocumentRangeFormatting((params) => {
	if (!settings.enable) {
		return [];
	}
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return [];
	}
	return formatRange(document.getText(), params.range.start, params.range.end, params.options);
});

connection.onRequest('winapp/xaml/reloadMetadata', async () => {
	log('Metadata reload requested.');
	return { ok: true };
});

/**
 * Starts the XAML language server.
 */
export function startServer(serverConnection = connection): void {
	documents.listen(serverConnection);
	serverConnection.listen();
}

startServer();

/**
 * Custom Text Editor Provider for appxmanifest.xml files.
 * Opens a webview-based form editor when an appxmanifest.xml is opened.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { parseManifest, applyFieldChange, addCapability, removeCapability, addPackageDependency, removePackageDependency, addTargetDeviceFamily, removeTargetDeviceFamily, moveTargetDeviceFamily, movePackageDependency, addMainPackageDependency, removeMainPackageDependency, moveMainPackageDependency, addDriverConstraint, removeDriverConstraint, moveDriverConstraint, addOSPackageDependency, removeOSPackageDependency, moveOSPackageDependency, addHostRuntimeDependency, removeHostRuntimeDependency, moveHostRuntimeDependency, addExternalDependency, removeExternalDependency, moveExternalDependency, addApplication, removeApplication, addExtension, removeExtension, updateExtensionField, addResource, removeResource, moveResource, setShowNameOnTiles, addPhoneIdentity, removePhoneIdentity, removeVisualAsset } from './manifest-parser';
import { validateManifest } from './manifest-validator';
import { getWebviewContent, getParseErrorContent } from './webview-content';
import { WebviewToExtensionMessage } from './manifest-types';
import { getWinappCliPath, WINAPP_CLI_CALLER_VALUE } from '../winapp-cli-utils';
import { SchemaModel } from '../manifest-schema/schema-model';
import { AssetCopyTokenStore } from './asset-copy-token-store';

/** Debounce window for external document changes (e.g. typing in the XML text editor). */
const EXTERNAL_CHANGE_DEBOUNCE_MS = 250;

export class ManifestEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'winapp.manifestEditor';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly getSchema: () => SchemaModel,
    ) {}

    public static register(context: vscode.ExtensionContext, getSchema: () => SchemaModel): vscode.Disposable {
        const provider = new ManifestEditorProvider(context, getSchema);
        return vscode.window.registerCustomEditorProvider(
            ManifestEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            },
        );
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        // When opened from Source Control diff or other non-file contexts,
        // fall back to the default text editor so the user sees a proper diff.
        if (document.uri.scheme !== 'file') {
            webviewPanel.webview.html = '';
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            return;
        }

        const manifestDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
        const resourceRoots: vscode.Uri[] = [this.context.extensionUri, manifestDir];
        // Include workspace folder roots so relative paths with ".." can resolve
        if (vscode.workspace.workspaceFolders) {
            for (const wf of vscode.workspace.workspaceFolders) {
                resourceRoots.push(wf.uri);
            }
        }
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: resourceRoots,
        };

        const freshNonce = () => crypto.randomBytes(16).toString('hex');
        const manifestDirUri = webviewPanel.webview.asWebviewUri(manifestDir).toString();

        // Track whether we're currently applying an edit to avoid feedback loops
        let isApplyingEdit = false;
        // Which document the webview currently hosts. Reassigning `webview.html` destroys the
        // script context (and therefore all webview UI state), so it is only done when switching
        // between the two documents — never for a parse error while the editor is already loaded.
        let documentMode: 'editor' | 'errorPage' = 'editor';
        let errorPageMessage: string | undefined;
        let externalChangeTimer: NodeJS.Timeout | undefined;
        const assetCopyTokens = new AssetCopyTokenStore();

        /** Whether the document currently parses, i.e. whether it is safe to rewrite. */
        const documentParses = (xml: string): boolean => {
            try {
                parseManifest(xml);
                return true;
            } catch {
                return false;
            }
        };

        /** Load the full editor view. */
        const showEditorView = () => {
            documentMode = 'editor';
            errorPageMessage = undefined;
            webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, freshNonce(), manifestDirUri);
            // The editor will send 'ready' once loaded, which triggers updateWebview
        };

        /** Load the standalone parse-error page (only used when the editor never loaded). */
        const showErrorPage = (errMsg: string) => {
            // Avoid rebuilding an identical page on every keystroke while the XML stays broken.
            if (documentMode === 'errorPage' && errorPageMessage === errMsg) { return; }
            documentMode = 'errorPage';
            errorPageMessage = errMsg;
            webviewPanel.webview.html = getParseErrorContent(webviewPanel.webview, freshNonce(), errMsg);
        };

        // Table-driven dispatch for simple XML operations
        const simpleDispatch: Record<string, (text: string, msg: any) => string> = {
            addCapability: (t, m) => addCapability(t, m.capability),
            removeCapability: (t, m) => removeCapability(t, m.capability),
            addPhoneIdentity: (t) => addPhoneIdentity(t),
            removePhoneIdentity: (t) => removePhoneIdentity(t),
            addResource: (t, m) => addResource(t, m.resource),
            removeResource: (t, m) => removeResource(t, m.index),
            moveResource: (t, m) => moveResource(t, m.index, m.direction),
            addPackageDependency: (t, m) => addPackageDependency(t, m.dependency),
            removePackageDependency: (t, m) => removePackageDependency(t, m.index),
            movePackageDependency: (t, m) => movePackageDependency(t, m.index, m.direction),
            addTargetDeviceFamily: (t, m) => addTargetDeviceFamily(t, m.family),
            removeTargetDeviceFamily: (t, m) => removeTargetDeviceFamily(t, m.index),
            moveTargetDeviceFamily: (t, m) => moveTargetDeviceFamily(t, m.index, m.direction),
            addMainPackageDependency: (t, m) => addMainPackageDependency(t, m.dependency),
            removeMainPackageDependency: (t, m) => removeMainPackageDependency(t, m.index),
            moveMainPackageDependency: (t, m) => moveMainPackageDependency(t, m.index, m.direction),
            addDriverConstraint: (t, m) => addDriverConstraint(t, m.constraint),
            removeDriverConstraint: (t, m) => removeDriverConstraint(t, m.index),
            moveDriverConstraint: (t, m) => moveDriverConstraint(t, m.index, m.direction),
            addOSPackageDependency: (t, m) => addOSPackageDependency(t, m.dependency),
            removeOSPackageDependency: (t, m) => removeOSPackageDependency(t, m.index),
            moveOSPackageDependency: (t, m) => moveOSPackageDependency(t, m.index, m.direction),
            addHostRuntimeDependency: (t, m) => addHostRuntimeDependency(t, m.dependency),
            removeHostRuntimeDependency: (t, m) => removeHostRuntimeDependency(t, m.index),
            moveHostRuntimeDependency: (t, m) => moveHostRuntimeDependency(t, m.index, m.direction),
            addExternalDependency: (t, m) => addExternalDependency(t, m.dependency),
            removeExternalDependency: (t, m) => removeExternalDependency(t, m.index),
            moveExternalDependency: (t, m) => moveExternalDependency(t, m.index, m.direction),
            addApplication: (t) => addApplication(t),
            removeApplication: (t, m) => removeApplication(t, m.index),
            addExtension: (t, m) => addExtension(t, m.index, m.xml),
            removeExtension: (t, m) => removeExtension(t, m.appIndex, m.extIndex),
            updateExtensionField: (t, m) => updateExtensionField(t, m.appIndex, m.extIndex, m.fieldPath, m.value, m.isTextContent),
            setShowNameOnTiles: (t, m) => setShowNameOnTiles(t, m.appIndex, m.tiles),
        };

        /** Browse for a file and return its path relative to the manifest directory. */
        async function browseAndApplyField(title: string, filters: Record<string, string[]>): Promise<string | undefined> {
            const filePath = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                title, filters,
                defaultUri: vscode.Uri.file(path.dirname(document.uri.fsPath)),
            });
            if (!filePath || filePath.length === 0) { return undefined; }
            return path.relative(path.dirname(document.uri.fsPath), filePath[0].fsPath);
        }

        /** Send the current document state to the webview. */
        const updateWebview = (forceAll = false) => {
            const text = document.getText();
            let data;
            try {
                data = parseManifest(text);
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                if (documentMode === 'editor') {
                    // Keep the loaded editor document alive and surface the failure as an overlay.
                    // Rebuilding the document here would wipe tab/scroll/expanded-field state every
                    // time the XML is transiently invalid while the user types in the text editor.
                    webviewPanel.webview.postMessage({ type: 'parseError', message: errMsg });
                } else {
                    showErrorPage(errMsg);
                }
                return;
            }
            if (documentMode !== 'editor') {
                // Recovered from an unparseable initial load — swap in the editor document.
                // It posts 'ready' when loaded, which calls back into updateWebview.
                showEditorView();
                return;
            }
            const errors = validateManifest(data, this.getSchema());
            webviewPanel.webview.postMessage({ type: 'update', data, errors, forceAll });
        };

        // Initial load: check if XML is valid
        try {
            parseManifest(document.getText());
            showEditorView();
        } catch (e) {
            showErrorPage(e instanceof Error ? e.message : String(e));
        }

        // Listen for document changes (e.g., from the text editor, undo, or external edits).
        // This fires on every keystroke, so debounce the re-render: re-rendering mid-word is wasted
        // work, and half-typed elements make the XML transiently unparseable.
        const changeDocSub = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString() || isApplyingEdit) { return; }
            // Tell the webview to drop input still sitting in its 300ms debounce *immediately*,
            // ahead of the debounced re-render. That input was typed against the pre-edit document,
            // so replaying it would overwrite the change that just arrived from the text editor.
            // Waiting for the parse-error overlay to do this isn't enough: XML that breaks and is
            // fixed again inside the debounce window never shows an overlay at all.
            webviewPanel.webview.postMessage({ type: 'externalChange' });
            if (externalChangeTimer) { clearTimeout(externalChangeTimer); }
            externalChangeTimer = setTimeout(() => {
                externalChangeTimer = undefined;
                // External change (undo, redo, text editor) — force-update all fields
                updateWebview(true);
            }, EXTERNAL_CHANGE_DEBOUNCE_MS);
        });

        // Flush pending webview input changes before save so Ctrl+S captures edits
        // that are still in the 300ms debounce window.
        let pendingSaveResolve: ((edits: vscode.TextEdit[]) => void) | null = null;
        let pendingSaveNonce: string | null = null;
        const willSaveSub = vscode.workspace.onWillSaveTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                e.waitUntil(new Promise<vscode.TextEdit[]>((resolve) => {
                    const nonce = crypto.randomUUID();
                    pendingSaveResolve = resolve;
                    pendingSaveNonce = nonce;
                    webviewPanel.webview.postMessage({ type: 'flushChanges', nonce });
                    // Timeout fallback — don't block save forever
                    setTimeout(() => {
                        if (pendingSaveNonce === nonce) {
                            pendingSaveResolve = null;
                            pendingSaveNonce = null;
                            resolve([]);
                        }
                    }, 500);
                }));
            }
        });

        webviewPanel.onDidDispose(() => {
            if (externalChangeTimer) { clearTimeout(externalChangeTimer); }
            changeDocSub.dispose();
            willSaveSub.dispose();
        });

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
            const text = document.getText();
            let newText: string | undefined;

            try {
                // Table-driven dispatch for simple XML operations
                if (simpleDispatch[message.type]) {
                    newText = simpleDispatch[message.type](text, message);
                } else {
                    switch (message.type) {
                        case 'ready':
                            updateWebview();
                            return;

                        case 'changesFlushed': {
                            // Apply all pending field changes and resolve the save promise
                            // Match nonce to prevent stale resolution from rapid double-saves
                            if (pendingSaveResolve && message.nonce === pendingSaveNonce) {
                                const resolve = pendingSaveResolve;
                                pendingSaveResolve = null;
                                pendingSaveNonce = null;
                                // Same hazard as the debounced edit path: never rewrite a
                                // document we could not parse. Resolve with no edits so the
                                // save still completes.
                                if (!documentParses(text)) {
                                    resolve([]);
                                    return;
                                }
                                let result = text;
                                for (const change of message.changes) {
                                    result = change.kind === 'extField'
                                        ? updateExtensionField(result, change.appIndex, change.extIndex, change.fieldPath, change.value, change.isTextContent)
                                        : applyFieldChange(result, change.section, change.field, change.value, change.index);
                                }
                                const edits = result !== text
                                    ? [vscode.TextEdit.replace(new vscode.Range(0, 0, document.lineCount, 0), result)]
                                    : [];
                                resolve(edits);
                            }
                            return;
                        }

                        case 'openAsText':
                            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                            return;

                        case 'checkImagePath': {
                            const imgPath = message.imagePath;
                            const manifestDirPath = path.dirname(document.uri.fsPath);
                            const resolved = path.resolve(manifestDirPath, imgPath);
                            const usesWorkspaceFallback = imgPath.startsWith('..\\') || imgPath.startsWith('../');
                            const isWithinRoot = (candidatePath: string, rootPath: string): boolean => {
                                const relativePath = path.relative(rootPath, candidatePath);
                                return relativePath !== ''
                                    && !relativePath.startsWith('..')
                                    && !path.isAbsolute(relativePath);
                            };
                            const workspaceRoot = vscode.workspace.workspaceFolders?.find(wf =>
                                resolved.toLowerCase() === wf.uri.fsPath.toLowerCase()
                                || isWithinRoot(resolved, wf.uri.fsPath)
                            )?.uri.fsPath;

                            // Check if the resolved path is inside the package directory AND exists
                            const normalizedResolved = resolved.toLowerCase();
                            const normalizedManifestDir = manifestDirPath.toLowerCase() + path.sep;
                            if (normalizedResolved.startsWith(normalizedManifestDir) && fs.existsSync(resolved)) {
                                const dims = getImageDimensions(resolved);
                                const aspectWarning = dims ? checkAspectRatio(message.field, dims.width, dims.height) : null;
                                webviewPanel.webview.postMessage({ type: 'imagePathStatus', field: message.field, index: message.index, status: 'found', aspectWarning: aspectWarning || undefined });
                                return;
                            }

                            if (!path.isAbsolute(imgPath) && usesWorkspaceFallback && workspaceRoot && fs.existsSync(resolved)) {
                                const dims = getImageDimensions(resolved);
                                const aspectWarning = dims ? checkAspectRatio(message.field, dims.width, dims.height) : null;
                                webviewPanel.webview.postMessage({ type: 'imagePathStatus', field: message.field, index: message.index, status: 'found', aspectWarning: aspectWarning || undefined });
                                return;
                            }

                            // The path resolves outside the package dir (e.g., ..\..\Downloads\img.png)
                            // or is an absolute path — check if the file exists at the resolved location
                            if (fs.existsSync(resolved)) {
                                const copyToken = assetCopyTokens.issue(resolved);
                                webviewPanel.webview.postMessage({ type: 'imagePathStatus', field: message.field, index: message.index, status: 'external', copyToken });
                                return;
                            }

                            // Check if it's an absolute path that exists
                            if (path.isAbsolute(imgPath) && fs.existsSync(imgPath)) {
                                const copyToken = assetCopyTokens.issue(imgPath);
                                webviewPanel.webview.postMessage({ type: 'imagePathStatus', field: message.field, index: message.index, status: 'external', copyToken });
                                return;
                            }

                            // Only fall back to workspace-root resolution for paths that
                            // explicitly escape the manifest folder (for example ..\Assets\logo.png).
                            if (usesWorkspaceFallback && vscode.workspace.workspaceFolders) {
                                for (const wf of vscode.workspace.workspaceFolders) {
                                    const candidate = path.resolve(wf.uri.fsPath, imgPath);
                                    if (fs.existsSync(candidate)) {
                                        const dims = getImageDimensions(candidate);
                                        const aspectWarning = dims ? checkAspectRatio(message.field, dims.width, dims.height) : null;
                                        webviewPanel.webview.postMessage({ type: 'imagePathStatus', field: message.field, index: message.index, status: 'found', aspectWarning: aspectWarning || undefined });
                                        return;
                                    }
                                }
                            }

                            webviewPanel.webview.postMessage({ type: 'imagePathStatus', field: message.field, index: message.index, status: 'notFound' });
                            return;
                        }

                        case 'copyToAssets': {
                            const manifestDirPath2 = path.dirname(document.uri.fsPath);
                            const assetsDir = path.join(manifestDirPath2, 'Assets');
                            const sourcePath = assetCopyTokens.consume(message.copyToken);
                            if (!sourcePath) {
                                updateWebview(true);
                                return;
                            }
                            const fileName = path.basename(sourcePath);

                            let destName = fileName;
                            if (!fs.existsSync(assetsDir)) {
                                fs.mkdirSync(assetsDir, { recursive: true });
                            }

                            let destPath = path.join(assetsDir, destName);
                            if (fs.existsSync(destPath)) {
                                const ext = path.extname(fileName);
                                const base = path.basename(fileName, ext);
                                let counter = 1;
                                while (fs.existsSync(destPath)) {
                                    destName = `${base}_${counter}${ext}`;
                                    destPath = path.join(assetsDir, destName);
                                    counter++;
                                }
                            }

                            fs.copyFileSync(sourcePath, destPath);
                            const newRelPath = `Assets\\${destName}`;

                            // Apply the field change with the new path
                            newText = applyFieldChange(text, message.section, message.field, newRelPath, message.index);
                            break;
                        }

                        case 'fieldChanged':
                            newText = applyFieldChange(text, message.section, message.field, message.value, message.index, message.subIndex);
                            break;

                        case 'removeVisualAsset': {
                            const veField = message.field.replace('visualElements.', '');
                            newText = removeVisualAsset(text, message.index, veField);
                            break;
                        }

                        case 'packageTypeChanged': {
                            // Set/clear the three mutually exclusive package type properties
                            let result = text;
                            result = applyFieldChange(result, 'properties', 'framework', message.value === 'framework' ? 'true' : '');
                            result = applyFieldChange(result, 'properties', 'resourcePackage', message.value === 'resource' ? 'true' : '');
                            result = applyFieldChange(result, 'properties', 'modificationPackage', message.value === 'modification' ? 'true' : '');
                            newText = result;
                            break;
                        }

                        case 'browseFile': {
                            const relPath = await browseAndApplyField('Select JSON file', { 'JSON': ['json'] });
                            if (!relPath) { return; }
                            newText = updateExtensionField(text, message.appIndex, message.extIndex, message.fieldPath, relPath, true);
                            break;
                        }

                        case 'browseImage': {
                            const relPath = await browseAndApplyField('Select image', { 'Images': ['png', 'jpg', 'jpeg', 'svg', 'ico'] });
                            if (!relPath) { return; }
                            newText = applyFieldChange(text, message.section, message.field, relPath, message.index);
                            break;
                        }

                        case 'browseExe': {
                            const relPath = await browseAndApplyField('Select executable', { 'Executables': ['exe'] });
                            if (!relPath) { return; }
                            newText = applyFieldChange(text, message.section, message.field, relPath, message.index);
                            break;
                        }

                        case 'updateAssets': {
                            const imagePath = await vscode.window.showOpenDialog({
                                canSelectFiles: true,
                                canSelectFolders: false,
                                canSelectMany: false,
                                title: 'Select source image for assets',
                                filters: { 'Images': ['png', 'jpg', 'jpeg', 'svg'] },
                            });
                            if (!imagePath || imagePath.length === 0) { return; }

                            const cliPath = getWinappCliPath(this.context.extensionPath);
                            const cwd = path.dirname(document.uri.fsPath);

                            await vscode.window.withProgress(
                                { location: vscode.ProgressLocation.Notification, title: 'Regenerating assets…', cancellable: false },
                                () => new Promise<void>((resolve, reject) => {
                                    execFile(cliPath, ['manifest', 'update-assets', imagePath[0].fsPath], { cwd, env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE } }, (error) => {
                                        if (error) {
                                            vscode.window.showErrorMessage(`Asset regeneration failed: ${error.message}`);
                                            reject(error);
                                        } else {
                                            resolve();
                                        }
                                    });
                                }),
                            );

                            webviewPanel.webview.postMessage({ type: 'refreshImages' });
                            return;
                        }
                    }
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn('[ManifestEditor] XML manipulation failed:', err);
                vscode.window.showErrorMessage(`Manifest edit failed: ${errMsg}`);
                return;
            }

            if (newText !== undefined && newText !== text) {
                // The webview debounces input for 300 ms, and the parse-error overlay no longer
                // tears down the webview script context, so an edit can arrive after the document
                // became unparseable. Rewriting the whole document from XML we could not parse
                // would clobber what the user is typing in the text editor, so drop it — the
                // webview is repopulated from the document once the XML is valid again.
                if (!documentParses(text)) {
                    return;
                }
                isApplyingEdit = true;
                try {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        newText,
                    );
                    await vscode.workspace.applyEdit(edit);
                } finally {
                    isApplyingEdit = false;
                }

                // Update webview with the new state (including validation)
                updateWebview();
            }
        });
    }
}

/** Reads width/height from PNG or JPEG file headers without loading the full image. */
function getImageDimensions(filePath: string): { width: number; height: number } | null {
    try {
        const fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(32);
        fs.readSync(fd, header, 0, 32, 0);

        // PNG: bytes 0-7 are signature, IHDR chunk starts at byte 8, width at 16, height at 20
        if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
            const width = header.readUInt32BE(16);
            const height = header.readUInt32BE(20);
            fs.closeSync(fd);
            return { width, height };
        }

        // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
        if (header[0] === 0xFF && header[1] === 0xD8) {
            const buf = Buffer.alloc(65536);
            fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            let offset = 2;
            while (offset < buf.length - 9) {
                if (buf[offset] !== 0xFF) break;
                const marker = buf[offset + 1];
                if (marker === 0xC0 || marker === 0xC2) {
                    const height = buf.readUInt16BE(offset + 5);
                    const width = buf.readUInt16BE(offset + 7);
                    return { width, height };
                }
                const len = buf.readUInt16BE(offset + 2);
                offset += 2 + len;
            }
            return null;
        }

        fs.closeSync(fd);
        return null;
    } catch {
        return null;
    }
}

/** Expected aspect ratios for manifest image fields (width:height). */
const EXPECTED_RATIOS: Record<string, { w: number; h: number; label: string }> = {
    'visualElements.square150x150Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.square44x44Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.square71x71Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.square310x310Logo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.wide310x150Logo': { w: 310, h: 150, label: '310:150 (wide)' },
    'visualElements.badgeLogo': { w: 1, h: 1, label: '1:1 (square)' },
    'visualElements.splashScreenImage': { w: 620, h: 300, label: '620:300 (wide)' },
    'logo': { w: 1, h: 1, label: '1:1 (square)' },
};

/** Returns a warning string if the image aspect ratio doesn't match expectations (±5% tolerance). */
function checkAspectRatio(field: string, width: number, height: number): string | null {
    const expected = EXPECTED_RATIOS[field];
    if (!expected || width === 0 || height === 0) { return null; }
    const actualRatio = width / height;
    const expectedRatio = expected.w / expected.h;
    const tolerance = 0.05;
    if (Math.abs(actualRatio - expectedRatio) / expectedRatio > tolerance) {
        return `Image is ${width}×${height} — expected ${expected.label} aspect ratio`;
    }
    return null;
}

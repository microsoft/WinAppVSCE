import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractJsonObject, getWinappCliPath, WINAPP_CLI_CALLER_VALUE } from '../winapp-cli-utils';
import { CommentPayload } from './devtools-types';

export interface DevToolsApp {
    processId: number;
    processName: string;
    windowTitle?: string;
    attached: boolean;
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('The DevTools CLI returned an invalid object.');
    }
    return value as Record<string, unknown>;
}

export function parseApps(value: unknown): DevToolsApp[] {
    const result = record(value);
    if (!Array.isArray(result.apps)) { throw new Error('The DevTools CLI did not return an app list.'); }
    return result.apps.map(value => {
        const app = record(value);
        if (!Number.isSafeInteger(app.processId) || Number(app.processId) <= 0
            || typeof app.processName !== 'string' || typeof app.attached !== 'boolean') {
            throw new Error('The DevTools CLI returned an invalid app.');
        }
        return {
            processId: Number(app.processId),
            processName: app.processName,
            windowTitle: typeof app.windowTitle === 'string' ? app.windowTitle : undefined,
            attached: app.attached,
        };
    });
}

/** The one-line reason a --json CLI result carries, whatever casing the command uses. */
export function cliErrorText(result: Record<string, unknown> | undefined): string | undefined {
    const value = result?.error ?? result?.Error ?? result?.message;
    if (typeof value === 'string' && value.trim()) { return value.trim(); }
    if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === 'string' && nested.trim()) { return nested.trim(); }
    }
    return undefined;
}

/** Mirrors the CLI's CommentViewBuilder.AnchorHealthWarning, which `--json` does not serialize. */
function placementDiagnostic(row: Record<string, unknown>, anchor: Record<string, unknown>,
    identity: Record<string, unknown>, hitCount: number): string | undefined {
    const text = (value: unknown) => typeof value === 'string' && value.length > 0;
    const sourceFile = text(anchor.sourceFile);
    const resolvable = text(identity.name)
        || (text(identity.automationId) && identity.automationId !== '0' && identity.automationId !== identity.name)
        || (typeof identity.content === 'string' && identity.content.trim().length >= 2)
        || (text(identity.type) && sourceFile);
    if (hitCount === 0 && !resolvable) {
        return 'Saved without source identity, so it cannot be re-anchored. Re-add the comment on the running app.';
    }
    if (!sourceFile) {
        return hitCount > 0
            ? 'Not linked to source. Candidates come from a source-wide search and need confirmation.'
            : 'Not linked to source, and no source candidates were found.';
    }
    if (row.requiresConfirmation === true) {
        const reason = typeof row.candidatesReason === 'string' ? ` (${row.candidatesReason})` : '';
        return `Current source candidates need confirmation${reason}.`;
    }
    if (hitCount === 0) {
        return 'No current source match. The source may be unavailable, or the element was renamed or removed.';
    }
    return undefined;
}
/** Offline CLI comments have source anchors, not live engine handles. */
export function parseSavedComments(value: unknown, sourceRoot: string): CommentPayload[] {
    const result = record(value);
    if (!Array.isArray(result.comments)) { throw new Error('The DevTools CLI did not return comments.'); }
    const app = result.app === undefined ? {} : record(result.app);
    const repositoryRoot = typeof app.storePath === 'string'
        ? path.dirname(path.dirname(app.storePath)) : sourceRoot;
    return result.comments.map(value => {
        const row = record(value);
        if (typeof row.id !== 'string' || typeof row.text !== 'string') {
            throw new Error('The DevTools CLI returned an invalid comment.');
        }
        const anchor = record(row.anchor);
        const identity = anchor.identity === undefined ? {} : record(anchor.identity);
        const hits = Array.isArray(row.hits)
            ? row.hits.filter((hit): hit is Record<string, unknown> => !!hit && typeof hit === 'object') : [];
        // A confirmed anchor's first hit is where the element is declared now, not where it was commented.
        const current = row.anchorConfirmed === true && typeof hits[0]?.file === 'string' ? hits[0] : undefined;
        const reported = current ? current.file : anchor.sourceFile;
        const file = typeof reported === 'string' && reported
            ? path.resolve(repositoryRoot, reported) : undefined;
        const line = current && typeof current.line === 'number' ? current.line
            : typeof anchor.line === 'number' ? anchor.line : undefined;
        return {
            id: row.id,
            text: row.text,
            status: typeof row.status === 'string' ? row.status : undefined,
            element: typeof identity.name === 'string' ? identity.name : undefined,
            file,
            line,
            requiresConfirmation: row.requiresConfirmation === true,
            diagnostic: placementDiagnostic(row, anchor, identity, hits.length),
        };
    });
}

export class DevToolsCli {
    constructor(
        private readonly extensionPath: string,
        private readonly log: (message: string) => void,
    ) {}

    async run(args: string[], cwd: string): Promise<Record<string, unknown>> {
        const output = await this.exec(args, cwd);
        const result = extractJsonObject(output);
        if (!result) { throw new Error('The DevTools CLI returned no JSON result.'); }
        if (result.ok === false || result.Ok === false) {
            throw new Error(cliErrorText(result) ?? `DevTools command failed: ${JSON.stringify(result)}`);
        }
        return result;
    }

    private exec(args: string[], cwd: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            execFile(getWinappCliPath(this.extensionPath), [...args, '--json'], {
                cwd,
                shell: false,
                windowsHide: true,
                timeout: 60_000,
                maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE },
            }, (error, stdout, stderr) => {
                if (error) {
                    // A failing --json command still reports its reason on stdout.
                    const detail = cliErrorText(extractJsonObject(stdout))
                        || stderr.trim() || stdout.trim() || error.message;
                    this.log(`winapp ${args.join(' ')} failed: ${detail}`);
                    reject(new Error(detail));
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    async comments(sourceRoot: string): Promise<CommentPayload[]> {
        return parseSavedComments(await this.run(
            ['devtools', 'comments', 'list', '--source-root', sourceRoot], sourceRoot,
        ), sourceRoot);
    }

    /**
     * Explains why the comment store cannot be used, or undefined when it is healthy.
     * The engine reports store failures generically, so the CLI and the file are asked directly.
     */
    async commentStoreProblem(sourceRoot: string): Promise<string | undefined> {
        let result: Record<string, unknown>;
        try {
            result = await this.run(['devtools', 'comments', 'list', '--source-root', sourceRoot], sourceRoot);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        const app = result.app && typeof result.app === 'object' ? result.app as Record<string, unknown> : {};
        const storePath = typeof app.storePath === 'string' ? app.storePath : undefined;
        if (!storePath) { return undefined; }
        try {
            const stat = await fs.promises.stat(storePath);
            // Windows read-only is the file attribute, which surfaces as a missing owner write bit.
            if ((stat.mode & 0o200) === 0) { return `The comment store ${storePath} is read-only.`; }
            await fs.promises.access(storePath, fs.constants.W_OK);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') { return undefined; }
            return `The comment store ${storePath} cannot be written (${code ?? 'access denied'}).`;
        }
        return undefined;
    }

    /** Window titles by HWND, for labelling the surface picker. Empty when the CLI cannot tell. */
    async windowTitles(processId: number, cwd: string): Promise<Map<string, string>> {
        const titles = new Map<string, string>();
        let rows: unknown;
        try {
            rows = JSON.parse(await this.exec(['ui', 'list-windows', '-a', String(processId)], cwd));
        } catch {
            return titles;
        }
        if (!Array.isArray(rows)) { return titles; }
        for (const row of rows) {
            if (!row || typeof row !== 'object') { continue; }
            const { hwnd, title, processId: owner } = row as Record<string, unknown>;
            if (owner !== undefined && owner !== processId) { continue; }
            if ((typeof hwnd === 'number' || typeof hwnd === 'string') && typeof title === 'string' && title.trim()) {
                titles.set(String(hwnd), title.trim());
            }
        }
        return titles;
    }

    async changeComment(sourceRoot: string, id: string, action: 'resolve' | 'delete'): Promise<void> {
        const args = action === 'resolve'
            ? ['devtools', 'comments', 'update', id, '--status', 'resolved']
            : ['devtools', 'comments', 'delete', id];
        await this.run([...args, '--source-root', sourceRoot], sourceRoot);
    }
}

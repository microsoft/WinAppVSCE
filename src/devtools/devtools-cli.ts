import { execFile } from 'child_process';
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
        const file = typeof anchor.sourceFile === 'string' && anchor.sourceFile
            ? path.resolve(repositoryRoot, anchor.sourceFile) : undefined;
        return {
            id: row.id,
            text: row.text,
            status: typeof row.status === 'string' ? row.status : undefined,
            element: typeof identity.name === 'string' ? identity.name : undefined,
            file,
            line: typeof anchor.line === 'number' ? anchor.line : undefined,
            requiresConfirmation: row.requiresConfirmation === true,
        };
    });
}

export class DevToolsCli {
    constructor(
        private readonly extensionPath: string,
        private readonly log: (message: string) => void,
    ) {}

    async run(args: string[], cwd: string): Promise<Record<string, unknown>> {
        const output = await new Promise<string>((resolve, reject) => {
            execFile(getWinappCliPath(this.extensionPath), [...args, '--json'], {
                cwd,
                shell: false,
                windowsHide: true,
                timeout: 60_000,
                maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, WINAPP_CLI_CALLER: WINAPP_CLI_CALLER_VALUE },
            }, (error, stdout, stderr) => {
                if (error) {
                    const detail = stderr.trim() || stdout.trim() || error.message;
                    this.log(`winapp ${args.join(' ')} failed: ${detail}`);
                    reject(new Error(detail));
                } else {
                    resolve(stdout);
                }
            });
        });
        const result = extractJsonObject(output);
        if (!result) { throw new Error('The DevTools CLI returned no JSON result.'); }
        if (result.ok === false) {
            throw new Error(`DevTools command failed: ${JSON.stringify(result.error ?? result)}`);
        }
        return result;
    }

    async comments(sourceRoot: string): Promise<CommentPayload[]> {
        return parseSavedComments(await this.run(
            ['devtools', 'comments', 'list', '--source-root', sourceRoot], sourceRoot,
        ), sourceRoot);
    }

    async changeComment(sourceRoot: string, id: string, action: 'resolve' | 'delete'): Promise<void> {
        const args = action === 'resolve'
            ? ['devtools', 'comments', 'update', id, '--status', 'resolved']
            : ['devtools', 'comments', 'delete', id];
        await this.run([...args, '--source-root', sourceRoot], sourceRoot);
    }
}

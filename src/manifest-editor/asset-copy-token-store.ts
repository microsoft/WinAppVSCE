import * as crypto from 'crypto';

/** Keeps external file paths in the extension host and exposes only single-use tokens to the webview. */
export class AssetCopyTokenStore {
    private readonly pathsByToken = new Map<string, string>();

    public issue(sourcePath: string): string {
        const token = crypto.randomUUID();
        this.pathsByToken.set(token, sourcePath);
        return token;
    }

    public consume(token: string): string | undefined {
        const sourcePath = this.pathsByToken.get(token);
        if (sourcePath !== undefined) {
            this.pathsByToken.delete(token);
        }
        return sourcePath;
    }
}

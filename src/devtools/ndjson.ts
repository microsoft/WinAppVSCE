/**
 * Newline-delimited JSON framing for the DevTools pipe transport.
 *
 * Split out from the client so the framing rules — UTF-8 continuation bytes
 * split across chunk boundaries, blank-line tolerance, and the oversize-line
 * guard — can be unit tested without opening a socket.
 */

import { StringDecoder } from 'string_decoder';

/**
 * Hard cap on a single NDJSON line before the stream is considered malformed.
 *
 * The engine refuses *inbound* lines over 64 KB, but responses it sends us
 * (a deep `VisualTree.enumerate`, for instance) are legitimately much larger,
 * so this ceiling only exists to stop an unterminated stream from growing the
 * buffer without bound.
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

export class NdjsonParseError extends Error { }

/**
 * Accumulates socket chunks and emits one parsed JSON value per complete line.
 *
 * Decoding is done through a {@link StringDecoder} so a multi-byte character
 * straddling two chunks is held back rather than corrupted.
 */
export class NdjsonFramer {
    private readonly decoder = new StringDecoder('utf8');
    private buffer = '';

    /**
     * Feeds a chunk and returns every JSON value completed by it.
     *
     * Lines that are blank or whitespace-only are skipped. A line that is not
     * valid JSON throws, since silently dropping a response would leave the
     * matching request pending until it times out.
     */
    push(chunk: Buffer | string): unknown[] {
        this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

        if (this.buffer.length > MAX_LINE_BYTES) {
            const size = this.buffer.length;
            this.buffer = '';
            throw new NdjsonParseError(
                `DevTools stream exceeded ${MAX_LINE_BYTES} bytes without a newline (${size} buffered); dropping connection.`
            );
        }

        const messages: unknown[] = [];
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex !== -1) {
            // Tolerate CRLF as well as LF.
            const raw = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (raw.trim().length > 0) {
                try {
                    messages.push(JSON.parse(raw));
                } catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    throw new NdjsonParseError(`Malformed JSON on DevTools pipe: ${detail}`);
                }
            }

            newlineIndex = this.buffer.indexOf('\n');
        }

        return messages;
    }

    /** Number of bytes buffered awaiting a newline. Exposed for diagnostics. */
    get pending(): number {
        return this.buffer.length;
    }

    reset(): void {
        this.buffer = '';
    }
}

/** Serializes a JSON-RPC message as a single NDJSON line. */
export function encodeNdjson(message: unknown): string {
    return JSON.stringify(message) + '\n';
}

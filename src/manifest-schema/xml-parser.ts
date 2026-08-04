/**
 * Shared XML parsing for AppxManifest files.
 * Provides a single DOMParser entry point used by both the manifest editor
 * (manifest-parser.ts) and schema validation (schema-validation.ts), so
 * the same XML text is never parsed twice.
 */

import { DOMParser } from '@xmldom/xmldom';
import type { Document } from '@xmldom/xmldom';

/** An XML parse error with location information. */
export interface XmlParseError {
    message: string;
    /** 0-based line number. */
    line: number;
    /** 0-based column number. */
    col: number;
}

/** Result of parsing manifest XML text. */
export interface XmlParseResult {
    /** The parsed DOM document (may be partial if errors were encountered). */
    doc: Document;
    /** Any non-warning errors encountered during parsing. */
    errors: XmlParseError[];
}

/**
 * Parse manifest XML text into a DOM Document, collecting any parse errors.
 * Both the manifest editor and schema validator use this single function
 * so the XML is only parsed once per consumer.
 */
export function parseManifestXml(xmlText: string): XmlParseResult {
    const errors: XmlParseError[] = [];
    const parser = new DOMParser({
        onError: (errorLevel: string, message: string) => {
            if (errorLevel === 'warning') { return; }
            const lineMatch = /line[:\s]+(\d+)/i.exec(message);
            const colMatch = /col(?:umn)?[:\s]+(\d+)/i.exec(message);
            errors.push({
                message,
                line: lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0,
                col: colMatch ? parseInt(colMatch[1], 10) - 1 : 0,
            });
        },
    });

    let doc: Document;
    try {
        doc = parser.parseFromString(xmlText, 'application/xml');
    } catch (e: unknown) {
        // fatalError (e.g. unclosed elements) throws after calling onError.
        // The error is already captured via onError above; if not, add it now.
        if (errors.length === 0) {
            const msg = e instanceof Error ? e.message : String(e);
            const lineMatch = /line[:\s]+(\d+)/i.exec(msg);
            const colMatch = /col(?:umn)?[:\s]+(\d+)/i.exec(msg);
            errors.push({
                message: msg,
                line: lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0,
                col: colMatch ? parseInt(colMatch[1], 10) - 1 : 0,
            });
        }
        // Return a minimal empty document so callers can still inspect errors
        doc = new DOMParser().parseFromString('<_/>', 'application/xml');
    }

    return { doc, errors };
}

/**
 * Applies the edits the webview flushes out of its input debounce when the document is saved.
 *
 * Kept free of `vscode` imports so the save path can be unit-tested directly.
 */

import { parseManifest, applyFieldChange, updateExtensionField } from './manifest-parser';
import { FlushedChange } from './manifest-types';

export interface FlushResult {
    /** The rewritten manifest, or the input unchanged when nothing could be applied. */
    text: string;
    /** Human-readable descriptions of the changes that threw, in queue order. */
    failed: string[];
}

/** Whether the document currently parses, i.e. whether it is safe to rewrite. */
export function documentParses(xml: string): boolean {
    try {
        parseManifest(xml);
        return true;
    } catch {
        return false;
    }
}

/** Names a change for an error message without echoing the value the user typed. */
function describeChange(change: FlushedChange): string {
    return change.kind === 'extField' ? `extension field "${change.fieldPath}"` : `field "${change.field}"`;
}

/**
 * Applies queued changes to the manifest text.
 *
 * Returns the text untouched when it cannot be parsed: a save made while the XML is broken must
 * persist what the user typed, not a re-serialised document. Changes are applied independently so
 * that one failing edit cannot silently discard the rest of the queue.
 */
export function applyFlushedChanges(text: string, changes: FlushedChange[]): FlushResult {
    const failed: string[] = [];
    if (!documentParses(text)) { return { text, failed }; }

    let result = text;
    for (const change of changes) {
        try {
            result = change.kind === 'extField'
                ? updateExtensionField(result, change.appIndex, change.extIndex, change.fieldPath, change.value, change.isTextContent)
                : applyFieldChange(result, change.section, change.field, change.value, change.index);
        } catch {
            failed.push(describeChange(change));
        }
    }
    return { text: result, failed };
}

import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';

/**
 * Read-only XML helpers for project and solution files.
 *
 * These are deliberately separate from `manifest-editor/xml-utils.ts`. That
 * module does string surgery on manifests because it must round-trip the
 * user's exact formatting; nothing here writes anything back, so a real parse
 * is both simpler and more accurate.
 *
 * Reading this XML with regular expressions got three things wrong that a
 * parser gets right for free:
 *
 * - **Comments.** `<!-- <OutputType>Library</OutputType> -->` matched, so a
 *   commented-out marker could hide a perfectly runnable project.
 * - **Quote style.** `Path='App.csproj'` is valid XML but did not match a
 *   double-quote-only pattern, so the member went missing.
 * - **Entities.** `Path="A&amp;B\App.csproj"` yielded the raw `&amp;` rather
 *   than the `&` the path actually uses.
 */

/**
 * Parses XML, returning `undefined` rather than throwing when the document is
 * malformed.
 *
 * Callers are classifying files that the user merely happens to have in the
 * workspace, so a broken or half-written file must degrade to "I don't know"
 * instead of breaking discovery. Parser diagnostics are swallowed for the same
 * reason — and because `@xmldom/xmldom` otherwise writes them to the console,
 * which would be noise in the extension host log.
 */
export function tryParseXml(content: string): Document | undefined {
	let failed = false;
	const parser = new DOMParser({
		onError: (level: string) => {
			if (level !== 'warning') {
				failed = true;
			}
		}
	});

	let doc: Document | undefined;
	try {
		doc = parser.parseFromString(content, 'text/xml');
	} catch {
		return undefined;
	}

	if (failed || !doc?.documentElement) {
		return undefined;
	}
	return doc;
}

/**
 * Every element in the document with the given local name, ignoring namespace
 * prefixes.
 *
 * Project and solution files are not consistently namespaced — an SDK-style
 * `.csproj` has no namespace while a legacy one uses the MSBuild namespace —
 * so matching on local name keeps both working.
 */
export function findElementsByLocalName(doc: Document, localName: string): Element[] {
	const wanted = localName.toLowerCase();
	const results: Element[] = [];
	const all = doc.getElementsByTagName('*');
	for (let index = 0; index < all.length; index++) {
		const element = all[index];
		const name = (element.localName || element.nodeName || '').toLowerCase();
		if (name === wanted) {
			results.push(element);
		}
	}
	return results;
}

/**
 * An element's direct text content, with surrounding whitespace removed.
 *
 * Only child text nodes are read, so a nested element cannot contribute to the
 * value the way `textContent` would.
 */
export function elementText(element: Element): string {
	let text = '';
	const children = element.childNodes;
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		// 3 = TEXT_NODE, 4 = CDATA_SECTION_NODE
		if (child.nodeType === 3 || child.nodeType === 4) {
			text += child.nodeValue ?? '';
		}
	}
	return text.trim();
}

/** Case-insensitive attribute lookup, since MSBuild attribute casing varies. */
export function attributeValue(element: Element, name: string): string | undefined {
	const direct = element.getAttribute(name);
	if (direct !== null && direct !== undefined) {
		return direct;
	}

	const wanted = name.toLowerCase();
	const attributes = element.attributes;
	for (let index = 0; index < attributes.length; index++) {
		const attribute = attributes[index];
		if ((attribute.localName || attribute.name || '').toLowerCase() === wanted) {
			return attribute.value;
		}
	}
	return undefined;
}

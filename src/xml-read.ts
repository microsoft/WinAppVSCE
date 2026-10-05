import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';

/** Real XML parsing avoids regex mistakes with comments, quote style, and entities. */

/** An XML parse error with location information. */
export interface XmlParseError {
	message: string;
	/** 0-based line number. */
	line: number;
	/** 0-based column number. */
	col: number;
}

/** Result of parsing XML text. */
export interface XmlParseResult {
	/** The parsed DOM document (may be partial if errors were encountered). */
	doc: Document;
	/** Any non-warning errors encountered during parsing. */
	errors: XmlParseError[];
}

/** xmldom reports positions in prose, so they have to be scraped back out. */
function toParseError(message: string): XmlParseError {
	const lineMatch = /line[:\s]+(\d+)/i.exec(message);
	const colMatch = /col(?:umn)?[:\s]+(\d+)/i.exec(message);
	return {
		message,
		line: lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0,
		col: colMatch ? parseInt(colMatch[1], 10) - 1 : 0
	};
}

/**
 * The single DOMParser entry point. Collects non-warning errors instead of
 * throwing, and always returns a document so callers can inspect both.
 */
export function parseXml(xmlText: string): XmlParseResult {
	const errors: XmlParseError[] = [];
	const parser = new DOMParser({
		onError: (errorLevel: string, message: string) => {
			if (errorLevel === 'warning') { return; }
			errors.push(toParseError(message));
		}
	});

	let doc: Document;
	try {
		doc = parser.parseFromString(xmlText, 'application/xml');
	} catch (e: unknown) {
		// fatalError (e.g. unclosed elements) throws after calling onError.
		// The error is already captured via onError above; if not, add it now.
		if (errors.length === 0) {
			errors.push(toParseError(e instanceof Error ? e.message : String(e)));
		}
		// Return a minimal empty document so callers can still inspect errors
		doc = new DOMParser().parseFromString('<_/>', 'application/xml');
	}

	return { doc, errors };
}

/** Malformed workspace XML degrades to unknown and suppresses parser log noise. */
export function tryParseXml(content: string): Document | undefined {
	const { doc, errors } = parseXml(content);
	if (errors.length > 0 || !doc.documentElement) {
		return undefined;
	}
	return doc;
}

/** Match local names so SDK-style and legacy MSBuild namespaces both work. */
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

/** Direct child text only; nested elements must not contribute. */
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

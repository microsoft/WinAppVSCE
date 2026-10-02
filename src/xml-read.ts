import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';

/** Real XML parsing avoids regex mistakes with comments, quote style, and entities. */

/** Malformed workspace XML degrades to unknown and suppresses parser log noise. */
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

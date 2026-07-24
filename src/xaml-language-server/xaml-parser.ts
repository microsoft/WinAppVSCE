export interface XamlAttribute {
	name: string;
	prefix?: string;
	value: string;
	valueStart: Position;
	valueEnd: Position;
	nameStart: Position;
	nameEnd: Position;
}

export interface XamlElement {
	name: string;
	prefix?: string;
	attributes: XamlAttribute[];
	children: XamlElement[];
	parent?: XamlElement;
	start: Position;
	end: Position;
	selfClosing: boolean;
	namespaces: Map<string, string>;
}

export interface XamlDocument {
	root: XamlElement | undefined;
	elements: XamlElement[];
	namespaces: Map<string, string>;
	errors: ParseError[];
}

export interface ParseError {
	message: string;
	range: { start: Position; end: Position };
}

export interface Position {
	line: number;
	character: number;
}

export interface CursorContext {
	type: 'element-name' | 'attribute-name' | 'attribute-value' | 'element-content' | 'none';
	element?: XamlElement;
	attribute?: XamlAttribute;
	prefix?: string;
	partialName?: string;
}

interface TagToken {
	raw: string;
	startOffset: number;
	endOffset: number;
}

interface LineIndex {
	lineStarts: number[];
	textLength: number;
}

const tagPattern = /<!--[\s\S]*?(?:-->|$)|<[^<]*?(?:>|$)/g;

function createLineIndex(text: string): LineIndex {
	const lineStarts = [0];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === '\n') {
			lineStarts.push(index + 1);
		}
	}
	return { lineStarts, textLength: text.length };
}

function offsetToPosition(lineIndex: LineIndex, offset: number): Position {
	const bounded = Math.max(0, Math.min(offset, lineIndex.textLength));
	let low = 0;
	let high = lineIndex.lineStarts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (lineIndex.lineStarts[mid] <= bounded && (mid === lineIndex.lineStarts.length - 1 || lineIndex.lineStarts[mid + 1] > bounded)) {
			return { line: mid, character: bounded - lineIndex.lineStarts[mid] };
		}
		if (lineIndex.lineStarts[mid] > bounded) {
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}
	return { line: 0, character: bounded };
}

function positionToOffset(text: string, lineIndex: LineIndex, position: Position): number {
	if (position.line < 0) {
		return 0;
	}
	const lineStart = lineIndex.lineStarts[Math.min(position.line, lineIndex.lineStarts.length - 1)] ?? text.length;
	return Math.max(0, Math.min(lineStart + Math.max(position.character, 0), text.length));
}

function comparePositions(left: Position, right: Position): number {
	if (left.line !== right.line) {
		return left.line - right.line;
	}
	return left.character - right.character;
}

function containsPosition(start: Position, end: Position, position: Position): boolean {
	return comparePositions(start, position) <= 0 && comparePositions(position, end) <= 0;
}

function tokenizeTags(text: string): TagToken[] {
	const tokens: TagToken[] = [];
	for (const match of text.matchAll(tagPattern)) {
		tokens.push({
			raw: match[0],
			startOffset: match.index ?? 0,
			endOffset: (match.index ?? 0) + match[0].length
		});
	}
	return tokens;
}

function splitQualifiedName(name: string): { prefix?: string; name: string } {
	const separator = name.indexOf(':');
	if (separator < 0) {
		return { name };
	}
	return {
		prefix: name.slice(0, separator),
		name: name.slice(separator + 1)
	};
}

function parseAttributes(tagText: string, tagStartOffset: number, lineIndex: LineIndex): XamlAttribute[] {
	const attributes: XamlAttribute[] = [];
	let cursor = tagText.indexOf('<') + 1;
	while (cursor < tagText.length && /\s/.test(tagText[cursor] ?? '')) {
		cursor += 1;
	}
	if (tagText[cursor] === '/') {
		cursor += 1;
	}
	while (cursor < tagText.length && /[^\s/>]/.test(tagText[cursor] ?? '')) {
		cursor += 1;
	}

	while (cursor < tagText.length) {
		while (cursor < tagText.length && /\s/.test(tagText[cursor] ?? '')) {
			cursor += 1;
		}
		const current = tagText[cursor];
		if (!current || current === '>' || current === '/') {
			break;
		}

		const nameStartOffset = tagStartOffset + cursor;
		const nameStart = offsetToPosition(lineIndex, nameStartOffset);
		let attributeName = '';
		while (cursor < tagText.length && /[^\s=/>]/.test(tagText[cursor] ?? '')) {
			attributeName += tagText[cursor];
			cursor += 1;
		}
		const nameEnd = offsetToPosition(lineIndex, tagStartOffset + cursor);

		while (cursor < tagText.length && /\s/.test(tagText[cursor] ?? '')) {
			cursor += 1;
		}

		let value = '';
		let valueStartOffset = tagStartOffset + cursor;
		let valueEndOffset = tagStartOffset + cursor;
		if (tagText[cursor] === '=') {
			cursor += 1;
			while (cursor < tagText.length && /\s/.test(tagText[cursor] ?? '')) {
				cursor += 1;
			}
			const quote = tagText[cursor];
			if (quote === '"' || quote === '\'') {
				cursor += 1;
				valueStartOffset = tagStartOffset + cursor;
				while (cursor < tagText.length && tagText[cursor] !== quote) {
					value += tagText[cursor];
					cursor += 1;
				}
				valueEndOffset = tagStartOffset + cursor;
				if (tagText[cursor] === quote) {
					cursor += 1;
				}
			} else {
				valueStartOffset = tagStartOffset + cursor;
				while (cursor < tagText.length && /[^\s>]/.test(tagText[cursor] ?? '')) {
					value += tagText[cursor];
					cursor += 1;
				}
				valueEndOffset = tagStartOffset + cursor;
			}
		}

		const { prefix, name } = splitQualifiedName(attributeName);
		attributes.push({
			name,
			prefix,
			value,
			valueStart: offsetToPosition(lineIndex, valueStartOffset),
			valueEnd: offsetToPosition(lineIndex, valueEndOffset),
			nameStart,
			nameEnd
		});
	}

	return attributes;
}

function cloneNamespaces(source?: Map<string, string>): Map<string, string> {
	return new Map(source ? [...source.entries()] : []);
}

/**
 * Parses XAML using a tolerant regex-based scanner suitable for editor features.
 */
export function parseXaml(text: string): XamlDocument {
	const lineIndex = createLineIndex(text);
	const tokens = tokenizeTags(text);
	const document: XamlDocument = {
		root: undefined,
		elements: [],
		namespaces: new Map<string, string>(),
		errors: []
	};
	const stack: XamlElement[] = [];

	for (const token of tokens) {
		if (token.raw.startsWith('<!--')) {
			continue;
		}

		const closingMatch = /^<\s*\/\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(token.raw);
		if (closingMatch) {
			const closingName = closingMatch[1];
			let matchIndex = -1;
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				const candidate = stack[index];
				const candidateName = candidate.prefix ? `${candidate.prefix}:${candidate.name}` : candidate.name;
				if (candidateName === closingName) {
					matchIndex = index;
					break;
				}
			}

			const closeEnd = offsetToPosition(lineIndex, token.endOffset);
			if (matchIndex >= 0) {
				for (let index = stack.length - 1; index >= matchIndex; index -= 1) {
					const element = stack.pop();
					if (!element) {
						continue;
					}
					element.end = closeEnd;
					if (index !== matchIndex) {
						document.errors.push({
							message: `Unclosed tag <${element.prefix ? `${element.prefix}:` : ''}${element.name}>.`,
							range: { start: element.start, end: element.end }
						});
					}
				}
			} else {
				document.errors.push({
					message: `Unexpected closing tag ${closingName}.`,
					range: {
						start: offsetToPosition(lineIndex, token.startOffset),
						end: closeEnd
					}
				});
			}
			continue;
		}

		const openMatch = /^<\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(token.raw);
		if (!openMatch) {
			continue;
		}

		const qualifiedName = openMatch[1];
		const { prefix, name } = splitQualifiedName(qualifiedName);
		const parent = stack[stack.length - 1];
		const element: XamlElement = {
			name,
			prefix,
			attributes: parseAttributes(token.raw, token.startOffset, lineIndex),
			children: [],
			parent,
			start: offsetToPosition(lineIndex, token.startOffset),
			end: offsetToPosition(lineIndex, token.endOffset),
			selfClosing: /\/\s*>$/.test(token.raw),
			namespaces: cloneNamespaces(parent?.namespaces ?? document.namespaces)
		};

		for (const attribute of element.attributes) {
			const fullName = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
			if (fullName === 'xmlns') {
				element.namespaces.set('', attribute.value);
				document.namespaces.set('', attribute.value);
			} else if (attribute.prefix === 'xmlns') {
				element.namespaces.set(attribute.name, attribute.value);
				document.namespaces.set(attribute.name, attribute.value);
			}
		}

		if (parent) {
			parent.children.push(element);
		}
		if (!document.root) {
			document.root = element;
		}
		document.elements.push(element);

		if (!element.selfClosing) {
			stack.push(element);
		}
	}

	for (const element of stack.reverse()) {
		element.end = offsetToPosition(lineIndex, text.length);
		document.errors.push({
			message: `Unclosed tag <${element.prefix ? `${element.prefix}:` : ''}${element.name}>.`,
			range: { start: element.start, end: element.end }
		});
	}

	return document;
}

/**
 * Resolves an in-scope namespace URI for a prefix on an element.
 */
export function resolveNamespace(element: XamlElement, prefix: string): string | undefined {
	return element.namespaces.get(prefix);
}

/**
 * Finds the deepest element containing the given position.
 */
export function findElementAtPosition(document: XamlDocument, position: Position): XamlElement | undefined {
	let bestMatch: XamlElement | undefined;
	for (const element of document.elements) {
		if (containsPosition(element.start, element.end, position)) {
			if (!bestMatch
				|| comparePositions(bestMatch.start, element.start) <= 0
				&& comparePositions(bestMatch.end, element.end) >= 0) {
				bestMatch = element;
			}
		}
	}
	return bestMatch;
}

function getPartialToken(text: string, offset: number): string {
	let start = offset;
	while (start > 0 && /[\w:.-]/.test(text[start - 1] ?? '')) {
		start -= 1;
	}
	return text.slice(start, offset);
}

/**
 * Computes the current editor context at a cursor location.
 */
export function getCursorContext(text: string, position: Position): CursorContext {
	const lineIndex = createLineIndex(text);
	const offset = positionToOffset(text, lineIndex, position);
	const document = parseXaml(text);
	const elementAtPosition = findElementAtPosition(document, position);

	for (const token of tokenizeTags(text)) {
		if (offset < token.startOffset || offset > token.endOffset) {
			continue;
		}
		if (token.raw.startsWith('<!--')) {
			return { type: 'none' };
		}

		const openMatch = /^<\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(token.raw);
		if (openMatch) {
			const nameOffsetInToken = token.raw.indexOf(openMatch[1]);
			const nameStart = token.startOffset + nameOffsetInToken;
			const nameEnd = nameStart + openMatch[1].length;
			if (offset >= nameStart && offset <= nameEnd) {
				const partialName = text.slice(nameStart, offset);
				const { prefix } = splitQualifiedName(partialName);
				return {
					type: 'element-name',
					element: elementAtPosition,
					prefix,
					partialName
				};
			}

			const attributes = parseAttributes(token.raw, token.startOffset, lineIndex);
			for (const attribute of attributes) {
				if (containsPosition(attribute.nameStart, attribute.nameEnd, position)) {
					return {
						type: 'attribute-name',
						element: elementAtPosition,
						attribute,
						prefix: attribute.prefix,
						partialName: text.slice(positionToOffset(text, lineIndex, attribute.nameStart), offset)
					};
				}
				if (containsPosition(attribute.valueStart, attribute.valueEnd, position)
					|| comparePositions(position, attribute.valueEnd) === 0) {
					const valueStartOffset = positionToOffset(text, lineIndex, attribute.valueStart);
					return {
						type: 'attribute-value',
						element: elementAtPosition,
						attribute,
						prefix: attribute.prefix,
						partialName: text.slice(valueStartOffset, offset)
					};
				}
			}

			if (token.raw.startsWith('</')) {
				return {
					type: 'element-name',
					element: elementAtPosition,
					partialName: getPartialToken(text, offset)
				};
			}

			return {
				type: 'attribute-name',
				element: elementAtPosition,
				partialName: getPartialToken(text, offset)
			};
		}
	}

	const before = text.slice(Math.max(0, offset - 64), offset);
	if (/<\/[\w:.-]*$/.test(before)) {
		return {
			type: 'element-name',
			element: elementAtPosition,
			partialName: before.slice(before.lastIndexOf('</') + 2)
		};
	}
	if (/<[\w:.-]*$/.test(before)) {
		const partialName = before.slice(before.lastIndexOf('<') + 1);
		const { prefix } = splitQualifiedName(partialName);
		return { type: 'element-name', element: elementAtPosition, prefix, partialName };
	}

	return elementAtPosition ? { type: 'element-content', element: elementAtPosition } : { type: 'none' };
}

/**
 * Collects all x:Name declarations in the document.
 */
export function getAllXNames(document: XamlDocument): Map<string, XamlElement> {
	const names = new Map<string, XamlElement>();
	for (const element of document.elements) {
		for (const attribute of element.attributes) {
			const fullName = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
			if (fullName === 'x:Name' && attribute.value) {
				names.set(attribute.value, element);
			}
		}
	}
	return names;
}

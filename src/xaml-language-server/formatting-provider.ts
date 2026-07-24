import { Range, TextEdit } from 'vscode-languageserver';
import { Position } from './xaml-parser';

export interface FormattingOptions {
	tabSize: number;
	insertSpaces: boolean;
}

interface Token {
	raw: string;
	type: 'open' | 'close' | 'self' | 'comment' | 'text';
}

const tokenPattern = /<!--[\s\S]*?(?:-->|$)|<[^<]*?(?:>|$)|[^<]+/g;

function indent(level: number, options: FormattingOptions): string {
	const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
	return unit.repeat(Math.max(level, 0));
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	for (const match of text.matchAll(tokenPattern)) {
		const raw = match[0];
		if (raw.startsWith('<!--')) {
			tokens.push({ raw, type: 'comment' });
		} else if (raw.startsWith('</')) {
			tokens.push({ raw, type: 'close' });
		} else if (raw.startsWith('<')) {
			tokens.push({ raw, type: /\/\s*>$/.test(raw) ? 'self' : 'open' });
		} else {
			tokens.push({ raw, type: 'text' });
		}
	}
	return tokens;
}

function splitAttributes(tagText: string): { name: string; attributes: string[]; selfClosing: boolean } | null {
	const match = /^<\s*([^\s/>]+)([\s\S]*?)(\/?)>$/.exec(tagText.trim());
	if (!match) {
		return null;
	}
	const [, name, attributesText, trailingSlash] = match;
	const attributePattern = /([^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)/g;
	const attributes = [...attributesText.matchAll(attributePattern)].map((item) => item[1].trim()).filter(Boolean);
	return { name, attributes, selfClosing: trailingSlash === '/' };
}

function formatOpenTag(tagText: string, level: number, options: FormattingOptions): string {
	const parsed = splitAttributes(tagText);
	if (!parsed) {
		return `${indent(level, options)}${tagText.trim()}`;
	}

	const xmlns = parsed.attributes.filter((attribute) => attribute.startsWith('xmlns=') || attribute.startsWith('xmlns:')).sort();
	const otherAttributes = parsed.attributes.filter((attribute) => !xmlns.includes(attribute));
	const orderedAttributes = [...xmlns, ...otherAttributes];
	if (orderedAttributes.length <= 2) {
		return `${indent(level, options)}<${parsed.name}${orderedAttributes.length ? ` ${orderedAttributes.join(' ')}` : ''}${parsed.selfClosing ? ' />' : '>'}`;
	}

	const attributeIndent = indent(level + 1, options);
	const lines = [`${indent(level, options)}<${parsed.name}`];
	for (const attribute of orderedAttributes) {
		lines.push(`${attributeIndent}${attribute}`);
	}
	lines.push(`${indent(level, options)}${parsed.selfClosing ? '/>' : '>'}`);
	return lines.join('\n');
}

function formatText(raw: string, level: number, options: FormattingOptions): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return '';
	}
	return `${indent(level, options)}${trimmed}`;
}

function fullRange(text: string): Range {
	const lines = text.split('\n');
	return {
		start: { line: 0, character: 0 },
		end: {
			line: lines.length - 1,
			character: lines[lines.length - 1]?.length ?? 0
		}
	};
}

function normalizeFormattedText(lines: string[]): string {
	return `${lines.filter(Boolean).join('\n')}\n`;
}

function formatTextCore(text: string, options: FormattingOptions): string {
	const tokens = tokenize(text);
	let level = 0;
	const lines: string[] = [];
	for (const token of tokens) {
		if (token.type === 'close') {
			level -= 1;
			lines.push(`${indent(level, options)}${token.raw.trim()}`);
			continue;
		}
		if (token.type === 'open') {
			lines.push(formatOpenTag(token.raw, level, options));
			level += 1;
			continue;
		}
		if (token.type === 'self' || token.type === 'comment') {
			lines.push(formatOpenTag(token.raw, level, options));
			continue;
		}
		const textLine = formatText(token.raw, level, options);
		if (textLine) {
			lines.push(textLine);
		}
	}
	return normalizeFormattedText(lines);
}

/**
 * Formats the entire XAML document.
 */
export function formatDocument(text: string, options: FormattingOptions): TextEdit[] {
	return [{
		range: fullRange(text),
		newText: formatTextCore(text, options)
	}];
}

function sliceRange(text: string, startPos: Position, endPos: Position): { text: string; startOffset: number; endOffset: number } {
	const lines = text.split('\n');
	let startOffset = 0;
	for (let line = 0; line < startPos.line; line += 1) {
		startOffset += (lines[line]?.length ?? 0) + 1;
	}
	startOffset += startPos.character;

	let endOffset = 0;
	for (let line = 0; line < endPos.line; line += 1) {
		endOffset += (lines[line]?.length ?? 0) + 1;
	}
	endOffset += endPos.character;

	return { text: text.slice(startOffset, endOffset), startOffset, endOffset };
}

/**
 * Formats a range inside the XAML document.
 */
export function formatRange(text: string, startPos: Position, endPos: Position, options: FormattingOptions): TextEdit[] {
	const selection = sliceRange(text, startPos, endPos);
	return [{
		range: { start: startPos, end: endPos },
		newText: formatTextCore(selection.text, options)
	}];
}

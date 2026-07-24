import { Location, Position as LspPosition } from 'vscode-languageserver';
import { Position, XamlAttribute, parseXaml } from './xaml-parser';

function makeLocation(uri: string, start: Position, end: Position): Location {
	return {
		uri,
		range: { start, end }
	};
}

function getAttributeName(attribute: XamlAttribute): string {
	return `${attribute.prefix ? `${attribute.prefix}:` : ''}${attribute.name}`;
}

function tryGetReferencedName(attribute: XamlAttribute): string | undefined {
	const attributeName = getAttributeName(attribute);
	if ((attributeName === 'ElementName' || attributeName.endsWith('.TargetName')) && attribute.value) {
		return attribute.value;
	}

	const markupMatch = /\bElementName\s*=\s*([^,}]+)/.exec(attribute.value);
	if (markupMatch) {
		return markupMatch[1].trim();
	}

	if (attribute.value.startsWith('{StaticResource ') || attribute.value.startsWith('{ThemeResource ')) {
		return attribute.value.replace(/^\{(?:StaticResource|ThemeResource)\s+/, '').replace(/\}$/, '').trim();
	}

	return undefined;
}

/**
 * Finds a same-file definition for x:Name and resource key references.
 */
export function getDefinition(text: string, position: Position, documentUri: string): Location | null {
	const document = parseXaml(text);

	for (const element of document.elements) {
		for (const attribute of element.attributes) {
			if ((position.line < attribute.valueStart.line || position.line > attribute.valueEnd.line)) {
				continue;
			}
			const token = tryGetReferencedName(attribute);
			if (!token) {
				continue;
			}
			for (const candidate of document.elements) {
				for (const candidateAttribute of candidate.attributes) {
					const candidateName = getAttributeName(candidateAttribute);
					if ((candidateName === 'x:Name' || candidateName === 'x:Key') && candidateAttribute.value === token) {
						return makeLocation(documentUri, candidateAttribute.valueStart, candidateAttribute.valueEnd);
					}
				}
			}
		}
	}

	return null;
}

/**
 * Finds same-file references for x:Name and resource keys.
 */
export function getReferences(text: string, position: Position, documentUri: string): Location[] {
	const document = parseXaml(text);
	let lookup: string | undefined;

	for (const element of document.elements) {
		for (const attribute of element.attributes) {
			const name = getAttributeName(attribute);
			const insideValue = position.line >= attribute.valueStart.line && position.line <= attribute.valueEnd.line;
			if (!insideValue) {
				continue;
			}
			if (name === 'x:Name' || name === 'x:Key') {
				lookup = attribute.value;
			} else {
				lookup = tryGetReferencedName(attribute);
			}
			if (lookup) {
				break;
			}
		}
		if (lookup) {
			break;
		}
	}

	if (!lookup) {
		return [];
	}

	const results: Location[] = [];
	for (const element of document.elements) {
		for (const attribute of element.attributes) {
			const name = getAttributeName(attribute);
			const referenceName = name === 'x:Name' || name === 'x:Key' ? attribute.value : tryGetReferencedName(attribute);
			if (referenceName === lookup) {
				results.push({
					uri: documentUri,
					range: {
						start: attribute.valueStart as LspPosition,
						end: attribute.valueEnd as LspPosition
					}
				});
			}
		}
	}

	return results;
}

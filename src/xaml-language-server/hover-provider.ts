import { Hover, MarkupKind } from 'vscode-languageserver';
import { findPropertyInfo, getTypeByName } from './winui-metadata';
import { Position, getCursorContext } from './xaml-parser';

function formatMarkdown(lines: string[]): Hover {
	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: lines.join('\n\n')
		}
	};
}

/**
 * Provides hover content for XAML elements and attributes.
 */
export function getHover(text: string, position: Position): Hover | null {
	const context = getCursorContext(text, position);
	const typeName = context.element ? `${context.element.prefix ? `${context.element.prefix}:` : ''}${context.element.name}` : undefined;

	if (context.type === 'element-name' && typeName) {
		const typeInfo = getTypeByName(typeName);
		if (!typeInfo) {
			return null;
		}
		return formatMarkdown([
			`### ${context.element?.prefix ? `${context.element.prefix}:` : ''}${typeInfo.name}`,
			typeInfo.description,
			`- Namespace: \`${typeInfo.namespace}\``,
			typeInfo.baseType ? `- Base type: \`${typeInfo.baseType}\`` : '',
			typeInfo.contentProperty ? `- Content property: \`${typeInfo.contentProperty}\`` : ''
		].filter(Boolean));
	}

	if ((context.type === 'attribute-name' || context.type === 'attribute-value') && context.attribute && typeName) {
		const attributeName = `${context.attribute.prefix ? `${context.attribute.prefix}:` : ''}${context.attribute.name}`;
		const property = findPropertyInfo(typeName, attributeName);
		if (!property) {
			return null;
		}
		return formatMarkdown([
			`### ${attributeName}`,
			property.description,
			`- Type: \`${property.type}\``,
			property.values?.length ? `- Valid values: ${property.values.map((value) => `\`${value}\``).join(', ')}` : ''
		].filter(Boolean));
	}

	return null;
}

import { CompletionItem, CompletionItemKind } from 'vscode-languageserver';
import {
	findPropertyInfo,
	getAllEventsForType,
	getAllPropertiesForType,
	getAttachedProperties,
	getCommonBrushes,
	getNamespaces,
	getThemeResources,
	getTypeByName,
	getWinUITypes
} from './winui-metadata';
import { Position, getCursorContext, parseXaml } from './xaml-parser';

interface CompletionSettings {
	includeCustomControls: boolean;
}

const markupExtensions = [
	'{Binding }',
	'{x:Bind }',
	'{StaticResource }',
	'{ThemeResource }',
	'{x:Null}',
	'{x:Load }'
];

let completionSettings: CompletionSettings = {
	includeCustomControls: true
};

/**
 * Updates completion settings from the language server configuration.
 */
export function setCompletionSettings(settings: Partial<CompletionSettings>): void {
	completionSettings = { ...completionSettings, ...settings };
}

function createDetailText(typeName: string, description: string): string {
	return `${typeName} — ${description}`;
}

function getElementTypeName(elementName?: string, prefix?: string): string | undefined {
	if (!elementName) {
		return undefined;
	}
	return prefix ? `${prefix}:${elementName}` : elementName;
}

function collectCustomElementNames(text: string): string[] {
	const document = parseXaml(text);
	const customElements = new Set<string>();
	for (const element of document.elements) {
		if (element.prefix && element.prefix !== 'x') {
			customElements.add(`${element.prefix}:${element.name}`);
		}
	}
	return [...customElements];
}

function createNamespaceCompletionItems(): CompletionItem[] {
	return getNamespaces().map((namespace) => {
		const label = namespace.prefix ? `xmlns:${namespace.prefix}` : 'xmlns';
		return {
			label,
			kind: CompletionItemKind.Property,
			detail: namespace.uri,
			documentation: `Declares the ${namespace.prefix || 'default'} XAML namespace.`,
			insertText: `${label}="${namespace.uri}"`
		};
	});
}

function createElementCompletionItems(text: string): CompletionItem[] {
	const winUITypes = [...new Set([...getWinUITypes().values()])]
		.filter((type) => !type.name.includes(':'))
		.map((type) => ({
			label: type.namespace.endsWith('/xaml') ? `x:${type.name}` : type.name,
			kind: CompletionItemKind.Class,
			detail: type.namespace,
			documentation: createDetailText(type.name, type.description)
		}));
	const customControls = completionSettings.includeCustomControls
		? collectCustomElementNames(text).map((label) => ({
			label,
			kind: CompletionItemKind.Class,
			detail: 'Custom control',
			documentation: 'Custom control discovered in the current document.'
		}))
		: [];
	return [...winUITypes, ...customControls];
}

function createAttributeCompletionItems(typeName: string | undefined): CompletionItem[] {
	if (!typeName) {
		return createNamespaceCompletionItems();
	}
	const properties = getAllPropertiesForType(typeName).map((property) => ({
		label: property.isAttached ? `${property.ownerType}.${property.name}` : property.name,
		kind: property.isEvent ? CompletionItemKind.Event : CompletionItemKind.Property,
		detail: property.type,
		documentation: createDetailText(property.type, property.description)
	}));
	const events = getAllEventsForType(typeName).map((eventMember) => ({
		label: eventMember.name,
		kind: CompletionItemKind.Event,
		detail: 'event',
		documentation: eventMember.description
	}));
	const namespaces = createNamespaceCompletionItems();
	const attached = getAttachedProperties().map((property) => ({
		label: `${property.ownerType}.${property.name}`,
		kind: CompletionItemKind.Property,
		detail: property.type,
		documentation: createDetailText(property.type, property.description)
	}));
	return [...namespaces, ...properties, ...events, ...attached];
}

function createEnumCompletionItems(values: string[]): CompletionItem[] {
	return values.map((value) => ({
		label: value,
		kind: CompletionItemKind.EnumMember,
		detail: 'Enum value'
	}));
}

function createAttributeValueCompletionItems(typeName: string | undefined, attributeName: string | undefined): CompletionItem[] {
	if (!attributeName) {
		return [];
	}
	if (attributeName === 'xmlns' || attributeName.startsWith('xmlns:')) {
		return getNamespaces().map((namespace) => ({
			label: namespace.uri,
			kind: CompletionItemKind.Module,
			detail: `${namespace.prefix || 'default'} namespace`
		}));
	}

	const property = typeName ? findPropertyInfo(typeName, attributeName) : undefined;
	const items: CompletionItem[] = [];
	if (property?.values?.length) {
		items.push(...createEnumCompletionItems(property.values));
	}
	if (property?.type.toLowerCase().includes('brush') || /background|foreground|borderbrush/i.test(attributeName)) {
		items.push(...getCommonBrushes().map((brush) => ({
			label: brush,
			kind: CompletionItemKind.Color,
			detail: 'Brush'
		})));
		items.push(...getThemeResources().map((resource) => ({
			label: resource,
			kind: CompletionItemKind.Constant,
			detail: 'Theme resource',
			insertText: `{ThemeResource ${resource}}`
		})));
	}

	items.push(...markupExtensions.map((extension) => ({
		label: extension,
		kind: CompletionItemKind.Function,
		detail: 'Markup extension',
		insertText: extension
	})));

	return items;
}

/**
 * Provides XAML completion items for the current position.
 */
export function getCompletions(text: string, position: Position, _documentUri: string): CompletionItem[] {
	const context = getCursorContext(text, position);
	const typeName = getElementTypeName(context.element?.name, context.element?.prefix);

	switch (context.type) {
		case 'element-name':
			return createElementCompletionItems(text);
		case 'attribute-name':
			return createAttributeCompletionItems(typeName);
		case 'attribute-value': {
			const attributeName = context.attribute
				? `${context.attribute.prefix ? `${context.attribute.prefix}:` : ''}${context.attribute.name}`
				: undefined;
			return createAttributeValueCompletionItems(typeName, attributeName);
		}
		case 'element-content': {
			const items = createElementCompletionItems(text);
			if (context.element) {
				items.unshift({
					label: `</${context.element.prefix ? `${context.element.prefix}:` : ''}${context.element.name}>`,
					kind: CompletionItemKind.Class,
					detail: 'Closing tag'
				});
			}
			return items;
		}
		default:
			return [];
	}
}

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { findPropertyInfo, getCommonBrushes, getTypeByName } from './winui-metadata';
import { Position, XamlAttribute, getAllXNames, parseXaml, resolveNamespace } from './xaml-parser';

type DiagnosticsLevel = 'off' | 'error' | 'warning';

let diagnosticsLevel: DiagnosticsLevel = 'warning';

const ignoredAttributePrefixes = new Set(['d', 'mc', 'xmlns']);
const knownDirectives = new Set(['x:Name', 'x:Key', 'x:Class', 'x:DataType', 'x:Uid', 'x:Load']);

/**
 * Updates diagnostics settings from the server configuration.
 */
export function setDiagnosticsLevel(level: DiagnosticsLevel): void {
	diagnosticsLevel = level;
}

function comparePositions(left: Position, right: Position): number {
	if (left.line !== right.line) {
		return left.line - right.line;
	}
	return left.character - right.character;
}

function rangeForAttribute(attribute: XamlAttribute): { start: Position; end: Position } {
	return { start: attribute.nameStart, end: attribute.nameEnd };
}

function shouldValidateValue(value: string): boolean {
	return Boolean(value) && !value.startsWith('{') && !value.includes('{');
}

function getAttributeName(attribute: XamlAttribute): string {
	return `${attribute.prefix ? `${attribute.prefix}:` : ''}${attribute.name}`;
}

function isKnownEnumValue(attributeName: string, value: string): boolean {
	if (/brush|background|foreground|borderbrush/i.test(attributeName)) {
		return getCommonBrushes().includes(value);
	}
	return true;
}

function pushDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
	if (diagnosticsLevel === 'off') {
		return;
	}
	if (diagnosticsLevel === 'error' && diagnostic.severity !== DiagnosticSeverity.Error) {
		return;
	}
	diagnostics.push(diagnostic);
}

/**
 * Produces editor diagnostics for the XAML document.
 */
export function getDiagnostics(text: string, _documentUri: string): Diagnostic[] {
	const document = parseXaml(text);
	const diagnostics: Diagnostic[] = [];
	const names = getAllXNames(document);
	const nameLocations = new Map<string, XamlAttribute[]>();

	for (const element of document.elements) {
		const qualifiedName = `${element.prefix ? `${element.prefix}:` : ''}${element.name}`;
		const typeInfo = getTypeByName(qualifiedName) ?? getTypeByName(element.name);
		if (!typeInfo) {
			pushDiagnostic(diagnostics, {
				severity: DiagnosticSeverity.Warning,
				range: { start: element.start, end: element.end },
				message: `Unknown element type "${qualifiedName}".`
			});
		}

		for (const attribute of element.attributes) {
			const attributeName = getAttributeName(attribute);
			if (attributeName === 'x:Name') {
				const bucket = nameLocations.get(attribute.value) ?? [];
				bucket.push(attribute);
				nameLocations.set(attribute.value, bucket);
			}
			if (attributeName === 'xmlns' || attribute.prefix === 'xmlns' || knownDirectives.has(attributeName) || ignoredAttributePrefixes.has(attribute.prefix ?? '')) {
				continue;
			}
			if (!typeInfo) {
				continue;
			}

			const property = findPropertyInfo(typeInfo.name, attributeName);
			if (!property) {
				pushDiagnostic(diagnostics, {
					severity: DiagnosticSeverity.Warning,
					range: rangeForAttribute(attribute),
					message: `Unknown attribute "${attributeName}" on ${typeInfo.name}.`
				});
				continue;
			}

			if (property.values?.length && shouldValidateValue(attribute.value) && !property.values.includes(attribute.value)) {
				pushDiagnostic(diagnostics, {
					severity: DiagnosticSeverity.Error,
					range: { start: attribute.valueStart, end: attribute.valueEnd },
					message: `Invalid value "${attribute.value}" for ${attributeName}. Expected one of: ${property.values.join(', ')}.`
				});
			}

			if (shouldValidateValue(attribute.value) && !isKnownEnumValue(attributeName, attribute.value) && /brush/i.test(property.type)) {
				pushDiagnostic(diagnostics, {
					severity: DiagnosticSeverity.Warning,
					range: { start: attribute.valueStart, end: attribute.valueEnd },
					message: `Unknown brush value "${attribute.value}" for ${attributeName}.`
				});
			}
		}

		if (element.prefix) {
			const namespace = resolveNamespace(element, element.prefix);
			if (!namespace) {
				pushDiagnostic(diagnostics, {
					severity: DiagnosticSeverity.Error,
					range: { start: element.start, end: element.end },
					message: `Undeclared namespace prefix "${element.prefix}".`
				});
			}
		}
	}

	for (const [name, occurrences] of nameLocations.entries()) {
		if (!name || occurrences.length < 2 || !names.has(name)) {
			continue;
		}
		for (const occurrence of occurrences) {
			pushDiagnostic(diagnostics, {
				severity: DiagnosticSeverity.Error,
				range: { start: occurrence.valueStart, end: occurrence.valueEnd },
				message: `Duplicate x:Name "${name}".`
			});
		}
	}

	for (const error of document.errors) {
		pushDiagnostic(diagnostics, {
			severity: error.message.startsWith('Unexpected') ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
			range: error.range,
			message: error.message
		});
	}

	document.elements.sort((left, right) => comparePositions(left.start, right.start));
	return diagnostics;
}

import type { Document, Element } from '@xmldom/xmldom';
import type { ManifestDiagnostic } from './schema-validation';

const MAX_DESCENDANT_SEARCH_DEPTH = 100;

// ── Shared rule predicates (usable by both XML validator and form editor) ──

/** Maps known extension category values to their expected child element name. */
export const EXTENSION_CATEGORY_CHILD_MAP: Record<string, string> = {
    'windows.protocol': 'Protocol',
    'windows.fileTypeAssociation': 'FileTypeAssociation',
    'windows.shareTarget': 'ShareTarget',
    'windows.search': 'Search',
    'windows.backgroundTasks': 'BackgroundTasks',
    'windows.appService': 'AppService',
    'windows.preInstalledConfigTask': 'PreInstalledConfigTask',
    'windows.updateTask': 'UpdateTask',
    'windows.lockScreenCall': 'LockScreenCall',
    'windows.contactPicker': 'ContactPicker',
    'windows.accountPictureProvider': 'AccountPictureProvider',
    'windows.autoPlayContent': 'AutoPlayContent',
    'windows.autoPlayDevice': 'AutoPlayDevice',
    'windows.cachedFileUpdater': 'CachedFileUpdater',
    'windows.fileOpenPicker': 'FileOpenPicker',
    'windows.fileSavePicker': 'FileSavePicker',
    'windows.webAccountProvider': 'WebAccountProvider',
    'windows.dialProtocol': 'DialProtocol',
    'windows.appExtension': 'AppExtension',
    'windows.startupTask': 'StartupTask',
    'windows.activatableClass.inProcessServer': 'InProcessServer',
    'windows.activatableClass.outOfProcessServer': 'OutOfProcessServer',
    'windows.activatableClass.proxyStub': 'ProxyStub',
    'windows.comInterface': 'ComInterface',
    'windows.comServer': 'ComServer',
};

// ── Shared application-level rule predicates ──────────────────────────────
// Both the XML-based semantic validator and the form-based manifest editor
// validator call these so the rules are defined in exactly one place.

/** Entry points that indicate a full-trust or partial-trust application. */
const FULL_TRUST_ENTRY_POINTS = new Set([
    'Windows.FullTrustApplication',
    'Windows.PartialTrustApplication',
]);

/**
 * Whether an Application element requires an Executable attribute.
 * Full-trust, partial-trust, and hosted apps (with HostId) are exempt.
 */
export function applicationRequiresExecutable(
    entryPoint: string | null | undefined,
    hostId: string | null | undefined,
    startPage: string | null | undefined,
): boolean {
    if (startPage) { return false; } // web apps use StartPage instead
    if (entryPoint && FULL_TRUST_ENTRY_POINTS.has(entryPoint)) { return false; }
    if (hostId) { return false; }
    return true;
}

/**
 * Whether an Application with Executable also needs an EntryPoint.
 * Only required when runtimeBehavior is "windowsApp" (the default).
 */
export function executableRequiresEntryPoint(
    runtimeBehavior: string | null | undefined,
): boolean {
    const effective = (runtimeBehavior ?? 'windowsApp').trim();
    return effective === 'windowsApp';
}

/**
 * Whether StartPage and Executable conflict.
 */
export function hasStartPageExecutableConflict(
    startPage: string | null | undefined,
    executable: string | null | undefined,
): boolean {
    return !!(startPage && executable);
}

/**
 * Whether StartPage and EntryPoint conflict.
 */
export function hasStartPageEntryPointConflict(
    startPage: string | null | undefined,
    entryPoint: string | null | undefined,
): boolean {
    return !!(startPage && entryPoint);
}

interface AttributeMatch {
    name: string;
    value: string;
}

/**
 * Perform semantic validation (cross-element rules) on a parsed manifest.
 * These rules mirror the validation in the Windows OS native AppxManifestReader.
 */
export function validateSemanticRules(
    doc: Document,
    lines: string[]
): ManifestDiagnostic[] {
    const diagnostics: ManifestDiagnostic[] = [];
    const root = doc.documentElement;
    if (!root) {
        return diagnostics;
    }

    validateApplicationAttributes(root, lines, diagnostics);
    validateSupportsMultipleInstances(root, lines, diagnostics);
    validateVisualElements(root, lines, diagnostics);
    validateExtensionCategories(root, lines, diagnostics);
    validateShareTarget(root, lines, diagnostics);
    validateContentUriRules(root, lines, diagnostics);
    validateComRules(root, lines, diagnostics);
    validateResources(root, lines, diagnostics);

    return diagnostics;
}

function validateApplicationAttributes(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const application of findDescendantElements(root, 'Application')) {
        const startPage = getAttributeAnyNS(application, 'StartPage');
        const executable = getAttributeAnyNS(application, 'Executable');
        const entryPoint = getAttributeAnyNS(application, 'EntryPoint');
        const runtimeBehavior = getAttributeAnyNS(application, 'RuntimeBehavior');
        const hostId = getAttributeAnyNS(application, 'HostId');

        if (hasStartPageExecutableConflict(startPage, executable)) {
            pushAttributeDiagnostic(
                diagnostics,
                application,
                lines,
                'StartPage',
                'Application cannot declare both StartPage and Executable. Remove one of these attributes.'
            );
        }

        if (hasStartPageEntryPointConflict(startPage, entryPoint)) {
            pushAttributeDiagnostic(
                diagnostics,
                application,
                lines,
                'StartPage',
                'Application cannot declare both StartPage and EntryPoint. Remove EntryPoint or switch from StartPage to Executable.'
            );
        }

        if (executable && !entryPoint && executableRequiresEntryPoint(runtimeBehavior)) {
            pushAttributeDiagnostic(
                diagnostics,
                application,
                lines,
                'Executable',
                'Application with Executable must also declare EntryPoint when RuntimeBehavior is windowsApp.'
            );
        }

        if (!executable && !startPage && applicationRequiresExecutable(entryPoint, hostId, startPage)) {
            pushElementDiagnostic(
                diagnostics,
                application,
                lines,
                'Application must declare either Executable or StartPage.'
            );
        }
    }
}

function validateSupportsMultipleInstances(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const application of findDescendantElements(root, 'Application')) {
        const resourceGroup = getAttributeAnyNS(application, 'ResourceGroup');
        const subsystem = normalizeValue(getAttributeAnyNS(application, 'Subsystem'));
        const supportsAttributes = getAttributeNodesAnyNS(application, 'SupportsMultipleInstances');
        const normalizedSupportsValues = new Set(
            supportsAttributes
                .map(attr => normalizeValue(attr.value))
                .filter((value): value is string => value.length > 0)
        );
        const supportsMultipleInstances = normalizedSupportsValues.has('true');

        if (supportsMultipleInstances && resourceGroup) {
            pushAttributeDiagnostic(
                diagnostics,
                application,
                lines,
                'ResourceGroup',
                'Application cannot use ResourceGroup when SupportsMultipleInstances is true.'
            );
        }

        if (subsystem === 'console' && !supportsMultipleInstances) {
            const targetAttr = supportsAttributes[0]?.name ?? 'Subsystem';
            pushAttributeDiagnostic(
                diagnostics,
                application,
                lines,
                targetAttr,
                'Application with Subsystem="console" must declare SupportsMultipleInstances="true".'
            );
        }

        if (normalizedSupportsValues.size > 1) {
            pushAttributeDiagnostic(
                diagnostics,
                application,
                lines,
                supportsAttributes[0]?.name ?? 'SupportsMultipleInstances',
                'SupportsMultipleInstances values must be consistent across namespace variants (for example uap10:, desktop4:, and iot2:).'
            );
        }
    }
}

function validateVisualElements(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const application of findDescendantElements(root, 'Application')) {
        const visualElements = findChildElements(application, 'VisualElements')[0];
        if (!visualElements) {
            continue;
        }

        const defaultTile = findChildElements(visualElements, 'DefaultTile')[0];
        const lockScreen = findChildElements(visualElements, 'LockScreen')[0];
        const wideLogo = defaultTile ? getAttributeAnyNS(defaultTile, 'Wide310x150Logo') : null;
        const squareLargeLogo = defaultTile ? getAttributeAnyNS(defaultTile, 'Square310x310Logo') : null;

        if (defaultTile && squareLargeLogo && !wideLogo) {
            pushAttributeDiagnostic(
                diagnostics,
                defaultTile,
                lines,
                'Square310x310Logo',
                'DefaultTile with Square310x310Logo must also declare Wide310x150Logo.'
            );
        }

        if (lockScreen && normalizeValue(getAttributeAnyNS(lockScreen, 'Notification')) === 'badgeandtiletext' && !wideLogo) {
            pushAttributeDiagnostic(
                diagnostics,
                lockScreen,
                lines,
                'Notification',
                'LockScreen Notification="badgeAndTileText" requires DefaultTile Wide310x150Logo.'
            );
        }
    }
}

function validateExtensionCategories(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const extension of findDescendantElements(root, 'Extension')) {
        const category = getAttributeAnyNS(extension, 'Category');
        if (!category) {
            continue;
        }

        const normalizedCategory = category.trim().toLowerCase();
        const expectedChild = EXTENSION_CATEGORY_CHILD_MAP[normalizedCategory];
        if (!expectedChild) {
            continue;
        }

        const firstChild = getFirstChildElement(extension);
        if (!firstChild) {
            pushAttributeDiagnostic(
                diagnostics,
                extension,
                lines,
                'Category',
                `Extension category "${category}" requires a <${expectedChild}> child element.`
            );
            continue;
        }

        if (getLocalName(firstChild) !== expectedChild) {
            pushAttributeDiagnostic(
                diagnostics,
                extension,
                lines,
                'Category',
                `Extension category "${category}" must have <${expectedChild}> as its first child element, but found <${getLocalName(firstChild)}>.`
            );
        }
    }
}

function validateShareTarget(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const shareTarget of findDescendantElements(root, 'ShareTarget')) {
        const hasSupportedFileTypes = findChildElements(shareTarget, 'SupportedFileTypes').length > 0;
        const hasDataFormat = findChildElements(shareTarget, 'DataFormat').length > 0;

        if (!hasSupportedFileTypes && !hasDataFormat) {
            pushElementDiagnostic(
                diagnostics,
                shareTarget,
                lines,
                'ShareTarget must declare at least one SupportedFileTypes or DataFormat child element.'
            );
        }
    }
}

function validateContentUriRules(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const rules of findDescendantElements(root, 'ApplicationContentUriRules')) {
        for (const rule of findChildElements(rules, 'Rule')) {
            if (normalizeValue(getAttributeAnyNS(rule, 'Type')) !== 'exclude') {
                continue;
            }

            const windowsRuntimeAccess = getAttributeNodeAnyNS(rule, 'WindowsRuntimeAccess');
            if (windowsRuntimeAccess) {
                pushAttributeDiagnostic(
                    diagnostics,
                    rule,
                    lines,
                    windowsRuntimeAccess.name,
                    'ApplicationContentUriRules Rule with Type="exclude" cannot declare WindowsRuntimeAccess.'
                );
            }
        }
    }
}

function validateComRules(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    for (const classElement of findDescendantElements(root, 'Class')) {
        const id = getAttributeAnyNS(classElement, 'Id');
        const insertableObject = normalizeValue(getAttributeAnyNS(classElement, 'InsertableObject'));
        const progId = getAttributeAnyNS(classElement, 'ProgId');
        const autoConvertTo = getAttributeAnyNS(classElement, 'AutoConvertTo');

        if (!id && !insertableObject && !progId && !autoConvertTo) {
            continue;
        }

        if (insertableObject === 'true' && !progId) {
            pushAttributeDiagnostic(
                diagnostics,
                classElement,
                lines,
                'InsertableObject',
                'COM Class with InsertableObject="true" must also declare ProgId.'
            );
        }

        if (id && autoConvertTo && normalizeValue(id) === normalizeValue(autoConvertTo)) {
            pushAttributeDiagnostic(
                diagnostics,
                classElement,
                lines,
                'AutoConvertTo',
                'COM Class AutoConvertTo value cannot be the same as the Class Id.'
            );
        }
    }
}

function validateResources(
    root: Element,
    lines: string[],
    diagnostics: ManifestDiagnostic[]
): void {
    const properties = findChildElements(root, 'Properties')[0];
    const resources = findChildElements(root, 'Resources')[0];
    const resourcePackage = normalizeValue(properties ? getChildText(properties, 'ResourcePackage') : null) === 'true';

    if (resourcePackage) {
        return;
    }

    const resourceElements = resources ? findChildElements(resources, 'Resource') : [];
    const hasLanguageResource = resourceElements.some(resource => {
        const language = getAttributeAnyNS(resource, 'Language');
        return typeof language === 'string' && language.trim().length > 0;
    });

    if (!hasLanguageResource) {
        pushElementDiagnostic(
            diagnostics,
            resources ?? root,
            lines,
            'Non-resource packages must declare at least one <Resource> element with a Language attribute.'
        );
    }
}

function findChildElements(parent: Element, localName: string): Element[] {
    const result: Element[] = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i];
        if (child.nodeType !== 1) {
            continue;
        }

        const childElement = child as Element;
        if (getLocalName(childElement) === localName) {
            result.push(childElement);
        }
    }
    return result;
}

function findDescendantElements(parent: Element, localName: string, depth = 0): Element[] {
    if (depth > MAX_DESCENDANT_SEARCH_DEPTH) {
        return [];
    }

    const result: Element[] = [];

    for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i];
        if (child.nodeType !== 1) {
            continue;
        }

        const childElement = child as Element;
        if (getLocalName(childElement) === localName) {
            result.push(childElement);
        }

        result.push(...findDescendantElements(childElement, localName, depth + 1));
    }

    return result;
}

function getFirstChildElement(parent: Element): Element | null {
    for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i];
        if (child.nodeType === 1) {
            return child as Element;
        }
    }

    return null;
}

function getChildText(parent: Element, localName: string): string | null {
    const child = findChildElements(parent, localName)[0];
    return child?.textContent ?? null;
}

function getAttributeAnyNS(element: Element, localName: string): string | null {
    return getAttributeNodeAnyNS(element, localName)?.value ?? null;
}

function getAttributeNodeAnyNS(element: Element, localName: string): AttributeMatch | null {
    return getAttributeNodesAnyNS(element, localName)[0] ?? null;
}

function getAttributeNodesAnyNS(element: Element, localName: string): AttributeMatch[] {
    const result: AttributeMatch[] = [];

    for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes.item(i);
        if (!attr) {
            continue;
        }

        const attrLocalName = attr.localName || attr.nodeName.split(':').pop() || '';
        if (attrLocalName === localName || attr.nodeName === localName) {
            result.push({ name: attr.nodeName, value: attr.nodeValue ?? '' });
        }
    }

    return result;
}

function pushElementDiagnostic(
    diagnostics: ManifestDiagnostic[],
    element: Element,
    lines: string[],
    message: string
): void {
    diagnostics.push({
        message,
        severity: 'error',
        ...getElementRange(element, lines),
    });
}

function pushAttributeDiagnostic(
    diagnostics: ManifestDiagnostic[],
    element: Element,
    lines: string[],
    attributeName: string,
    message: string
): void {
    diagnostics.push({
        message,
        severity: 'error',
        ...getAttributeValueRange(element, attributeName, lines),
    });
}

function getAttributeValueRange(element: Element, attrName: string, lines: string[]): { line: number; col: number; endCol: number } {
    const lineNumber = (element as unknown as { lineNumber?: number }).lineNumber;
    const startLine = typeof lineNumber === 'number' ? clamp(lineNumber - 1, 0, Math.max(lines.length - 1, 0)) : 0;
    const searchEnd = Math.min(startLine + 3, lines.length);
    const escapedAttrName = escapeRegExp(attrName);

    for (let i = startLine; i < searchEnd; i++) {
        const lineText = lines[i];
        const regex = new RegExp(`${escapedAttrName}\\s*=\\s*(['"])([^'"]*?)\\1`);
        const match = regex.exec(lineText);
        if (match) {
            const valueStart = match.index + match[0].indexOf(match[2]);
            return { line: i, col: valueStart, endCol: valueStart + match[2].length };
        }
    }

    return getElementRange(element, lines);
}

function getElementRange(element: Element, lines: string[]): { line: number; col: number; endCol: number } {
    const lineNumber = (element as unknown as { lineNumber?: number }).lineNumber;
    const columnNumber = (element as unknown as { columnNumber?: number }).columnNumber;
    const line = typeof lineNumber === 'number' ? clamp(lineNumber - 1, 0, Math.max(lines.length - 1, 0)) : 0;
    const col = typeof columnNumber === 'number' ? Math.max(columnNumber - 1, 0) : 0;
    return { line, col, endCol: getLineLength(lines, line) };
}

function getLocalName(element: Element): string {
    return element.localName || element.nodeName.split(':').pop() || '';
}

function normalizeValue(value: string | null): string {
    return value?.trim().toLowerCase() ?? '';
}

function getLineLength(lines: string[], line: number): number {
    return lines[line]?.length ?? 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validation rules for appxmanifest.xml fields.
 * Provides real-time inline validation for the form editor.
 * 
 * Uses the shared XSD schema model for pattern/length validation.
 * Semantic rules not expressible in XSD (version comparison, reserved names,
 * image extension checks, resource package constraints) remain as hand-written logic.
 */

import { ManifestData, ValidationError } from './manifest-types';
import { SchemaModel } from '../manifest-schema/schema-model';
import { validateValueAgainstType, matchesSchemaPattern, isValidSchemaColor } from '../manifest-schema/schema-helpers';
import {
    applicationRequiresExecutable,
    executableRequiresEntryPoint,
    hasStartPageExecutableConflict,
    hasStartPageEntryPointConflict,
} from '../manifest-schema/semantic-validation';

// BCP-47: language[-script][-region][-variant] (simplified for common MSIX usage)
// Also accepts private-use tags like "x-generate" used by MSIX tooling
const BCP47_REGEX = /^(?:x(?:-[a-zA-Z0-9]{1,8})+|[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-[a-zA-Z]{2}|\d{3})?(-[a-zA-Z0-9]{5,8})*)$/;
// uap4:CustomCapability Name: "company.capabilitynamefromstore_publisherId"
// Must have at least one dot-separated segment before the underscore, and a 13-char base32 publisher ID after.
const CUSTOM_CAPABILITY_REGEX = /^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)+_[a-z0-9]{13}$/;

/** Reserved device names that cannot be used as Identity Name, ResourceId, or Application Id fields. */
const RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Validate a uap4:CustomCapability Name attribute.
 * Format: company.capabilitynamefromstore_publisherId
 * - alphanumeric segments separated by dots (at least two segments before underscore)
 * - followed by underscore and a 13-character base32 publisher ID (lowercase letters and digits)
 */
export function isValidCustomCapability(name: string): boolean {
    return CUSTOM_CAPABILITY_REGEX.test(name);
}

/**
 * Returns true if a value is an MRT resource reference.
 * MRT prefixed strings (ms-resource:) are explicit resource lookups.
 * All path values are also run through MRT before falling back to the literal path,
 * so even "foo.png" could be a key that resolves to a different file.
 */
function isMrtReference(value: string): boolean {
    return value.startsWith('ms-resource:');
}

/**
 * Returns true if a path has an unsupported image file extension.
 * Only checks literal file paths — MRT resource keys are always valid.
 * Extensionless values are valid (could be scale/contrast-qualified or MRT keys).
 */
function hasUnsupportedImageExtension(path: string): boolean {
    if (isMrtReference(path)) { return false; }
    const filename = path.split(/[\\/]/).pop() || '';
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx < 0) { return false; } // no extension — valid (MRT key or scale-qualified)
    const ext = filename.substring(dotIdx).toLowerCase();
    // Allow known image extensions and MRT qualifier patterns (e.g. .scale-200, .contrast-high)
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') { return false; }
    if (/^\.(scale|contrast|targetsize|theme|layoutdirection|language|dxfeaturelevel)-/i.test(ext)) { return false; }
    return true;
}

const IMAGE_FORMAT_ERROR = 'Visual assets should be .png, .jpg, or .jpeg files, or an MRT resource key (ms-resource:).';

/** Validate an image field: error if blank (but present in manifest), warn if unsupported extension. */
function validateImageField(errors: ValidationError[], field: string, value: string | null | undefined): void {
    if (value === '') {
        errors.push({ field, message: 'Image path cannot be empty.', severity: 'error' });
    } else if (value && hasUnsupportedImageExtension(value)) {
        errors.push({ field, message: IMAGE_FORMAT_ERROR, severity: 'warning' });
    }
}

/** Validate all fields and return a list of errors. */
export function validateManifest(data: ManifestData, schema: SchemaModel): ValidationError[] {
    const errors: ValidationError[] = [];
    validateIdentity(data, errors, schema);
    validatePhoneIdentity(data, errors, schema);
    validateProperties(data, errors, schema);
    validateDependencies(data, errors, schema);
    validateResources(data, errors);
    validateApplications(data, errors, schema);
    return errors;
}

function validateIdentity(data: ManifestData, errors: ValidationError[], schema: SchemaModel): void {
    if (!data.identity.name) {
        errors.push({ field: 'identity.name', message: 'Package name is required.', severity: 'error' });
    } else {
        const err = validateValueAgainstType(schema, 'ST_PackageName', data.identity.name);
        if (err) {
            errors.push({ field: 'identity.name', message: `Package name: ${err}`, severity: 'error' });
        } else if (RESERVED_NAMES.has(data.identity.name.toUpperCase())) {
            errors.push({ field: 'identity.name', message: 'Package name cannot be a reserved device name (CON, PRN, AUX, NUL, COM1–9, LPT1–9).', severity: 'error' });
        }
    }

    if (!data.identity.publisher) {
        errors.push({ field: 'identity.publisher', message: 'Publisher is required.', severity: 'error' });
    } else if (!matchesSchemaPattern(schema, 'ST_Publisher_2010_v2', data.identity.publisher)) {
        errors.push({ field: 'identity.publisher', message: 'Publisher must be a valid X.500 distinguished name (e.g. CN=Contoso, O=Contoso Ltd).', severity: 'error' });
    }

    if (!data.identity.version) {
        errors.push({ field: 'identity.version', message: 'Version is required.', severity: 'error' });
    } else if (!matchesSchemaPattern(schema, 'ST_VersionQuad', data.identity.version)) {
        errors.push({ field: 'identity.version', message: 'Version must be a DotQuadNumber in Major.Minor.Build.Revision format (e.g. 1.0.0.0), each part 0–65535.', severity: 'error' });
    }

    if (data.identity.resourceId) {
        const err = validateValueAgainstType(schema, 'ST_ResourceId', data.identity.resourceId);
        if (err) {
            errors.push({ field: 'identity.resourceId', message: `Resource ID: ${err}`, severity: 'error' });
        } else if (RESERVED_NAMES.has(data.identity.resourceId.toUpperCase())) {
            errors.push({ field: 'identity.resourceId', message: 'Resource ID cannot be a reserved device name (CON, PRN, AUX, NUL, COM1–9, LPT1–9).', severity: 'error' });
        }
    }

    if (data.properties.resourcePackage === 'true' &&
        data.identity.processorArchitecture &&
        data.identity.processorArchitecture.toLowerCase() !== 'neutral') {
        errors.push({ field: 'identity.processorArchitecture', message: 'Resource packages must use neutral processor architecture.', severity: 'error' });
    }
}

function validatePhoneIdentity(data: ManifestData, errors: ValidationError[], schema: SchemaModel): void {
    if (!data.phoneIdentity) { return; }
    if (!data.phoneIdentity.phoneProductId || !matchesSchemaPattern(schema, 'ST_GUID', data.phoneIdentity.phoneProductId)) {
        errors.push({ field: 'phoneIdentity.phoneProductId', message: 'Phone Product ID must be a valid GUID (e.g. 00000000-0000-0000-0000-000000000000).', severity: 'error' });
    }
    if (data.phoneIdentity.phonePublisherId && !matchesSchemaPattern(schema, 'ST_GUID', data.phoneIdentity.phonePublisherId)) {
        errors.push({ field: 'phoneIdentity.phonePublisherId', message: 'Phone Publisher ID must be a valid GUID (e.g. 00000000-0000-0000-0000-000000000000).', severity: 'error' });
    }
}

function validateProperties(data: ManifestData, errors: ValidationError[], schema: SchemaModel): void {
    if (!data.properties.displayName) {
        errors.push({ field: 'properties.displayName', message: 'Display name is required.', severity: 'error' });
    } else {
        const err = validateValueAgainstType(schema, 'ST_DisplayName', data.properties.displayName);
        if (err) {
            errors.push({ field: 'properties.displayName', message: `Display name: ${err}`, severity: 'error' });
        }
    }

    if (!data.properties.publisherDisplayName) {
        errors.push({ field: 'properties.publisherDisplayName', message: 'Publisher display name is required.', severity: 'error' });
    } else {
        const err = validateValueAgainstType(schema, 'ST_DisplayName', data.properties.publisherDisplayName);
        if (err) {
            errors.push({ field: 'properties.publisherDisplayName', message: `Publisher display name: ${err}`, severity: 'error' });
        }
    }

    if (!data.properties.logo) {
        errors.push({ field: 'properties.logo', message: 'Store logo path is required.', severity: 'error' });
    }
    validateImageField(errors, 'properties.logo', data.properties.logo);

    if (data.properties.description) {
        const err = validateValueAgainstType(schema, 'ST_Description', data.properties.description);
        if (err) {
            errors.push({ field: 'properties.description', message: `Description: ${err}`, severity: 'error' });
        }
    }
}

function validateDependencies(data: ManifestData, errors: ValidationError[], schema: SchemaModel): void {
    const isValidVersion = (v: string) => matchesSchemaPattern(schema, 'ST_VersionQuad', v);
    const isValidPublisher = (v: string) => matchesSchemaPattern(schema, 'ST_Publisher_2010_v2', v);
    const isValidPkgName = (v: string) => validateValueAgainstType(schema, 'ST_PackageName', v) === null;
    for (let i = 0; i < data.dependencies.targetDeviceFamilies.length; i++) {
        const family = data.dependencies.targetDeviceFamilies[i];
        const prefix = `dependencies.targetDeviceFamily.${i}`;

        if (!family.minVersion) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion is required.', severity: 'error' });
        } else if (!isValidVersion(family.minVersion)) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion must be a DotQuadNumber (e.g. 10.0.17763.0), each part 0–65535.', severity: 'error' });
        }

        if (!family.maxVersionTested) {
            errors.push({ field: `${prefix}.maxVersionTested`, message: 'MaxVersionTested is required.', severity: 'error' });
        } else if (!isValidVersion(family.maxVersionTested)) {
            errors.push({ field: `${prefix}.maxVersionTested`, message: 'MaxVersionTested must be a DotQuadNumber (e.g. 10.0.26100.0), each part 0–65535.', severity: 'error' });
        }

        if (family.minVersion && family.maxVersionTested &&
            isValidVersion(family.minVersion) && isValidVersion(family.maxVersionTested)) {
            if (compareVersions(family.maxVersionTested, family.minVersion) < 0) {
                errors.push({ field: `${prefix}.maxVersionTested`, message: 'MaxVersionTested must be greater than or equal to MinVersion.', severity: 'error' });
            }
        }
    }

    for (let i = 0; i < data.dependencies.packageDependencies.length; i++) {
        const dep = data.dependencies.packageDependencies[i];
        const prefix = `dependencies.packageDependency.${i}`;

        if (!dep.name) {
            errors.push({ field: `${prefix}.name`, message: 'Package dependency name is required.', severity: 'error' });
        } else if (!isValidPkgName(dep.name)) {
            errors.push({ field: `${prefix}.name`, message: 'Name can only contain letters, numbers, dots, and hyphens (3–50 chars).', severity: 'error' });
        }

        if (!dep.minVersion) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion is required.', severity: 'error' });
        } else if (!isValidVersion(dep.minVersion)) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion must be a 4-part dotted version (e.g. 14.0.0.0), each part 0–65535.', severity: 'error' });
        }

        if (!dep.publisher) {
            errors.push({ field: `${prefix}.publisher`, message: 'Publisher is required.', severity: 'error' });
        } else if (!isValidPublisher(dep.publisher)) {
            errors.push({ field: `${prefix}.publisher`, message: 'Publisher must be a valid X.500 distinguished name (e.g. CN=Microsoft Corporation, O=Microsoft Corporation).', severity: 'error' });
        }
    }

    for (let i = 0; i < data.dependencies.mainPackageDependencies.length; i++) {
        const dep = data.dependencies.mainPackageDependencies[i];
        const prefix = `dependencies.mainPackageDependency.${i}`;

        if (!dep.name) {
            errors.push({ field: `${prefix}.name`, message: 'Main package dependency name is required.', severity: 'error' });
        } else if (!isValidPkgName(dep.name)) {
            errors.push({ field: `${prefix}.name`, message: 'Name can only contain letters, numbers, dots, and hyphens (3–50 chars).', severity: 'error' });
        }
    }

    for (let i = 0; i < data.dependencies.driverConstraints.length; i++) {
        const constraint = data.dependencies.driverConstraints[i];
        const prefix = `dependencies.driverConstraint.${i}`;

        if (!constraint.name) {
            errors.push({ field: `${prefix}.name`, message: 'Driver constraint name is required.', severity: 'error' });
        }

        if (!constraint.minVersion) {
            errors.push({ field: `${prefix}.minVersion`, message: 'Driver constraint MinVersion is required.', severity: 'error' });
        } else if (!isValidVersion(constraint.minVersion)) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion must be a DotQuadNumber (e.g. 1.0.0.0), each part 0–65535.', severity: 'error' });
        }

        if (!constraint.minDate) {
            errors.push({ field: `${prefix}.minDate`, message: 'Driver constraint MinDate is required.', severity: 'error' });
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(constraint.minDate)) {
            errors.push({ field: `${prefix}.minDate`, message: 'MinDate must be in YYYY-MM-DD format (e.g. 2020-01-01).', severity: 'error' });
        }
    }

    for (let i = 0; i < data.dependencies.osPackageDependencies.length; i++) {
        const dep = data.dependencies.osPackageDependencies[i];
        const prefix = `dependencies.osPackageDependency.${i}`;

        if (!dep.name) {
            errors.push({ field: `${prefix}.name`, message: 'OS package dependency name is required.', severity: 'error' });
        } else if (!isValidPkgName(dep.name)) {
            errors.push({ field: `${prefix}.name`, message: 'Name can only contain letters, numbers, dots, and hyphens (3–50 chars).', severity: 'error' });
        }

        if (!dep.version) {
            errors.push({ field: `${prefix}.version`, message: 'OS package dependency version is required.', severity: 'error' });
        } else if (!isValidVersion(dep.version)) {
            errors.push({ field: `${prefix}.version`, message: 'Version must be a DotQuadNumber (e.g. 10.0.0.0), each part 0–65535.', severity: 'error' });
        }
    }

    for (let i = 0; i < data.dependencies.hostRuntimeDependencies.length; i++) {
        const dep = data.dependencies.hostRuntimeDependencies[i];
        const prefix = `dependencies.hostRuntimeDependency.${i}`;

        if (!dep.name) {
            errors.push({ field: `${prefix}.name`, message: 'Host runtime dependency name is required.', severity: 'error' });
        }

        if (!dep.publisher) {
            errors.push({ field: `${prefix}.publisher`, message: 'Host runtime dependency publisher is required.', severity: 'error' });
        } else if (!isValidPublisher(dep.publisher)) {
            errors.push({ field: `${prefix}.publisher`, message: 'Publisher must be a valid X.500 distinguished name (e.g. CN=Contoso).', severity: 'error' });
        }

        if (!dep.minVersion) {
            errors.push({ field: `${prefix}.minVersion`, message: 'Host runtime dependency MinVersion is required.', severity: 'error' });
        } else if (!isValidVersion(dep.minVersion)) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion must be a DotQuadNumber (e.g. 1.0.0.0), each part 0–65535.', severity: 'error' });
        }
    }

    for (let i = 0; i < data.dependencies.externalDependencies.length; i++) {
        const dep = data.dependencies.externalDependencies[i];
        const prefix = `dependencies.externalDependency.${i}`;

        if (!dep.name) {
            errors.push({ field: `${prefix}.name`, message: 'External dependency name is required.', severity: 'error' });
        }

        if (!dep.publisher) {
            errors.push({ field: `${prefix}.publisher`, message: 'External dependency publisher is required.', severity: 'error' });
        } else if (!isValidPublisher(dep.publisher)) {
            errors.push({ field: `${prefix}.publisher`, message: 'Publisher must be a valid X.500 distinguished name (e.g. CN=Contoso).', severity: 'error' });
        }

        if (!dep.minVersion) {
            errors.push({ field: `${prefix}.minVersion`, message: 'External dependency MinVersion is required.', severity: 'error' });
        } else if (!isValidVersion(dep.minVersion)) {
            errors.push({ field: `${prefix}.minVersion`, message: 'MinVersion must be a DotQuadNumber (e.g. 1.0.0.0), each part 0–65535.', severity: 'error' });
        }
    }
}

function validateResources(data: ManifestData, errors: ValidationError[]): void {
    const isResourcePackage = data.properties.resourcePackage?.toLowerCase() === 'true';
    for (let i = 0; i < data.resources.length; i++) {
        const res = data.resources[i];
        if (res.language && !BCP47_REGEX.test(res.language)) {
            errors.push({ field: `resources.${i}.language`, message: 'Language must be a valid BCP-47 tag (e.g. en, en-US, zh-Hans-CN) or x-generate.', severity: 'error' });
        }

        if (isResourcePackage) {
            const filledAttrs = [
                res.language ? 'Language' : '',
                res.scale ? 'Scale' : '',
                res.dxFeatureLevel ? 'DXFeatureLevel' : '',
            ].filter(Boolean);
            if (filledAttrs.length > 1) {
                const msg = 'Resource package resources must define only one attribute type (Language, Scale, or DXFeatureLevel).';
                if (res.language) errors.push({ field: `resources.${i}.language`, message: msg, severity: 'error' });
                if (res.scale) errors.push({ field: `resources.${i}.scale`, message: msg, severity: 'error' });
                if (res.dxFeatureLevel) errors.push({ field: `resources.${i}.dxFeatureLevel`, message: msg, severity: 'error' });
            }
        }
    }
}

function validateApplications(data: ManifestData, errors: ValidationError[], schema: SchemaModel): void {
    for (let i = 0; i < data.applications.length; i++) {
        const app = data.applications[i];
        const prefix = `applications.${i}`;

        if (!app.id) {
            errors.push({ field: `${prefix}.id`, message: 'Application Id is required.', severity: 'error' });
        } else if (validateValueAgainstType(schema, 'ST_ApplicationId', app.id) !== null) {
            errors.push({ field: `${prefix}.id`, message: 'Application Id must contain alpha-numeric fields separated by periods, each starting with a letter (max 64 chars).', severity: 'error' });
        } else {
            // Semantic rule: no reserved device names as field values (not in XSD)
            const idFields = app.id.split('.');
            const reservedField = idFields.find(f => RESERVED_NAMES.has(f.toUpperCase()));
            if (reservedField) {
                errors.push({ field: `${prefix}.id`, message: `Application Id cannot use reserved name "${reservedField}" as a field value.`, severity: 'error' });
            }
        }

        // Use shared predicates for Executable/EntryPoint/StartPage checks
        // so the visual editor uses the same nuanced rules as the XML IntelliSense.
        if (hasStartPageExecutableConflict(null, app.executable)) {
            // Editor doesn't currently expose StartPage, but guard for future use
        }

        if (applicationRequiresExecutable(app.entryPoint || null, null, null)) {
            if (!app.executable) {
                errors.push({ field: `${prefix}.executable`, message: 'Executable path is required.', severity: 'error' });
            }
        }

        if (app.executable && !app.executable.toLowerCase().endsWith('.exe')) {
            errors.push({ field: `${prefix}.executable`, message: 'Executable must be an .exe file.', severity: 'error' });
        }

        if (app.executable && !app.entryPoint && executableRequiresEntryPoint(app.runtimeBehavior || null)) {
            errors.push({ field: `${prefix}.entryPoint`, message: 'Entry point is required when Executable is specified.', severity: 'error' });
        }

        if (!app.visualElements.displayName) {
            errors.push({ field: `${prefix}.visualElements.displayName`, message: 'Display name is required.', severity: 'error' });
        } else {
            const err = validateValueAgainstType(schema, 'ST_DisplayName', app.visualElements.displayName);
            if (err) {
                errors.push({ field: `${prefix}.visualElements.displayName`, message: `Display name: ${err}`, severity: 'error' });
            }
        }

        if (app.visualElements.description) {
            const err = validateValueAgainstType(schema, 'ST_Description', app.visualElements.description);
            if (err) {
                errors.push({ field: `${prefix}.visualElements.description`, message: `Description: ${err}`, severity: 'error' });
            }
        }

        if (app.visualElements.backgroundColor) {
            if (!isValidSchemaColor(schema, app.visualElements.backgroundColor)) {
                errors.push({ field: `${prefix}.visualElements.backgroundColor`, message: 'Background color must be a hex color (e.g. #FFFFFF), "transparent", or a named color (e.g. cornflowerBlue).', severity: 'error' });
            }
        }

        const ve = app.visualElements;
        const vePrefix = `${prefix}.visualElements`;
        validateImageField(errors, `${vePrefix}.square150x150Logo`, ve.square150x150Logo);
        validateImageField(errors, `${vePrefix}.square44x44Logo`, ve.square44x44Logo);
        validateImageField(errors, `${vePrefix}.wide310x150Logo`, ve.wide310x150Logo);
        validateImageField(errors, `${vePrefix}.square71x71Logo`, ve.square71x71Logo);
        validateImageField(errors, `${vePrefix}.square310x310Logo`, ve.square310x310Logo);
        validateImageField(errors, `${vePrefix}.badgeLogo`, ve.badgeLogo);
        validateImageField(errors, `${vePrefix}.splashScreenImage`, ve.splashScreenImage);

        if (app.extensions && app.extensions.length > 0) {
            for (let extIdx = 0; extIdx < app.extensions.length; extIdx++) {
                const ext = app.extensions[extIdx];
                for (const field of ext.fields) {
                    const isRequired = REQUIRED_EXT_FIELDS.has(field.label);
                    const validation = validateExtensionField(field.label, field.value, isRequired, schema);
                    if (validation) {
                        errors.push({
                            field: `${prefix}.extensions.${extIdx}.${field.label}`,
                            message: validation.message,
                            severity: validation.level,
                        });
                    }
                }
            }
        }
    }
}

// ─── Extension Field Validation ─────────────────────────────────────────────

export interface ExtFieldValidation {
    level: 'error' | 'warning';
    message: string;
}

/** Required extension fields that must have a value. */
const REQUIRED_EXT_FIELDS = new Set([
    'ExeServer.Executable', 'ExeServer.DisplayName', 'Class.Id',
    'AppExtension.Name', 'AppExtension.Id', 'AppExtension.DisplayName', 'AppExtension.PublicFolder',
    'Registration', 'ExecutionAlias.Alias',
    'Extension.EntryPoint', 'Task.Type',
    'Protocol.Name',
    'FileTypeAssociation.Name', 'FileType',
    'StartupTask.TaskId', 'StartupTask.DisplayName',
    'DataFormat',
    'AppService.Name',
    'ToastNotificationActivation.ToastActivatorCLSID'
]);

/**
 * Validate an extension field value and return { level, message } or null if valid.
 * Uses XSD schema types where available; keeps hand-written rules for fields not in XSD.
 */
export function validateExtensionField(fieldLabel: string, value: string, isRequired: boolean, schema: SchemaModel): ExtFieldValidation | null {
    // Required check first
    if (isRequired && !value) {
        return { level: 'error', message: 'This field is required.' };
    }
    if (!value) { return null; }

    switch (fieldLabel) {
        case 'Class.Id':
        case 'ToastNotificationActivation.ToastActivatorCLSID': {
            // CLSIDs may have braces; strip them before validating against XSD ST_GUID
            const stripped = value.replace(/^\{|\}$/g, '');
            if (!matchesSchemaPattern(schema, 'ST_GUID', stripped)) {
                return { level: 'error', message: 'Must be a valid GUID, e.g., {12345678-1234-1234-1234-123456789012}' };
            }
            break;
        }
        case 'ExecutionAlias.Alias':
            if (!/\.exe$/i.test(value)) {
                return { level: 'error', message: 'Alias must end with .exe (e.g., "myapp.exe").' };
            }
            if (/[\\/:*?"<>|]/.test(value)) {
                return { level: 'error', message: 'Alias must not contain path separators or special characters.' };
            }
            break;
        case 'Protocol.Name':
            if (!matchesSchemaPattern(schema, 'ST_Protocol_2010_v2', value)) {
                return { level: 'error', message: 'Protocol must start with a lowercase letter and contain only lowercase letters, digits, ".", "+", or "-" (2–39 chars).' };
            }
            break;
        case 'FileType': {
            const err = validateValueAgainstType(schema, 'ST_FileType', value);
            if (err) {
                return { level: 'error', message: `File extension: ${err}` };
            }
            break;
        }
        case 'FileTypeAssociation.Name':
            if (!/^[a-zA-Z0-9.]+$/.test(value)) {
                return { level: 'error', message: 'Name must contain only letters, digits, and periods.' };
            }
            break;
        case 'StartupTask.Enabled':
            if (value !== 'true' && value !== 'false') {
                return { level: 'error', message: 'Value must be "true" or "false".' };
            }
            break;
        case 'ExeServer.Executable':
            if (!/\.(exe|dll)$/i.test(value)) {
                return { level: 'warning', message: 'Expected a .exe or .dll path.' };
            }
            break;
        case 'Task.Type': {
            const validTypes = ['timer', 'pushNotification', 'systemEvent', 'general', 'audio', 'controlChannel', 'bluetooth', 'location', 'deviceUse', 'deviceServicing', 'deviceConnectionChange'];
            if (!validTypes.includes(value)) {
                return { level: 'warning', message: 'Common values: ' + validTypes.slice(0, 5).join(', ') + ', ...' };
            }
            break;
        }
        case 'AppService.Name': {
            const err = validateValueAgainstType(schema, 'ST_AppServiceName', value);
            if (err) {
                return { level: 'warning', message: `App service name: ${err}` };
            }
            break;
        }
    }
    return null;
}

/** Compare two version strings. Returns negative if a < b, 0 if equal, positive if a > b. */
function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) { return na - nb; }
    }
    return 0;
}

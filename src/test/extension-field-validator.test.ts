/**
 * Unit tests for validateExtensionField — L4 PR review finding.
 * Tests all 10 field-specific validation branches in manifest-validator.ts.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { validateExtensionField } from '../manifest-editor/manifest-validator';
import { SchemaModel } from '../manifest-schema/schema-model';
import { loadSchemaModel } from '../manifest-schema/xsd-parser';

let schema: SchemaModel;

describe('validateExtensionField', () => {

    before(() => {
        schema = loadSchemaModel(path.join(__dirname, '..', '..', 'schemas'));
    });

    // ─── Required field checks ─────────────────────────────────

    describe('required field handling', () => {
        it('returns error when required field is empty', () => {
            const result = validateExtensionField('Protocol.Name', '', true, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('required'));
        });

        it('returns null when optional field is empty', () => {
            assert.equal(validateExtensionField('Protocol.Name', '', false, schema), null);
        });

        it('returns null for unknown field with valid value', () => {
            assert.equal(validateExtensionField('SomeUnknown.Field', 'anything', false, schema), null);
        });
    });

    // ─── GUID fields ───────────────────────────────────────────

    describe('Class.Id (GUID validation)', () => {
        it('accepts valid GUID with braces', () => {
            assert.equal(validateExtensionField('Class.Id', '{12345678-1234-1234-1234-123456789012}', false, schema), null);
        });

        it('accepts valid GUID without braces', () => {
            assert.equal(validateExtensionField('Class.Id', '12345678-1234-1234-1234-123456789012', false, schema), null);
        });

        it('rejects invalid GUID', () => {
            const result = validateExtensionField('Class.Id', 'not-a-guid', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('GUID'));
        });
    });

    describe('ToastNotificationActivation.ToastActivatorCLSID', () => {
        it('accepts valid GUID', () => {
            assert.equal(validateExtensionField('ToastNotificationActivation.ToastActivatorCLSID', '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}', false, schema), null);
        });

        it('rejects invalid GUID', () => {
            const result = validateExtensionField('ToastNotificationActivation.ToastActivatorCLSID', 'bad', false, schema);
            assert.equal(result?.level, 'error');
        });
    });

    // ─── ExecutionAlias.Alias ──────────────────────────────────

    describe('ExecutionAlias.Alias', () => {
        it('accepts valid alias ending with .exe', () => {
            assert.equal(validateExtensionField('ExecutionAlias.Alias', 'myapp.exe', false, schema), null);
        });

        it('rejects alias not ending with .exe', () => {
            const result = validateExtensionField('ExecutionAlias.Alias', 'myapp', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('.exe'));
        });

        it('rejects alias with path separators', () => {
            const result = validateExtensionField('ExecutionAlias.Alias', 'path\\app.exe', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('special characters'));
        });

        it('rejects alias with special characters', () => {
            const result = validateExtensionField('ExecutionAlias.Alias', 'my*app.exe', false, schema);
            assert.equal(result?.level, 'error');
        });
    });

    // ─── Protocol.Name ─────────────────────────────────────────

    describe('Protocol.Name', () => {
        it('accepts valid protocol name', () => {
            assert.equal(validateExtensionField('Protocol.Name', 'myapp', false, schema), null);
        });

        it('accepts protocol with dots, plus, hyphen', () => {
            assert.equal(validateExtensionField('Protocol.Name', 'my.app+v2-beta', false, schema), null);
        });

        it('rejects protocol starting with digit', () => {
            const result = validateExtensionField('Protocol.Name', '1protocol', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('lowercase letter'));
        });

        it('rejects uppercase protocol name', () => {
            const result = validateExtensionField('Protocol.Name', 'MyApp', false, schema);
            assert.equal(result?.level, 'error');
        });
    });

    // ─── FileType ──────────────────────────────────────────────

    describe('FileType', () => {
        it('accepts valid file extension', () => {
            assert.equal(validateExtensionField('FileType', '.txt', false, schema), null);
        });

        it('rejects extension without leading dot', () => {
            const result = validateExtensionField('FileType', 'txt', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('ST_FileType'));
        });

        it('accepts extension with hyphen (per XSD ST_FileType pattern)', () => {
            // XSD ST_FileType pattern is \.[^.\\]+ which allows hyphens
            assert.equal(validateExtensionField('FileType', '.tx-t', false, schema), null);
        });
    });

    // ─── FileTypeAssociation.Name ──────────────────────────────

    describe('FileTypeAssociation.Name', () => {
        it('accepts valid name', () => {
            assert.equal(validateExtensionField('FileTypeAssociation.Name', 'myfiletype', false, schema), null);
        });

        it('accepts name with dots and digits', () => {
            assert.equal(validateExtensionField('FileTypeAssociation.Name', 'my.file.type1', false, schema), null);
        });

        it('rejects name with special characters', () => {
            const result = validateExtensionField('FileTypeAssociation.Name', 'my-file', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('letters, digits'));
        });
    });

    // ─── StartupTask.Enabled ───────────────────────────────────

    describe('StartupTask.Enabled', () => {
        it('accepts "true"', () => {
            assert.equal(validateExtensionField('StartupTask.Enabled', 'true', false, schema), null);
        });

        it('accepts "false"', () => {
            assert.equal(validateExtensionField('StartupTask.Enabled', 'false', false, schema), null);
        });

        it('rejects other values', () => {
            const result = validateExtensionField('StartupTask.Enabled', 'yes', false, schema);
            assert.equal(result?.level, 'error');
            assert.ok(result?.message.includes('"true" or "false"'));
        });
    });

    // ─── ExeServer.Executable (warning) ────────────────────────

    describe('ExeServer.Executable', () => {
        it('accepts .exe path', () => {
            assert.equal(validateExtensionField('ExeServer.Executable', 'myserver.exe', false, schema), null);
        });

        it('accepts .dll path', () => {
            assert.equal(validateExtensionField('ExeServer.Executable', 'mylib.dll', false, schema), null);
        });

        it('warns for non .exe/.dll path', () => {
            const result = validateExtensionField('ExeServer.Executable', 'myserver.bat', false, schema);
            assert.equal(result?.level, 'warning');
            assert.ok(result?.message.includes('.exe or .dll'));
        });
    });

    // ─── Task.Type (warning) ───────────────────────────────────

    describe('Task.Type', () => {
        it('accepts known type "timer"', () => {
            assert.equal(validateExtensionField('Task.Type', 'timer', false, schema), null);
        });

        it('accepts known type "pushNotification"', () => {
            assert.equal(validateExtensionField('Task.Type', 'pushNotification', false, schema), null);
        });

        it('warns for unknown type', () => {
            const result = validateExtensionField('Task.Type', 'unknownType', false, schema);
            assert.equal(result?.level, 'warning');
            assert.ok(result?.message.includes('Common values'));
        });
    });

    // ─── AppService.Name (warning) ─────────────────────────────

    describe('AppService.Name', () => {
        it('accepts valid reverse-domain name', () => {
            assert.equal(validateExtensionField('AppService.Name', 'com.contoso.myservice', false, schema), null);
        });

        it('accepts name starting with digit (per XSD ST_AppServiceName)', () => {
            // XSD ST_AppServiceName pattern [-+A-Za-z0-9][-+.A-Za-z0-9]+ allows leading digits
            assert.equal(validateExtensionField('AppService.Name', '1service', false, schema), null);
        });

        it('accepts name with hyphens (per XSD ST_AppServiceName)', () => {
            // XSD ST_AppServiceName allows hyphens
            assert.equal(validateExtensionField('AppService.Name', 'my-service', false, schema), null);
        });
    });
});

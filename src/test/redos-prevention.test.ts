import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { validateManifest } from '../manifest-editor/manifest-validator';
import { loadSchemaModel } from '../manifest-schema/xsd-parser';
import { SchemaModel } from '../manifest-schema/schema-model';
import * as path from 'path';

let schema: SchemaModel;
before(() => {
    schema = loadSchemaModel(path.join(__dirname, '..', '..', 'schemas'));
});

describe('ReDoS prevention', () => {
    it('pathological publisher DN completes in under 1 second', () => {
        // CodeQL flagged: strings starting with 'L=!,L="' and containing many repetitions of '",C="'
        const malicious = 'L=!,L="' + '",C="'.repeat(25);
        const data = {
            identity: { name: 'Test', publisher: malicious, version: '1.0.0.0', processorArchitecture: 'x64' },
            phoneIdentity: null,
            properties: { displayName: 'T', publisherDisplayName: 'T', logo: 'a.png' },
            dependencies: { targetDeviceFamilies: [], packageDependencies: [], mainPackageDependencies: [], driverConstraints: [], osPackageDependencies: [], hostRuntimeDependencies: [], externalDependencies: [] },
            applications: [],
            resources: [],
            capabilities: { list: [] },
        };
        const start = Date.now();
        const errors = validateManifest(data as any, schema);
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 1000, `Took ${elapsed}ms — possible ReDoS`);
        // Should produce a validation error (invalid DN)
        assert.ok(errors.some(e => e.field === 'identity.publisher'), 'Should flag invalid publisher');
    });
});

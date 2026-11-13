import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import {
    stripSourceScheme,
    isAbsoluteLocalPath,
    sourceCandidates,
    toZeroBasedPosition,
} from '../devtools/source-resolver';

test('strips the packaged app scheme', () => {
    assert.strictEqual(stripSourceScheme('ms-appx:///MainWindow.xaml'), 'MainWindow.xaml');
    assert.strictEqual(stripSourceScheme('ms-appx-web:///Views/Page.xaml'), 'Views/Page.xaml');
});

test('scheme stripping is case-insensitive and trims whitespace', () => {
    assert.strictEqual(stripSourceScheme('  MS-APPX:///MainWindow.xaml  '), 'MainWindow.xaml');
});

test('leaves plain paths untouched', () => {
    assert.strictEqual(stripSourceScheme('C:\\src\\MainWindow.xaml'), 'C:\\src\\MainWindow.xaml');
    assert.strictEqual(stripSourceScheme('Views/Page.xaml'), 'Views/Page.xaml');
});

test('recognizes absolute local paths', () => {
    assert.strictEqual(isAbsoluteLocalPath('C:\\src\\App.xaml'), true);
    assert.strictEqual(isAbsoluteLocalPath('c:/src/App.xaml'), true);
    assert.strictEqual(isAbsoluteLocalPath('\\\\server\\share\\App.xaml'), true);
    assert.strictEqual(isAbsoluteLocalPath('Views/Page.xaml'), false);
    assert.strictEqual(isAbsoluteLocalPath('ms-appx:///App.xaml'), false);
});

test('offers the relative path then the bare file name', () => {
    // Packaging sometimes flattens nested XAML, so the base name is a required
    // fallback rather than a nicety.
    assert.deepStrictEqual(
        sourceCandidates('ms-appx:///Views/Page.xaml'),
        [path.join('Views', 'Page.xaml'), 'Page.xaml'],
    );
});

test('does not duplicate a candidate for a top-level file', () => {
    assert.deepStrictEqual(sourceCandidates('ms-appx:///MainWindow.xaml'), ['MainWindow.xaml']);
});

test('returns nothing for an empty reference', () => {
    assert.deepStrictEqual(sourceCandidates('ms-appx:///'), []);
    assert.deepStrictEqual(sourceCandidates('   '), []);
});

test('converts 1-based protocol positions to 0-based', () => {
    assert.deepStrictEqual(toZeroBasedPosition(12, 5), { line: 11, column: 4 });
});

test('collapses missing or zero positions to the file start', () => {
    assert.deepStrictEqual(toZeroBasedPosition(undefined, undefined), { line: 0, column: 0 });
    assert.deepStrictEqual(toZeroBasedPosition(0, 0), { line: 0, column: 0 });
    assert.deepStrictEqual(toZeroBasedPosition(-3, -1), { line: 0, column: 0 });
});

import { defineConfig } from '@playwright/test';
import * as path from 'path';

/**
 * Playwright config for VS Code manifest editor E2E tests.
 *
 * Tests launch VS Code as an Electron app, open a fixture appxmanifest,
 * and interact with the custom editor webview.
 */
export default defineConfig({
    testDir: path.join(__dirname, 'src', 'test', 'e2e'),
    globalTeardown: path.join(__dirname, 'src', 'test', 'e2e', 'global-teardown.ts'),
    timeout: 60_000,
    retries: 1,
    workers: 1, // serialise — only one VS Code instance at a time
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            // Launches VS Code itself, so it needs no downloaded Playwright browser.
            name: 'vscode',
            testIgnore: '**/webview-state.spec.ts',
        },
        {
            // Renders the generated webview document directly, which does need Chromium.
            // Split out so pipelines without that download can run `--project=vscode`.
            name: 'webview',
            testMatch: '**/webview-state.spec.ts',
            use: { browserName: 'chromium' },
        },
    ],
});

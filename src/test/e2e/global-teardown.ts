import { closeSharedEditor } from './shared-context';
import { cleanupUserDataDir } from './helpers';

export default async function globalTeardown() {
    await closeSharedEditor();
    cleanupUserDataDir();
}

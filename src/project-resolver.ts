import * as path from 'path';
import { detectProjectAt, DetectedProject, getDisplayFilePath } from './project-detection';

/**
 * Maximum number of projects the workspace scan will surface before stopping.
 * Mirrors the limit used by {@link detectProjects}.
 */
export const MAX_SCANNED_PROJECTS = 10;

/**
 * An item shown in the project-selection QuickPick.
 */
export interface ProjectQuickPickItem {
	label: string;
	description?: string;
	directory: string;
}

/**
 * Host-provided dependencies for {@link resolveProjectDirectory}.
 *
 * These are injected so the resolution logic can be unit-tested without the
 * VS Code API. The real implementations live in `extension.ts`.
 */
export interface ProjectResolverDeps {
	/** Returns the configured `winapp.appDirectories` entries (may be empty). */
	getAppDirectories(): string[];
	/** Surfaces a non-blocking warning to the user. */
	showWarning(message: string): void;
	/** Prompts the user to choose one of the candidate directories. */
	pickDirectory(items: ProjectQuickPickItem[], placeHolder: string): Promise<string | undefined>;
	/** Scans the workspace for compatible projects (typically shows progress UI). */
	scanProjects(workspacePath: string): Promise<DetectedProject[]>;
}

/**
 * Resolves the project directory for commands that need a winapp project context.
 *
 * Priority:
 *   1. `winapp.appDirectories` setting (single entry auto-selects; multiple prompt).
 *   2. A recognized project at the workspace root.
 *   3. An automatic workspace scan (single result auto-selects; multiple prompt).
 *
 * Returns the absolute path to the selected project directory, the workspace
 * root when no project is found, or `undefined` when the user cancels a prompt.
 */
export async function resolveProjectDirectory(
	workspacePath: string,
	deps: ProjectResolverDeps
): Promise<string | undefined> {
	// 1) Explicit appDirectories setting.
	const appDirs = deps.getAppDirectories();
	if (appDirs.length > 0) {
		// Validate paths are contained within the workspace.
		const validDirs = appDirs.filter(dir => {
			const resolved = path.resolve(workspacePath, dir);
			const relative = path.relative(workspacePath, resolved);
			return !relative.startsWith('..') && !path.isAbsolute(relative);
		});

		if (validDirs.length === 0) {
			deps.showWarning('All winapp.appDirectories entries resolve outside the workspace and were ignored.');
		} else if (validDirs.length === 1) {
			return path.resolve(workspacePath, validDirs[0]);
		} else {
			const items: ProjectQuickPickItem[] = validDirs.map(dir => ({
				label: `$(folder) ${dir}`,
				directory: path.resolve(workspacePath, dir)
			}));
			return deps.pickDirectory(items, 'Which project would you like to target?');
		}
	}

	// 2) Project at the workspace root — use it directly.
	const rootProject = await detectProjectAt(workspacePath, workspacePath);
	if (rootProject) {
		return workspacePath;
	}

	// 3) Scan the workspace for projects.
	const projects = await deps.scanProjects(workspacePath);

	if (projects.length === 0) {
		// No projects found — fall back to the workspace root.
		return workspacePath;
	}

	if (projects.length === 1) {
		// Single project — auto-select it.
		return projects[0].directory;
	}

	// Multiple projects — let the user pick.
	const items: ProjectQuickPickItem[] = projects.map(p => ({
		label: `$(file-code) ${p.type} project`,
		description: getDisplayFilePath(p),
		directory: p.directory
	}));

	const placeHolder = projects.length >= MAX_SCANNED_PROJECTS
		? 'Which project? (Search stopped at 10 entries)'
		: 'Which project would you like to target?';

	return deps.pickDirectory(items, placeHolder);
}

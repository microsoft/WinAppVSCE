import * as fsp from 'fs/promises';
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
		// Validate that each entry stays within the workspace (see isContainedInWorkspace).
		const validDirs: string[] = [];
		for (const dir of appDirs) {
			if (await isContainedInWorkspace(workspacePath, dir)) {
				validDirs.push(dir);
			}
		}
		const droppedCount = appDirs.length - validDirs.length;

		if (validDirs.length === 0) {
			deps.showWarning('All winapp.appDirectories entries resolve outside the workspace and were ignored.');
		} else {
			// Surface a warning when some (but not all) entries were ignored so a
			// misconfigured setting does not silently retarget the command.
			if (droppedCount > 0) {
				const noun = droppedCount === 1 ? 'entry' : 'entries';
				const verb = droppedCount === 1 ? 'was' : 'were';
				deps.showWarning(`${droppedCount} winapp.appDirectories ${noun} resolve outside the workspace and ${verb} ignored.`);
			}

			if (validDirs.length === 1) {
				return path.resolve(workspacePath, validDirs[0]);
			}

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

/**
 * Determines whether `dir` (resolved relative to `workspacePath`) stays inside
 * the workspace.
 *
 * Applies a lexical check first (rejecting `..` traversal and absolute paths),
 * then — when the target exists on disk — a real-path check so that a symlink
 * or junction living inside the workspace cannot point the command at a
 * directory outside it. Non-existent targets cannot be reparse points, so the
 * lexical result stands.
 */
async function isContainedInWorkspace(workspacePath: string, dir: string): Promise<boolean> {
	const resolved = path.resolve(workspacePath, dir);
	const relative = path.relative(workspacePath, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return false;
	}

	try {
		const realWorkspace = await fsp.realpath(workspacePath);
		const realResolved = await fsp.realpath(resolved);
		const realRelative = path.relative(realWorkspace, realResolved);
		if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
			return false;
		}
	} catch {
		// The target (or workspace) does not exist yet — it cannot be a symlink
		// escape, so the lexical check above is authoritative.
	}

	return true;
}

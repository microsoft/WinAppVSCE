import * as fsp from 'fs/promises';
import * as path from 'path';
import { ALWAYS_SKIP_DIRS, isContainedInReal, isOfferableProject, readProjectRunnability } from './project-detection';

/**
 * How `winapp run` will interpret a given input path.
 *
 * The CLI accepts a build-output folder, a `.csproj`, a `.sln`/`.slnx`, or a
 * directory containing one of those at its top level, and decides for itself
 * which mode to use. The extension classifies the same input only so it can
 * decide which options are meaningful (project-only options are silently
 * ignored in folder mode) and which prompts to show — the classification is
 * never passed to the CLI.
 */
export type RunTargetKind = 'project' | 'solution' | 'folder' | 'unknown';

/** Project file extensions the CLI can build in project mode. */
export const PROJECT_FILE_EXTENSIONS = ['.csproj'] as const;

/** Solution file extensions the CLI can build in project mode. */
export const SOLUTION_FILE_EXTENSIONS = ['.sln', '.slnx'] as const;

/**
 * VS Code glob matching every project/solution file. Project-file discovery is
 * dramatically cheaper and more precise than scanning for `**\/*.exe`, so this
 * is the primary discovery mechanism; the executable scan is only a fallback.
 */
export const PROJECT_FILE_GLOB = '**/*.{sln,slnx,csproj}';

/**
 * Maximum number of project/solution files to read from the glob. The glob is
 * targeted rather than speculative, so this is generous — it exists to bound
 * the work on a monorepo, not to bound what the user sees. Display is capped
 * separately by {@link RUN_TARGET_DISPLAY_LIMIT} after filtering.
 */
export const PROJECT_FILE_MAX_RESULTS = 200;

/**
 * Maximum number of run targets shown in the picker.
 *
 * A large repository can contain dozens of project files; listing them all
 * produces a wall of names that is slower to scan than simply browsing to the
 * one you want. Matches the build-output picker's cap, and the picker always
 * offers Browse so nothing is unreachable.
 */
export const RUN_TARGET_DISPLAY_LIMIT = 10;

/** Directories excluded from project-file discovery. */
export const PROJECT_FILE_SKIP_DIRS = [
	...ALWAYS_SKIP_DIRS,
	// A project file under a build-output directory is a copy, never a source.
	'bin', 'obj', 'dist', 'build', 'out', 'target', 'artifacts', 'AppX'
];

/** VS Code-compatible exclude glob for project-file discovery. */
export const PROJECT_FILE_EXCLUDE_GLOB = `{${PROJECT_FILE_SKIP_DIRS.map(d => `**/${d}/**`).join(',')}}`;

/** A workspace folder, reduced to what target discovery needs. */
export interface WorkspaceRoot {
	/** The folder's display name (`vscode.WorkspaceFolder.name`). */
	name: string;
	/** Absolute filesystem path of the folder. */
	path: string;
}

/** A candidate target for `winapp run`. */
export interface RunTargetCandidate {
	kind: RunTargetKind;
	/** Absolute path passed to the CLI as the positional `input` argument. */
	path: string;
	/** The workspace root this candidate was discovered under. */
	root: WorkspaceRoot;
}

/**
 * Classifies a path by its file extension alone.
 *
 * Returns `undefined` for anything that is not a recognized project or
 * solution file, including directories — use {@link classifyRunTargetEntries}
 * for those, since classifying a directory requires knowing its contents.
 */
export function classifyRunTargetFile(filePath: string): RunTargetKind | undefined {
	const extension = path.extname(filePath).toLowerCase();
	if ((SOLUTION_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'solution';
	}
	if ((PROJECT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'project';
	}
	return undefined;
}

/**
 * Classifies a directory from the names of the entries at its top level.
 *
 * Mirrors the CLI's own precedence: a solution wins over a project, and a
 * project wins over loose executables (the CLI prefers to build rather than
 * run stale output). A directory with neither is `unknown` — the CLI will
 * still be given the chance to reject it, since it understands framework
 * layouts the extension does not.
 */
export function classifyRunTargetEntries(entryNames: readonly string[]): RunTargetKind {
	let hasProject = false;
	let hasExecutable = false;

	for (const name of entryNames) {
		const extension = path.extname(name).toLowerCase();
		if ((SOLUTION_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
			return 'solution';
		}
		if ((PROJECT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
			hasProject = true;
		} else if (extension === '.exe') {
			hasExecutable = true;
		}
	}

	if (hasProject) { return 'project'; }
	if (hasExecutable) { return 'folder'; }
	return 'unknown';
}

/**
 * Classifies an input path on disk, reading the directory when needed.
 *
 * Non-existent paths classify from their extension so a `launch.json` naming a
 * not-yet-built project is still treated as project mode.
 */
export async function classifyRunTarget(inputPath: string): Promise<RunTargetKind> {
	const byExtension = classifyRunTargetFile(inputPath);
	if (byExtension) {
		return byExtension;
	}

	try {
		const stat = await fsp.stat(inputPath);
		if (!stat.isDirectory()) {
			return 'unknown';
		}
	} catch {
		return 'unknown';
	}

	try {
		return classifyRunTargetEntries(await fsp.readdir(inputPath));
	} catch {
		return 'unknown';
	}
}

/** True when project-only options are meaningful for this target kind. */
export function isProjectMode(kind: RunTargetKind): boolean {
	return kind === 'project' || kind === 'solution';
}

/**
 * Extracts referenced project paths from a solution file.
 *
 * Handles both the classic `.sln` text format and the newer XML `.slnx`.
 * Returned paths are relative to the solution file, using the separators the
 * solution itself used; callers resolve them against the solution directory.
 *
 * This is a deliberately lightweight parse — consistent with how
 * `project-detection.ts` reads `<OutputType>` — used only to decide whether a
 * `--project` prompt is needed. When it comes up empty the caller omits
 * `--project` entirely and lets the CLI produce its own, better error.
 */
export function parseSolutionProjectPaths(content: string, solutionPath: string): string[] {
	const isXml = path.extname(solutionPath).toLowerCase() === '.slnx';
	const paths = isXml ? parseSlnxProjectPaths(content) : parseSlnProjectPaths(content);

	// Solution folders appear alongside real projects in both formats; keep only
	// entries that name a buildable project file.
	return paths.filter(p => classifyRunTargetFile(p) === 'project');
}

function parseSlnProjectPaths(content: string): string[] {
	// Project("{type-guid}") = "Name", "relative\path\Name.csproj", "{project-guid}"
	const pattern = /^Project\("\{[^}"]*\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]*)"/gm;
	const results: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		results.push(match[1]);
	}
	return results;
}

function parseSlnxProjectPaths(content: string): string[] {
	// <Project Path="src/MyApp/MyApp.csproj" />
	const pattern = /<Project\b[^>]*?\bPath\s*=\s*"([^"]*)"/g;
	const results: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		results.push(match[1]);
	}
	return results;
}

/**
 * Reads a solution and returns the absolute paths of the projects it contains.
 * Returns an empty array when the solution can't be read or parsed.
 *
 * Entries that resolve outside the solution's own directory are dropped. A
 * solution file is workspace content, and the picker shows only each project's
 * file name, so a `..\..\` entry would otherwise put an unreviewable path on a
 * `--project` argument behind a label that looks ordinary. Containment follows
 * reparse points, so a junction inside the solution directory cannot be used
 * to smuggle an outside path past the lexical check.
 */
export async function readSolutionProjectPaths(solutionPath: string): Promise<string[]> {
	let content: string;
	try {
		content = await fsp.readFile(solutionPath, 'utf-8');
	} catch {
		return [];
	}

	const solutionDir = path.dirname(solutionPath);
	const resolved = parseSolutionProjectPaths(content, solutionPath)
		.map(relative => path.resolve(solutionDir, relative.replace(/\\/g, path.sep)));
	const contained = await Promise.all(
		resolved.map(candidate => isContainedInReal(solutionDir, candidate))
	);
	return resolved.filter((_, index) => contained[index]);
}

/** True when `candidate` is inside `container` (or is `container` itself). */
export function isContainedIn(container: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(container), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Absolute paths of the projects directly inside a directory.
 *
 * Only the top level is read, matching the CLI's own rule that a directory
 * input is resolved from the projects "at its top level". Returns an empty
 * array when the directory can't be read.
 */
export async function readDirectoryProjectPaths(directoryPath: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fsp.readdir(directoryPath);
	} catch {
		return [];
	}

	return entries
		.filter(name => (PROJECT_FILE_EXTENSIONS as readonly string[])
			.includes(path.extname(name).toLowerCase()))
		.map(name => path.join(directoryPath, name))
		.sort((left, right) => left.localeCompare(right));
}

/**
 * Narrows a set of project paths to those worth offering the user.
 *
 * Projects the file explicitly identifies as a test project or a library are
 * dropped; everything else — including projects whose `OutputType` is
 * inherited or conditional — is kept. See
 * {@link import('./project-detection').classifyProjectRunnability} for why the
 * heuristic is deliberately one-sided.
 *
 * May return an empty array, and deliberately so. Anything the heuristic is
 * unsure about classifies as `unknown` and survives, so an empty result means
 * every candidate *explicitly* declared itself a library or a test project —
 * the one case where we can say with confidence that `winapp run` will reject
 * all of them. Offering them anyway would only invite the user to pick one and
 * walk into "is not a runnable project". Callers are expected to treat empty
 * as "nothing runnable here" and offer a route that can actually succeed.
 */
export async function filterOfferableProjects(projectPaths: readonly string[]): Promise<string[]> {
	const runnability = await Promise.all(projectPaths.map(readProjectRunnability));

	return projectPaths.filter((_, index) => isOfferableProject(runnability[index]));
}

/**
 * Removes project candidates that are already represented by a solution
 * candidate.
 *
 * Without this, a three-app solution produces four near-identical QuickPick
 * entries. The solution is the better target — it preserves solution-level
 * MSBuild context and lets `--project` disambiguate — so its members are
 * folded into it.
 *
 * @param candidates All discovered candidates.
 * @param solutionMembers Absolute project paths belonging to each solution,
 *   keyed by the solution's absolute path.
 */
export function dedupeSolutionMembers(
	candidates: readonly RunTargetCandidate[],
	solutionMembers: ReadonlyMap<string, readonly string[]>
): RunTargetCandidate[] {
	const covered = new Set<string>();
	for (const candidate of candidates) {
		if (candidate.kind !== 'solution') { continue; }
		for (const member of solutionMembers.get(candidate.path) ?? []) {
			covered.add(normalizeForComparison(member));
		}
	}

	if (covered.size === 0) {
		return [...candidates];
	}

	return candidates.filter(candidate =>
		candidate.kind !== 'project' || !covered.has(normalizeForComparison(candidate.path))
	);
}

/**
 * Applies {@link filterOfferableProjects} to the `project` candidates in a
 * discovered set, leaving solutions and build-output folders untouched.
 *
 * Solutions are never filtered: the CLI resolves the runnable project inside a
 * solution itself, and it does so with full MSBuild evaluation.
 *
 * A lone project is filtered like any other. Exempting it would let a
 * single-library workspace auto-select that library and run head-first into
 * the CLI's folder-mode fallback ("Manifest file not found"), which says
 * nothing about the real problem.
 */
export async function filterOfferableCandidates(
	candidates: readonly RunTargetCandidate[]
): Promise<RunTargetCandidate[]> {
	const projects = candidates.filter(candidate => candidate.kind === 'project');
	if (projects.length === 0) {
		return [...candidates];
	}

	const keep = new Set(await filterOfferableProjects(projects.map(candidate => candidate.path)));
	return candidates.filter(candidate => candidate.kind !== 'project' || keep.has(candidate.path));
}

/**
 * Sorts candidates for display: projects and solutions before build-output
 * folders, the preferred root first, then by path.
 *
 * `preferredRootPath` is normally the root owning the active editor, so the
 * app you are looking at is the top entry without the others being hidden.
 */
export function sortRunTargets(
	candidates: readonly RunTargetCandidate[],
	preferredRootPath?: string
): RunTargetCandidate[] {
	const preferred = preferredRootPath ? normalizeForComparison(preferredRootPath) : undefined;
	const kindRank = (kind: RunTargetKind): number => {
		switch (kind) {
			case 'solution': return 0;
			case 'project': return 1;
			case 'folder': return 2;
			default: return 3;
		}
	};

	return [...candidates].sort((left, right) => {
		if (preferred) {
			const leftPreferred = normalizeForComparison(left.root.path) === preferred ? 0 : 1;
			const rightPreferred = normalizeForComparison(right.root.path) === preferred ? 0 : 1;
			if (leftPreferred !== rightPreferred) { return leftPreferred - rightPreferred; }
		}

		const rankDelta = kindRank(left.kind) - kindRank(right.kind);
		if (rankDelta !== 0) { return rankDelta; }

		return left.path.localeCompare(right.path);
	});
}

/**
 * Identifies the workspace root containing `filePath`, preferring the deepest
 * match so nested roots resolve to the most specific one.
 */
export function findOwningRoot(
	roots: readonly WorkspaceRoot[],
	filePath: string | undefined
): WorkspaceRoot | undefined {
	if (!filePath) { return undefined; }

	let best: WorkspaceRoot | undefined;
	for (const root of roots) {
		const relative = path.relative(root.path, filePath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) { continue; }
		if (!best || root.path.length > best.path.length) {
			best = root;
		}
	}
	return best;
}

function normalizeForComparison(filePath: string): string {
	// Windows paths are case-insensitive, and discovery mixes separators
	// depending on whether a path came from a glob or a solution file.
	return path.resolve(filePath).replace(/[\\/]+/g, path.sep).toLowerCase();
}

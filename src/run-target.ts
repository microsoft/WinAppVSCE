import * as fsp from 'fs/promises';
import * as path from 'path';
import { isContainedIn, isContainedInReal, isOfferableProject, readProjectRunnability, type ProjectRunnability } from './project-detection';
import { attributeValue, findElementsByLocalName, tryParseXml } from './xml-read';
import type { WorkspaceRoot } from './workspace';

/** The extension-only target classification is never passed to the CLI. */
export type RunTargetKind = 'project' | 'solution' | 'folder' | 'unknown';

/** Project file extensions the CLI can build in project mode. */
export const PROJECT_FILE_EXTENSIONS = ['.csproj'] as const;

/**
 * .NET file-based apps run in project mode but are deliberately excluded from
 * discovery, from the Browse dialog's filters, and from the `--project` list:
 * every C# source file has this extension, so offering them would bury real
 * projects. A `.cs` path the user names explicitly — in `launch.json` or as a
 * debug input — is still accepted, because the CLI accepts it.
 */
export const FILE_BASED_APP_EXTENSIONS = ['.cs'] as const;

/** Solution file extensions the CLI can build in project mode. */
export const SOLUTION_FILE_EXTENSIONS = ['.sln', '.slnx'] as const;

/**
 * Extensions the extension offers on its own, via the workspace scan and the
 * Browse dialog's filter. File-based apps are excluded; see
 * {@link FILE_BASED_APP_EXTENSIONS}.
 */
export const DISCOVERABLE_TARGET_EXTENSIONS = [
	...SOLUTION_FILE_EXTENSIONS,
	...PROJECT_FILE_EXTENSIONS
] as const;

/** True for extensions the picker and Browse dialog offer. */
export function isDiscoverableTargetExtension(filePath: string): boolean {
	const extension = path.extname(filePath).toLowerCase();
	return (DISCOVERABLE_TARGET_EXTENSIONS as readonly string[]).includes(extension);
}

/** Bounds the project-file scan; display is capped separately. */
export const PROJECT_FILE_MAX_RESULTS = 200;

/** Caps picker entries while Browse keeps all targets reachable. */
export const RUN_TARGET_DISPLAY_LIMIT = 10;

/** A candidate target for `winapp run`. */
export interface RunTargetCandidate {
	kind: RunTargetKind;
	/** Absolute path passed to the CLI as the positional `input` argument. */
	path: string;
	/** The workspace root this candidate was discovered under. */
	root: WorkspaceRoot;
	/**
	 * True when no workspace folder owns `path` and `root` was synthesized from
	 * the target itself. Such a root is a working directory and a display
	 * anchor only — never a containment boundary, because it describes the
	 * target rather than the repository the target belongs to.
	 */
	rootIsSynthesized?: boolean;
}

/** Returns `undefined` for directories; classify those from top-level entries. */
export function classifyRunTargetFile(filePath: string): RunTargetKind | undefined {
	const extension = path.extname(filePath).toLowerCase();
	if ((SOLUTION_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'solution';
	}
	if ((PROJECT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'project';
	}
	if ((FILE_BASED_APP_EXTENSIONS as readonly string[]).includes(extension)) {
		return 'project';
	}
	return undefined;
}

/** Mirrors CLI precedence; `unknown` still goes to the CLI for final handling. */
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
	// Loose `.cs` files deliberately do NOT make a directory project mode: the
	// CLI reaches single-file mode only from an explicitly typed `.cs` path,
	// never from directory inference, so `winapp run <dir>` would run folder
	// mode and fail with "Manifest file not found". Leaving it `unknown` keeps
	// the extension's classification honest about what the CLI will do.
	return 'unknown';
}

/** Non-existent paths classify by extension so `launch.json` can name projects. */
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

/** Lightweight solution parse; empty results defer errors to the CLI. */
export function parseSolutionProjectPaths(content: string, solutionPath: string): string[] {
	const isXml = path.extname(solutionPath).toLowerCase() === '.slnx';
	const paths = isXml ? parseSlnxProjectPaths(content) : parseSlnProjectPaths(content);

	// Solution folders appear alongside real projects in both formats; keep only
	// entries that name a buildable project file. File-based apps are never
	// solution members, so the project-file list is the right filter here.
	return paths.filter(p =>
		(PROJECT_FILE_EXTENSIONS as readonly string[]).includes(path.extname(p).toLowerCase())
	);
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
	//
	// XML parse handles quoting, entities, and commented-out members.
	const doc = tryParseXml(content);
	if (!doc) {
		return [];
	}

	const results: string[] = [];
	for (const element of findElementsByLocalName(doc, 'Project')) {
		const value = attributeValue(element, 'Path');
		if (value) {
			results.push(value);
		}
	}
	return results;
}

/**
 * Drops solution entries that escape `containmentRoot` via reparse points.
 *
 * A solution may legitimately reference projects through `..` — a `solutions/`
 * directory alongside `src/` is a common layout — so containment is checked
 * against the owning workspace root when the caller knows it, and against the
 * solution's own directory otherwise.
 *
 * `unrestricted` drops the check entirely. It is for a solution the user named
 * in a file dialog outside every workspace folder: its repository root is
 * unknown, so any boundary we could invent would be the solution's own
 * directory, which discards the ordinary `solutions/` + `src/` layout. The
 * explicit pick is the trust decision, and `winapp run` resolves the same
 * members without a containment rule of its own.
 */
export async function readSolutionProjectPaths(
	solutionPath: string,
	containmentRoot?: string,
	options: { readonly unrestricted?: boolean } = {}
): Promise<string[]> {
	let content: string;
	try {
		content = await fsp.readFile(solutionPath, 'utf-8');
	} catch {
		return [];
	}

	const solutionDir = path.dirname(solutionPath);
	const resolved = parseSolutionProjectPaths(content, solutionPath)
		.map(relative => path.resolve(solutionDir, relative.replace(/\\/g, path.sep)));
	if (options.unrestricted) {
		return resolved;
	}

	const container = containmentRoot ?? solutionDir;
	const contained = await Promise.all(
		resolved.map(candidate => isContainedInReal(container, candidate))
	);
	return resolved.filter((_, index) => contained[index]);
}

/** Reads only top-level projects, matching the CLI's directory-input rule. */
export async function readDirectoryProjectPaths(directoryPath: string): Promise<string[]> {
	return readDirectoryEntriesWithExtensions(directoryPath, PROJECT_FILE_EXTENSIONS);
}

/** Check top-level solutions before projects; `winapp 0.7.0` does too. */
export async function readDirectorySolutionPaths(directoryPath: string): Promise<string[]> {
	return readDirectoryEntriesWithExtensions(directoryPath, SOLUTION_FILE_EXTENSIONS);
}

async function readDirectoryEntriesWithExtensions(
	directoryPath: string,
	extensions: readonly string[]
): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fsp.readdir(directoryPath);
	} catch {
		return [];
	}

	return entries
		.filter(name => extensions.includes(path.extname(name).toLowerCase()))
		.map(name => path.join(directoryPath, name))
		.sort((left, right) => left.localeCompare(right));
}

/** True when `targetPath` exists and is a directory. */
export async function isDirectory(targetPath: string): Promise<boolean> {
	try {
		return (await fsp.stat(targetPath)).isDirectory();
	} catch {
		return false;
	}
}

/** Directories classified as `solution` still need directory resolution first. */
export async function readTargetProjects(
	target: RunTargetCandidate
): Promise<{ projects: string[]; containerPath: string }> {
	if (!isProjectMode(target.kind)) {
		return { projects: [], containerPath: target.path };
	}

	// A synthesized root describes the browsed target, not the repository it
	// lives in, so it cannot bound the solution's members.
	const containmentRoot = target.rootIsSynthesized ? undefined : target.root.path;
	const containmentOptions = { unrestricted: target.rootIsSynthesized === true };

	if (await isDirectory(target.path)) {
		// A top-level solution takes precedence over projects; reading its
		// members lets browsed directories reach the --project prompt.
		const solutions = await readDirectorySolutionPaths(target.path);
		if (solutions.length === 1) {
			return {
				projects: await readSolutionProjectPaths(solutions[0], containmentRoot, containmentOptions),
				containerPath: path.dirname(solutions[0])
			};
		}
		if (solutions.length > 1) {
			// Which solution wins is the CLI's call, and it reports the
			// ambiguity precisely. Prompting here would mean guessing first.
			return { projects: [], containerPath: target.path };
		}

		const directoryProjects = await readDirectoryProjectPaths(target.path);
		if (directoryProjects.length > 0) {
			return { projects: directoryProjects, containerPath: target.path };
		}
		return { projects: [], containerPath: target.path };
	}

	if (target.kind === 'solution') {
		return {
			projects: await readSolutionProjectPaths(target.path, containmentRoot, containmentOptions),
			containerPath: path.dirname(target.path)
		};
	}

	// A path to a single .csproj already names the project.
	return { projects: [], containerPath: path.dirname(target.path) };
}

/** Drops only explicit test/library projects; `unknown` stays visible. */
export async function filterOfferableProjects(projectPaths: readonly string[]): Promise<string[]> {
	return (await classifyOfferableProjects(projectPaths)).map(entry => entry.path);
}

/**
 * Like {@link filterOfferableProjects}, but keeps each project's runnability so
 * callers can tell a confident `app` from an undecidable `unknown`. Prompting
 * on `unknown` would second-guess the CLI, which evaluates MSBuild properly.
 */
export async function classifyOfferableProjects(
	projectPaths: readonly string[]
): Promise<{ path: string; runnability: ProjectRunnability }[]> {
	const runnability = await Promise.all(projectPaths.map(readProjectRunnability));

	return projectPaths
		.map((projectPath, index) => ({ path: projectPath, runnability: runnability[index] }))
		.filter(entry => isOfferableProject(entry.runnability));
}

/**
 * Collapses same-folder, same-basename `.sln`/`.slnx` pairs into one entry,
 * preferring the newer `.slnx`. Visual Studio leaves both side by side during
 * `.slnx` migration, so without this a single-solution workspace stops
 * auto-selecting and prompts between two names for the same solution. The CLI
 * does exactly this (`CollapseSolutionMigrationPairs`); solutions with
 * distinct base names still require an explicit choice.
 */
export function collapseSolutionMigrationPairs(
	candidates: readonly RunTargetCandidate[]
): RunTargetCandidate[] {
	const superseded = new Set<string>();

	for (const candidate of candidates) {
		if (path.extname(candidate.path).toLowerCase() !== '.slnx') { continue; }
		const stem = candidate.path.slice(0, -'.slnx'.length);
		superseded.add(normalizeForComparison(`${stem}.sln`));
	}

	if (superseded.size === 0) {
		return [...candidates];
	}

	return candidates.filter(candidate => !superseded.has(normalizeForComparison(candidate.path)));
}

/** Folds solution members into the solution target to preserve MSBuild context. */
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

/** Solutions are never filtered; the CLI resolves them with full MSBuild. */
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

/** Orders candidates for the picker; never filters. */
export function sortRunTargets(
	candidates: readonly RunTargetCandidate[]
): RunTargetCandidate[] {
	const kindRank = (kind: RunTargetKind): number => {
		switch (kind) {
			case 'solution': return 0;
			case 'project': return 1;
			case 'folder': return 2;
			default: return 3;
		}
	};

	return [...candidates].sort((left, right) => {
		const rankDelta = kindRank(left.kind) - kindRank(right.kind);
		if (rankDelta !== 0) { return rankDelta; }

		// The directory walk visits roots in queue order, so sort by path to
		// keep the picker alphabetical within each kind.
		return left.path.localeCompare(right.path);
	});
}

/** Prefers the deepest matching workspace root for nested roots. */
export function findOwningRoot(
	roots: readonly WorkspaceRoot[],
	filePath: string | undefined
): WorkspaceRoot | undefined {
	if (!filePath) { return undefined; }

	let best: WorkspaceRoot | undefined;
	for (const root of roots) {
		if (!isContainedIn(root.path, filePath)) { continue; }
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

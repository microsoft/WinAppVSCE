import * as path from "path";

export const PROJECT_INPUTS_NOTIFICATION = "winui-xaml/projectInputs";
export const PROJECT_INPUT_GLOB = "**/*.{cs,csproj,vcxproj,xaml,props,targets}";

export interface ProjectInputsNotification {
  projectPath?: string;
  projectPaths?: string[];
  generatorInputFiles?: string[];
}

export interface ProjectInputWatchSpec {
  key: string;
  base: string;
  pattern: string;
}

export function getProjectInputWatchSpecs(
  notification: ProjectInputsNotification,
  workspaceRoots: readonly string[] = []
): ProjectInputWatchSpec[] {
  const specs = new Map<string, ProjectInputWatchSpec>();

  for (const projectPath of notification.projectPaths ?? []) {
    if (!path.isAbsolute(projectPath)) {
      continue;
    }

    const base = path.dirname(path.normalize(projectPath));
    if (workspaceRoots.some((root) => isWithin(base, root))) {
      continue;
    }
    addSpec(specs, base, PROJECT_INPUT_GLOB);
  }

  for (const inputFile of notification.generatorInputFiles ?? []) {
    if (!path.isAbsolute(inputFile)) {
      continue;
    }

    const normalized = path.normalize(inputFile);
    addSpec(specs, path.dirname(normalized), path.basename(normalized));
  }

  return [...specs.values()];
}

function addSpec(
  specs: Map<string, ProjectInputWatchSpec>,
  base: string,
  pattern: string
): void {
  const key = normalizeKey(`${base}\0${pattern}`);
  specs.set(key, { key, base, pattern });
}

function normalizeKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative.length === 0 ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

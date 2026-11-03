import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  PROJECT_INPUT_GLOB,
  PROJECT_INPUTS_NOTIFICATION,
  getProjectInputWatchSpecs,
} from "../xaml/projectInputWatcher";

test("project input notification name stays aligned with the language server", () => {
  assert.equal(PROJECT_INPUTS_NOTIFICATION, "winui-xaml/projectInputs");
});

test("project paths create recursive watchers and generator inputs create exact watchers", () => {
  const root = path.parse(process.cwd()).root;
  const appProject = path.join(root, "repo", "App", "App.csproj");
  const siblingProject = path.join(root, "repo", "Shared", "Shared.csproj");
  const additionalFile = path.join(root, "repo", "Shared", "settings.json");

  const specs = getProjectInputWatchSpecs(
    {
      projectPaths: [appProject, siblingProject],
      generatorInputFiles: [additionalFile],
    },
    [path.dirname(appProject)]
  );

  assert.deepEqual(
    specs.map(({ base, pattern }) => ({ base, pattern })),
    [
      { base: path.dirname(siblingProject), pattern: PROJECT_INPUT_GLOB },
      { base: path.dirname(additionalFile), pattern: path.basename(additionalFile) },
    ]
  );
});

test("invalid relative paths are ignored and duplicate watcher specs are collapsed", () => {
  const projectPath = path.join(path.parse(process.cwd()).root, "repo", "App", "App.csproj");

  const specs = getProjectInputWatchSpecs({
    projectPaths: [projectPath, projectPath, "relative.csproj"],
    generatorInputFiles: ["relative.json"],
  });

  assert.equal(specs.length, 1);
  assert.equal(specs[0].base, path.dirname(projectPath));
  assert.equal(specs[0].pattern, PROJECT_INPUT_GLOB);
});

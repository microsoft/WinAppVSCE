import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/get-build-number.ps1");

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function commit(root, message) {
  run("git", ["add", "."], root);
  run(
    "git",
    ["-c", "commit.gpgSign=false", "commit", "--no-verify", "-m", message, "--quiet"],
    root
  );
}

test("build number tracks version history and local artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "winapp-build-number-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "artifacts"));
    cpSync(script, join(root, "scripts", "get-build-number.ps1"));
    writeFileSync(
      join(root, "package.json"),
      '{\n  "name": "probe",\n  "version": "1.2.3",\n  "private": true\n}\n'
    );

    run("git", ["init", "--quiet"], root);
    run("git", ["config", "user.email", "test@example.invalid"], root);
    run("git", ["config", "user.name", "Build Number Test"], root);
    commit(root, "Set version");

    writeFileSync(join(root, "one.txt"), "one\n");
    commit(root, "First change");
    writeFileSync(join(root, "two.txt"), "two\n");
    commit(root, "Second change");

    assert.equal(
      run("pwsh", ["-NoProfile", "-File", join(root, "scripts", "get-build-number.ps1")], root),
      "3"
    );

    writeFileSync(
      join(root, "package.json"),
      '{\n  "name": "probe",\n  "version": "1.2.3",\n  "private": true,\n  "contributes": { "commands": [] }\n}\n'
    );
    commit(root, "Change package contributions");
    assert.equal(
      run("pwsh", ["-NoProfile", "-File", join(root, "scripts", "get-build-number.ps1")], root),
      "4"
    );

    writeFileSync(
      join(root, "package.json"),
      '{\n  "name": "probe",\n  "version": "1.2.4",\n  "private": true,\n  "contributes": { "commands": [] }\n}\n'
    );
    commit(root, "Bump version");
    assert.equal(
      run("pwsh", ["-NoProfile", "-File", join(root, "scripts", "get-build-number.ps1")], root),
      "1"
    );

    writeFileSync(join(root, "one.txt"), "updated\n");
    commit(root, "Change after version bump");
    assert.equal(
      run("pwsh", ["-NoProfile", "-File", join(root, "scripts", "get-build-number.ps1")], root),
      "2"
    );

    writeFileSync(join(root, "artifacts", "winapp-1.2.4-prerelease.8.vsix"), "");
    writeFileSync(join(root, "artifacts", "winapp-1.2.3-prerelease.latest.vsix"), "");
    writeFileSync(join(root, "artifacts", "winapp-9.9.9-prerelease.99.vsix"), "");
    assert.equal(
      run("pwsh", ["-NoProfile", "-File", join(root, "scripts", "get-build-number.ps1")], root),
      "9"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

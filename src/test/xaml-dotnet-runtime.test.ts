import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createDotnetChildEnvironment,
  listSearchableDirectories,
  resolveDotnetCommand,
} from "../xaml/dotnetRuntime";

test("points DOTNET_ROOT and DOTNET_HOST_PATH at an explicitly named host", () => {
  const env = createDotnetChildEnvironment("C:\\dotnet10\\dotnet.exe", {
    PATH: "C:\\dotnet10",
    DOTNET_HOST_PATH: "C:\\dotnet8\\dotnet.exe",
  });

  assert.equal(env.DOTNET_HOST_PATH, "C:\\dotnet10\\dotnet.exe");
  assert.equal(env.DOTNET_ROOT, "C:\\dotnet10");
  assert.equal(env.PATH, "C:\\dotnet10");
});

// An inherited DOTNET_HOST_PATH would send the server's MSBuild to a host other than the `dotnet`
// being launched, while DOTNET_ROOT is how a user's non-default SDK install is found.
test("clears an inherited DOTNET_HOST_PATH but keeps DOTNET_ROOT when dotnet comes from PATH", () => {
  const logged: string[] = [];
  const env = createDotnetChildEnvironment(
    "dotnet",
    {
      PATH: "C:\\dotnet10",
      DOTNET_HOST_PATH: "C:\\dotnet8\\dotnet.exe",
      DOTNET_ROOT: "C:\\custom-sdk",
    },
    (message) => logged.push(message)
  );

  assert.ok(!("DOTNET_HOST_PATH" in env));
  assert.equal(env.DOTNET_ROOT, "C:\\custom-sdk");
  assert.equal(env.PATH, "C:\\dotnet10");
  assert.equal(logged.length, 1);
});

// The server is self-contained and C++ projects never invoke dotnet, so PATH is the discovery
// mechanism and the override exists only so tests can pin a specific install.
test("reports no host when PATH holds none, unless an explicit override is set", () => {
  assert.equal(resolveDotnetCommand({}), undefined);
  assert.equal(resolveDotnetCommand({ PATH: "" }), undefined);
  assert.equal(
    resolveDotnetCommand({ WINUI_XAML_DOTNET_PATH: "C:\\dotnet10\\dotnet.exe" }),
    "C:\\dotnet10\\dotnet.exe"
  );
});

// Restore and build run with the project folder as the working directory, and Windows resolves
// empty and relative entries against it, so a dotnet planted in an opened repo would win.
test("never searches a PATH entry that resolves against the working directory", () => {
  const absolute = path.join(os.tmpdir(), "winui-xaml-absolute");
  const entries = ["", ".", "..", "relative", path.join(".", "tools")];

  assert.deepEqual(
    listSearchableDirectories({ PATH: [...entries, absolute].join(path.delimiter) }),
    [absolute]
  );
  assert.deepEqual(listSearchableDirectories({ PATH: entries.join(path.delimiter) }), []);
});

test("returns the first absolute PATH entry holding a dotnet executable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winui-xaml-dotnet-"));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "winui-xaml-nodotnet-"));
  const planted = path.join(dir, process.platform === "win32" ? "dotnet.exe" : "dotnet");
  fs.writeFileSync(planted, "");

  try {
    assert.equal(resolveDotnetCommand({ PATH: dir }), planted);
    assert.equal(resolveDotnetCommand({ PATH: empty }), undefined);
    assert.equal(
      resolveDotnetCommand({ PATH: ["", ".", empty, dir].join(path.delimiter) }),
      planted
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("does not mutate the source environment", () => {
  const source = { DOTNET_HOST_PATH: "C:\\dotnet8\\dotnet.exe" };
  createDotnetChildEnvironment("C:\\dotnet10\\dotnet.exe", source);

  assert.equal(source.DOTNET_HOST_PATH, "C:\\dotnet8\\dotnet.exe");
  assert.ok(!("DOTNET_ROOT" in source));
});

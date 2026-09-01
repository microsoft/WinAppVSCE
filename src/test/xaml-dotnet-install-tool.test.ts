import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFindPathRequest,
  DOTNET_INSTALL_TOOL_ID,
  DotnetFindPathRequest,
  DotnetHostResolver,
  InstallToolHost,
} from "../xaml/dotnetInstallTool";

interface FakeHostOptions {
  installed?: boolean;
  installSucceeds?: boolean;
  installRegisters?: boolean;
  activateSucceeds?: boolean;
  findPath?: () => Promise<{ dotnetPath: string } | undefined>;
}

interface FakeHost extends InstallToolHost {
  installCalls: number;
  activateCalls: number;
  findPathCalls: DotnetFindPathRequest[];
  messages: string[];
}

function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  let installed = options.installed ?? true;
  const host: FakeHost = {
    installCalls: 0,
    activateCalls: 0,
    findPathCalls: [],
    messages: [],
    isInstalled: () => installed,
    install: async () => {
      host.installCalls += 1;
      if (options.installSucceeds === false) {
        throw new Error("marketplace disabled");
      }
      if (options.installRegisters !== false) {
        installed = true;
      }
    },
    activate: async () => {
      host.activateCalls += 1;
      if (options.activateSucceeds === false) {
        throw new Error("activation failed");
      }
    },
    findPath: async (request) => {
      host.findPathCalls.push(request);
      return options.findPath
        ? options.findPath()
        : { dotnetPath: "C:\\Program Files\\dotnet\\dotnet.exe" };
    },
    log: (message) => host.messages.push(message),
    now: () => 0,
  };
  return host;
}

test("pins the request to the major version the server targets", () => {
  const request = buildFindPathRequest("ms-windows-ap.winapp", "x64");

  // greater_than_or_equal would also accept a .NET 11 host, which cannot run a
  // net10.0 app without cross-major roll-forward.
  assert.equal(request.versionSpecRequirement, "equal");
  assert.equal(request.acquireContext.version, "10.0");
  assert.equal(request.acquireContext.mode, "runtime");
  assert.equal(request.acquireContext.architecture, "x64");
  assert.equal(request.acquireContext.requestingExtensionId, "ms-windows-ap.winapp");
  // A released net10.0 app does not roll forward onto a prerelease runtime.
  assert.equal(request.rejectPreviews, true);
});

test("resolves through the Install Tool when it is already present", async () => {
  const host = createFakeHost();
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  const resolution = await resolver.resolve();

  assert.deepEqual(resolution, {
    status: "resolved",
    dotnetPath: "C:\\Program Files\\dotnet\\dotnet.exe",
  });
  assert.equal(host.installCalls, 0);
  assert.equal(host.activateCalls, 1);
});

test("installs the Install Tool on demand, then resolves", async () => {
  const host = createFakeHost({ installed: false });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "arm64");

  const resolution = await resolver.resolve();

  assert.equal(resolution.status, "resolved");
  assert.equal(host.installCalls, 1);
  assert.equal(host.findPathCalls[0].acquireContext.architecture, "arm64");
});

test("reports install-tool-unavailable when the install fails", async () => {
  const host = createFakeHost({ installed: false, installSucceeds: false });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  const resolution = await resolver.resolve();

  assert.deepEqual(resolution, { status: "failed", reason: "install-tool-unavailable" });
  assert.equal(host.findPathCalls.length, 0);
  assert.ok(host.messages.some((m) => m.includes(DOTNET_INSTALL_TOOL_ID)));
});

test("reports install-tool-unavailable when the tool never registers", async () => {
  const host = createFakeHost({ installed: false, installRegisters: false });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  const resolution = await resolver.resolve();

  assert.deepEqual(resolution, { status: "failed", reason: "install-tool-unavailable" });
  assert.ok(host.messages.some((m) => m.includes("reload the window")));
});

test("reports install-tool-unavailable when activation fails", async () => {
  const host = createFakeHost({ activateSucceeds: false });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  const resolution = await resolver.resolve();

  assert.deepEqual(resolution, { status: "failed", reason: "install-tool-unavailable" });
  assert.equal(host.findPathCalls.length, 0);
});

test("attempts the install at most once per session", async () => {
  const host = createFakeHost({ installed: false, installSucceeds: false });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  await resolver.resolve();
  await resolver.resolve();
  await resolver.resolve();

  // A disabled marketplace is not fixed by retrying on every server start.
  assert.equal(host.installCalls, 1);
});

test("distinguishes a missing runtime from a missing Install Tool", async () => {
  const host = createFakeHost({ findPath: async () => undefined });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  const resolution = await resolver.resolve();

  assert.deepEqual(resolution, { status: "failed", reason: "runtime-not-found" });
});

test("treats a findPath rejection as an Install Tool failure", async () => {
  const host = createFakeHost({
    findPath: async () => {
      throw new Error("command not found");
    },
  });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  const resolution = await resolver.resolve();

  assert.deepEqual(resolution, { status: "failed", reason: "install-tool-unavailable" });
});

test("caches the resolved host for the session", async () => {
  const host = createFakeHost();
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  await resolver.resolve();
  await resolver.resolve();

  assert.equal(host.findPathCalls.length, 1);
});

test("invalidate makes the next resolve a genuine retry", async () => {
  const host = createFakeHost();
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  await resolver.resolve();
  resolver.invalidate();
  await resolver.resolve();

  assert.equal(host.findPathCalls.length, 2);
});

test("does not cache a failure", async () => {
  let found = false;
  const host = createFakeHost({
    findPath: async () =>
      found ? { dotnetPath: "C:\\Program Files\\dotnet\\dotnet.exe" } : undefined,
  });
  const resolver = new DotnetHostResolver(host, "ms-windows-ap.winapp", "x64");

  assert.equal((await resolver.resolve()).status, "failed");
  found = true;
  assert.equal((await resolver.resolve()).status, "resolved");
});

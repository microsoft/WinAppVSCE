import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { serverRidFor } from "../xaml/serverRid";

// CI runs on x64, so a regression that always returned win-x64 would leave ARM64 users silently
// running the emulated binary and every suite would still be green. These assertions are the only
// thing that distinguishes "picked the right RID" from "picked the CI RID".
describe("serverRidFor", () => {
  it("maps supported Windows architectures to their bundled RID", () => {
    assert.equal(serverRidFor("win32", "arm64"), "win-arm64");
    assert.equal(serverRidFor("win32", "x64"), "win-x64");
  });

  it("rejects Windows architectures the VSIX carries no binary for", () => {
    assert.equal(serverRidFor("win32", "ia32"), undefined);
    assert.equal(serverRidFor("win32", "x32"), undefined);
  });

  // The .exe ships unconditionally, so on these hosts resolution would otherwise succeed and
  // spawn would fail with ENOEXEC rather than an explanation.
  it("rejects non-Windows hosts outright", () => {
    assert.equal(serverRidFor("linux", "x64"), undefined);
    assert.equal(serverRidFor("darwin", "arm64"), undefined);
  });
});

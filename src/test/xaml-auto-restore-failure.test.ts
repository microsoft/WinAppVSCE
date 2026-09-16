import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Auto-restore failure must leave two signals because the user did not start it and otherwise only sees its aftermath.
// First: in-flight count is decremented so the bar leaves "restoring" and shows the still-outstanding restore-required instruction.
// Second: the failure is notified; source-level assertions are enough because the private restore path's required accounting/notification structure is visible here.
const source = readFileSync(
  path.join(__dirname, "..", "..", "src", "xaml", "xamlLanguageService.ts"),
  "utf8"
);

/** Strips comments so prose cannot satisfy or trip these assertions. */
function code(): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The body of `restoreProject`, from its declaration to the start of the next declaration. */
function restoreProjectBody(): string {
  const body = code();
  const start = body.indexOf("async function restoreProject(");
  assert.notEqual(start, -1, "restoreProject is no longer declared under that name");

  const next = body.indexOf("\nfunction ", start);
  const end = next === -1 ? body.length : next;
  return body.slice(start, end);
}

test("the restore in-flight count is released on the failure path", () => {
  const body = restoreProjectBody();

  assert.ok(
    /restoresInFlight\s*\+=\s*1/.test(body),
    "restoreProject no longer increments the in-flight count; this test needs rewriting"
  );

  const decrement = body.indexOf("restoresInFlight -= 1");
  assert.notEqual(decrement, -1, "restoreProject never releases the in-flight count");

  // The release must be in a `finally`, not at the end of `try` and not only in `catch`. A
  // decrement that a thrown error can skip is the leak this guards against.
  const finallyStart = body.indexOf("} finally {");
  assert.notEqual(
    finallyStart,
    -1,
    "restoreProject has no finally block, so a failing restore can skip the release of the " +
      "in-flight count and pin the status bar to 'restoring packages'"
  );
  assert.ok(
    decrement > finallyStart,
    "the in-flight count is released outside the finally block, so a failed restore leaks it"
  );
});

test("the status bar is re-rendered after the count is released", () => {
  const body = restoreProjectBody();
  const decrement = body.indexOf("restoresInFlight -= 1");
  const render = body.indexOf("renderProjectContextStatus()", decrement);

  // Releasing the count without re-rendering leaves the stale spinner on screen, which is the
  // same user-visible defect as never releasing it.
  assert.notEqual(
    render,
    -1,
    "the status bar is not re-rendered after a restore finishes, so the spinner outlives the restore"
  );
});

test("a failed restore is surfaced to the user, not only logged", () => {
  const body = restoreProjectBody();
  const catchStart = body.indexOf("} catch (error) {");
  assert.notEqual(catchStart, -1, "restoreProject no longer catches its failures");

  const finallyStart = body.indexOf("} finally {");
  const handler = body.slice(catchStart, finallyStart === -1 ? body.length : finallyStart);

  assert.ok(
    /showErrorMessage/.test(handler),
    "a failed automatic restore is only logged; the user never asked for it, so silence is " +
      "indistinguishable from the extension doing nothing"
  );
  assert.ok(
    /showOutput/.test(handler),
    "the restore failure notification offers no way to see why it failed"
  );
});

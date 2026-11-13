import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOSE_ACTION_DO_NOT_RESTART,
  ERROR_ACTION_SHUTDOWN,
  HandlerResult,
  reportFinalStops,
} from "../xaml/serverStopHandling";
import { buildDegradedNotification } from "../xaml/degradedNotification";
import { SERVER_STOPPED_STATUS_PRESENTATION } from "../xaml/projectContextStatus";

const RESTART = 2;
const CONTINUE = 1;

function handlerReturning(closed: HandlerResult, error: HandlerResult) {
  return {
    error: async () => error,
    closed: async () => closed,
  };
}

// Regression for #363: after the crash limit the client must not show its own "Go to output" toast.
test("a final close is handled and reported once with the client's reason", async () => {
  const reasons: Array<string | undefined> = [];
  const crashLimit = "The server crashed 5 times in the last 3 minutes.";
  const handler = reportFinalStops(
    handlerReturning(
      { action: CLOSE_ACTION_DO_NOT_RESTART, message: crashLimit },
      { action: CONTINUE }
    ),
    (reason) => reasons.push(reason)
  );

  const result = await handler.closed();

  assert.equal(result.action, CLOSE_ACTION_DO_NOT_RESTART);
  assert.equal(result.handled, true);
  assert.deepEqual(reasons, [crashLimit]);
});

test("an automatic restart passes through without reporting a stop", async () => {
  const reasons: Array<string | undefined> = [];
  const handler = reportFinalStops(
    handlerReturning({ action: RESTART }, { action: CONTINUE }),
    (reason) => reasons.push(reason)
  );

  assert.deepEqual(await handler.closed(), { action: RESTART });
  assert.deepEqual(await handler.error(new Error("x"), undefined, 1), { action: CONTINUE });
  assert.deepEqual(reasons, []);
});

test("a connection error that shuts the server down is reported as a final stop", async () => {
  const reasons: Array<string | undefined> = [];
  const handler = reportFinalStops(
    handlerReturning({ action: RESTART }, { action: ERROR_ACTION_SHUTDOWN, message: "broken pipe" }),
    (reason) => reasons.push(reason)
  );

  const result = await handler.error(new Error("x"), undefined, 4);

  assert.equal(result.handled, true);
  assert.deepEqual(reasons, ["broken pipe"]);
});

test("the stopped notification and status bar offer Restart Language Server", () => {
  const { message, actions } = buildDegradedNotification("stopped", "crashed 5 times");
  assert.match(message, /will not restart automatically/);
  assert.match(message, /crashed 5 times/);
  assert.deepEqual(
    actions.map((action) => [action.label, action.command]),
    [
      ["Restart Language Server", "winapp.xaml.restartServer"],
      ["Show Output", undefined],
    ]
  );

  assert.doesNotMatch(SERVER_STOPPED_STATUS_PRESENTATION.text, /spin/);
  assert.equal(SERVER_STOPPED_STATUS_PRESENTATION.command, "winapp.xaml.restartServer");
  assert.equal(SERVER_STOPPED_STATUS_PRESENTATION.transient, false);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DismissalStore,
  notificationDismissal,
} from "../xaml/notificationDismissal";

/** Minimal stand-in for `vscode.ExtensionContext.globalState`. */
function createStore(initial: Record<string, unknown> = {}): DismissalStore & {
  readonly writes: [string, unknown][];
} {
  const values = new Map<string, unknown>(Object.entries(initial));
  const writes: [string, unknown][] = [];
  return {
    writes,
    get<T>(key: string, defaultValue: T): T {
      return values.has(key) ? (values.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown): Thenable<unknown> {
      values.set(key, value);
      writes.push([key, value]);
      return Promise.resolve();
    },
  };
}

describe("notificationDismissal", () => {
  it("reports undismissed until the flag is stored", () => {
    const store = createStore();
    assert.equal(notificationDismissal("some.key", store).isDismissed, false);
  });

  it("reports dismissed when the stored flag is set", () => {
    const store = createStore({ "some.key": true });
    assert.equal(notificationDismissal("some.key", store).isDismissed, true);
  });

  it("persists the dismissal under its own key", async () => {
    const store = createStore();
    await notificationDismissal("some.key", store).dismiss();

    assert.deepEqual(store.writes, [["some.key", true]]);
    assert.equal(notificationDismissal("some.key", store).isDismissed, true);
  });

  it("keeps separate keys independent", async () => {
    const store = createStore();
    await notificationDismissal("first.key", store).dismiss();

    assert.equal(notificationDismissal("first.key", store).isDismissed, true);
    assert.equal(notificationDismissal("second.key", store).isDismissed, false);
  });

  it("stays undismissed and absorbs dismissal when no store is available", async () => {
    const dismissal = notificationDismissal("some.key", undefined);

    assert.equal(dismissal.isDismissed, false);
    await dismissal.dismiss();
    assert.equal(dismissal.isDismissed, false);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { ServerLifecycle } from "../xaml/serverLifecycle";

test("queued restart cannot start after disposal begins", async () => {
  const lifecycle = new ServerLifecycle();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;

  const current = lifecycle.runExclusive(() => blocked);
  const queuedRestart = lifecycle.runExclusive(async () => {
    if (!lifecycle.isDisposing) {
      starts++;
    }
  });

  lifecycle.beginDisposal();
  release();
  await Promise.all([current, queuedRestart]);

  assert.equal(starts, 0);
});

test("reset permits starts after a new activation", async () => {
  const lifecycle = new ServerLifecycle();
  lifecycle.beginDisposal();
  lifecycle.reset();
  let starts = 0;

  await lifecycle.runExclusive(async () => {
    if (!lifecycle.isDisposing) {
      starts++;
    }
  });

  assert.equal(starts, 1);
});

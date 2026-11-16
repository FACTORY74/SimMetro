import test from "node:test";
import assert from "node:assert/strict";
import { StateCursor, retryUntilSuccess } from "./sync.ts";

test("a restarted server replaces high revisions and delayed old responses stay rejected", () => {
  const cursor = new StateCursor();
  assert.equal(cursor.query(), "");
  assert.ok(cursor.accept({ session: "old", revision: 900 }));
  assert.ok(!cursor.accept({ session: "old", revision: 899 }));
  assert.ok(cursor.accept({ session: "new", revision: 0 }));
  assert.equal(cursor.query(), "?since=0&session=new");
  assert.ok(!cursor.accept({ session: "old", revision: 901 }));
  assert.ok(!cursor.matches({ session: "old", revision: 0 }));
  assert.ok(cursor.matches({ session: "new", revision: 0 }));
  assert.ok(cursor.accept({ session: "new", revision: 1 }));
  assert.ok(!cursor.matches({ session: "new", revision: 0 }));
});

test("traffic retries transient failures without a new revision", async () => {
  let attempts = 0;
  let cancel = () => {};
  try {
    const value = await new Promise<number>(resolve => {
      cancel = retryUntilSuccess(async () => {
        if (++attempts < 3) throw new Error("offline");
        return 42;
      }, resolve, 1);
    });
    assert.equal(value, 42);
    assert.equal(attempts, 3);
  } finally { cancel(); }
});

test("cancelled traffic requests cannot publish stale results or retry", async () => {
  let deliver!: (value: number) => void;
  let signal!: AbortSignal;
  let accepted = false;
  const cancel = retryUntilSuccess(s => {
    signal = s;
    return new Promise<number>(resolve => { deliver = resolve; });
  }, () => { accepted = true; }, 1);
  cancel();
  deliver(42);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(signal.aborted);
  assert.equal(accepted, false);
});

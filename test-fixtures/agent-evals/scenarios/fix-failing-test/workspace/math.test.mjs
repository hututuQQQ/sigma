import assert from "node:assert/strict";
import test from "node:test";
import { add } from "./math.mjs";

test("add returns the sum", () => {
  assert.equal(add(7, 5), 12);
});

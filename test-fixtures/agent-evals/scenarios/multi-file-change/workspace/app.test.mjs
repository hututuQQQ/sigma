import assert from "node:assert/strict";
import test from "node:test";
import { apiVersion } from "./src/version.mjs";

test("exports the documented API version", () => {
  assert.equal(apiVersion, "v2");
});

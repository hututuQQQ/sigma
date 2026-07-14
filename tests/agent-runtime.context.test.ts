import { describe, expect, it } from "vitest";
import { baseContext } from "../packages/agent-runtime/src/runtime-context.js";

describe("runtime behavior context", () => {
  it("requires clarification before inventing consequential product requirements", () => {
    const behavior = baseContext().find((item) => item.id === "system:behavior")?.content ?? "";

    expect(behavior).toContain("Do not invent product requirements");
    expect(behavior).toContain("Before mutating");
    expect(behavior).toContain("neither the user nor repository conventions resolve it");
    expect(behavior).toContain("request_user_input");
  });
});

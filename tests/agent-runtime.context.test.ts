import { describe, expect, it } from "vitest";
import { baseContext } from "../packages/agent-runtime/src/runtime-context.js";

describe("runtime behavior context", () => {
  it("requires clarification before inventing consequential product requirements", () => {
    const behavior = baseContext().find((item) => item.id === "system:behavior")?.content ?? "";

    expect(behavior).toContain("do not invent requirements");
    expect(behavior).toContain("Inspect relevant repository state");
    expect(behavior).toContain("concrete missing decision");
    expect(behavior).toContain("request_user_input");
    expect(behavior).toContain("stop naturally");
  });
});

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
    expect(behavior).toContain("multiple tool calls are independent");
    expect(behavior).toContain("Keep dependent calls sequential");
    expect(behavior).toContain("never guess missing arguments or use placeholders");
    expect(behavior).toContain("Keep the user oriented during longer work");
    expect(behavior).toContain("Do not narrate every command");
    expect(behavior).toContain("local source, repository history, and tests");
    expect(behavior).toContain("Use web research only");
    expect(behavior).toContain("Do not search exact task wording");
    expect(behavior).toContain("Batch related repository reads and searches");
    expect(behavior).toContain("focused inspect-edit-test bug fix does not need a plan");
    expect(behavior).toContain("Do not use review as a routine completion step");
  });
});

import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "../packages/agent-core/src/controller/loop-controller.js";

describe("classifyTaskIntent", () => {
  it("treats PR review and analysis requests as non-mutation tasks", () => {
    expect(classifyTaskIntent("review PR #22")).not.toBe("mutation");
    expect(classifyTaskIntent("审查一下这个 PR")).not.toBe("mutation");
    expect(classifyTaskIntent("analyze pull request 22")).not.toBe("mutation");
    expect(classifyTaskIntent("inspect PR #22")).not.toBe("mutation");
    expect(classifyTaskIntent("PR review")).not.toBe("mutation");
    expect(classifyTaskIntent("code review")).not.toBe("mutation");
  });

  it("keeps explicit PR fixup requests as mutation tasks", () => {
    expect(classifyTaskIntent("fix the issue in PR #22")).toBe("mutation");
    expect(classifyTaskIntent("address PR review comments")).toBe("mutation");
    expect(classifyTaskIntent("修复这个 PR 的问题")).toBe("mutation");
    expect(classifyTaskIntent("根据 review 修改代码")).toBe("mutation");
  });

  it("classifies resume prompts from the new instruction rather than prior summary tool names", () => {
    const prompt = [
      "Previous Sigma session context (resume):",
      "- status: completed",
      "",
      "Prior summary:",
      "{\"tools_available\":[\"read\",\"write\",\"apply_patch\"]}",
      "",
      "New instruction:",
      "review PR #22"
    ].join("\n");

    expect(classifyTaskIntent(prompt)).not.toBe("mutation");
  });
});

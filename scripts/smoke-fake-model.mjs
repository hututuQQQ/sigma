function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: args
    }
  };
}

const TEST_COMMAND =
  "if [ -n \"${PYTHON_BIN:-}\" ]; then \"$PYTHON_BIN\" -m unittest -q; " +
  "elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then python3 -m unittest -q; " +
  "elif command -v python >/dev/null 2>&1 && python -c 'import sys' >/dev/null 2>&1; then python -m unittest -q; " +
  "elif command -v py >/dev/null 2>&1; then py -3 -m unittest -q; " +
  "else echo 'Python 3 is required to run this smoke task.' >&2; exit 127; fi";

const PLANS = {
  "create-file": [
    [toolCall("create-file-write", "write", { path: "hello.txt", content: "hello world", createDirs: true })]
  ],
  "edit-file": [
    [toolCall("edit-file-read", "read", { path: "app.txt" })],
    [
      toolCall("edit-file-edit", "edit", {
        path: "app.txt",
        oldString: "color=red",
        newString: "color=blue",
        expectedReplacements: 1
      })
    ]
  ],
  "fix-test": [
    [toolCall("fix-test-read", "read", { path: "math_utils.py" })],
    [
      toolCall("fix-test-edit", "edit", {
        path: "math_utils.py",
        oldString: "return a - b",
        newString: "return a + b",
        expectedReplacements: 1
      })
    ],
    [toolCall("fix-test-unittest", "bash", { command: TEST_COMMAND, timeoutSec: 30 })]
  ],
  "inspect-and-summarize": [
    [toolCall("inspect-read", "read", { path: "data/input.txt" })],
    [toolCall("inspect-write", "write", { path: "result.txt", content: "3", createDirs: true })]
  ]
};

export const smokeTaskNames = Object.freeze(Object.keys(PLANS));

export class SmokeFakeModel {
  provider = "fake";
  model = "smoke-fake-model";

  constructor(taskName) {
    if (!Object.hasOwn(PLANS, taskName)) {
      throw new Error(`No fake smoke plan exists for task '${taskName}'.`);
    }
    this.taskName = taskName;
    this.turn = 0;
  }

  async complete(_req) {
    const calls = PLANS[this.taskName][this.turn];
    this.turn += 1;

    if (!calls) {
      return {
        message: { role: "assistant", content: "done" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    }

    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: calls
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  }
}

import { afterEach, describe, expect, it } from "vitest";
import {
  createComposerState,
  deleteBackward,
  deleteForward,
  deletePreviousWord,
  insertText,
  killToEnd,
  killToStart,
  moveCursorEnd,
  moveCursorLeft,
  moveCursorRight,
  moveCursorStart,
  recallHistory,
  rememberInput,
  yank
} from "../packages/agent-tui/src/composer-state.js";
import { renderComposer } from "../packages/agent-tui/src/render/composer.js";

const savedEnv = {
  SIGMA_ASCII: process.env.SIGMA_ASCII,
  SIGMA_FORCE_UNICODE: process.env.SIGMA_FORCE_UNICODE,
  TERM: process.env.TERM
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent-tui composer editor", () => {
  it("inserts text at the cursor and supports backspace/delete", () => {
    const state = createComposerState("fi tests");
    state.cursor = 2;

    insertText(state, "x");
    expect(state.text).toBe("fix tests");
    expect(state.cursor).toBe(3);

    deleteBackward(state);
    expect(state.text).toBe("fi tests");
    expect(state.cursor).toBe(2);

    deleteForward(state);
    expect(state.text).toBe("fitests");
    expect(state.cursor).toBe(2);
  });

  it("moves left/right and to start/end", () => {
    const state = createComposerState("abcdef");
    moveCursorLeft(state);
    moveCursorLeft(state);
    expect(state.cursor).toBe(4);

    moveCursorRight(state);
    expect(state.cursor).toBe(5);

    moveCursorStart(state);
    expect(state.cursor).toBe(0);

    moveCursorEnd(state);
    expect(state.cursor).toBe(6);
  });

  it("handles Ctrl+U, Ctrl+K, Ctrl+W, and yank", () => {
    const state = createComposerState("one two three");
    state.cursor = "one two".length;

    deletePreviousWord(state);
    expect(state.text).toBe("one  three");
    expect(state.yankBuffer).toBe("two");

    yank(state);
    expect(state.text).toBe("one two three");

    killToStart(state);
    expect(state.text).toBe(" three");
    expect(state.yankBuffer).toBe("one two");

    moveCursorStart(state);
    killToEnd(state);
    expect(state.text).toBe("");
    expect(state.yankBuffer).toBe(" three");
  });

  it("supports multiline insertion with Ctrl+J semantics", () => {
    const state = createComposerState("first");
    insertText(state, "\nsecond");
    expect(state.text).toBe("first\nsecond");
    expect(state.cursor).toBe("first\nsecond".length);
  });

  it("cycles history up and down without losing the current draft", () => {
    const state = createComposerState("draft");
    rememberInput(state, "first");
    rememberInput(state, "second");
    state.text = "draft";
    state.cursor = state.text.length;

    recallHistory(state, "up");
    expect(state.text).toBe("second");

    recallHistory(state, "up");
    expect(state.text).toBe("first");

    recallHistory(state, "down");
    expect(state.text).toBe("second");

    recallHistory(state, "down");
    expect(state.text).toBe("draft");
  });

  it("renders compact mode-aware composer snapshots", () => {
    expect(renderComposer({
      state: createComposerState("fix tests"),
      mode: "build",
      running: false,
      approvalPending: false,
      width: 80,
      color: false
    })).toMatchInlineSnapshot(`
      "build › fix tests▌
      enter send · ctrl+j newline · tab plan/build · / commands · @ files · ! shell"
    `);

    expect(renderComposer({
      state: createComposerState("inspect"),
      mode: "plan",
      running: true,
      approvalPending: false,
      queuedInstruction: "run the focused tests",
      width: 80,
      color: false
    })).toMatchInlineSnapshot(`
      "draft › inspect▌
      queued › run the focused tests
      enter queue · ctrl+j newline · tab plan/build · / commands · @ files · ! shell"
    `);
  });

  it("renders exactly one fake cursor glyph in composer text", () => {
    process.env.SIGMA_FORCE_UNICODE = "1";
    delete process.env.SIGMA_ASCII;
    const state = createComposerState("fix tests");
    state.cursor = 3;

    const rendered = renderComposer({
      state,
      mode: "build",
      running: false,
      approvalPending: false,
      width: 80,
      color: false,
      compact: true
    });

    expect(rendered.match(/\u258c/g)?.length ?? 0).toBe(1);
    expect(rendered).toContain("fix\u258c tests");
  });
});

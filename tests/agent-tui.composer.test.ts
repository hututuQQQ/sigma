import { describe, expect, it } from "vitest";
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
});

export interface ComposerState {
  text: string;
  cursor: number;
  history: string[];
  historyIndex: number | null;
  yankBuffer?: string;
  historyDraft?: string;
}

export function createComposerState(initial = ""): ComposerState {
  return {
    text: initial,
    cursor: initial.length,
    history: [],
    historyIndex: null
  };
}

export function clampCursor(state: ComposerState): void {
  state.cursor = Math.min(Math.max(0, state.cursor), state.text.length);
}

export function resetHistoryCursor(state: ComposerState): void {
  state.historyIndex = null;
  state.historyDraft = undefined;
}

export function setComposerText(state: ComposerState, text: string, cursor = text.length): void {
  state.text = text;
  state.cursor = Math.min(Math.max(0, cursor), text.length);
  resetHistoryCursor(state);
}

export function clearComposer(state: ComposerState): void {
  setComposerText(state, "");
}

export function insertText(state: ComposerState, text: string): void {
  clampCursor(state);
  state.text = `${state.text.slice(0, state.cursor)}${text}${state.text.slice(state.cursor)}`;
  state.cursor += text.length;
  resetHistoryCursor(state);
}

export function deleteBackward(state: ComposerState): void {
  clampCursor(state);
  if (state.cursor === 0) return;
  state.text = `${state.text.slice(0, state.cursor - 1)}${state.text.slice(state.cursor)}`;
  state.cursor -= 1;
  resetHistoryCursor(state);
}

export function deleteForward(state: ComposerState): void {
  clampCursor(state);
  if (state.cursor >= state.text.length) return;
  state.text = `${state.text.slice(0, state.cursor)}${state.text.slice(state.cursor + 1)}`;
  resetHistoryCursor(state);
}

export function moveCursorLeft(state: ComposerState): void {
  state.cursor = Math.max(0, state.cursor - 1);
}

export function moveCursorRight(state: ComposerState): void {
  state.cursor = Math.min(state.text.length, state.cursor + 1);
}

function lineBoundsAt(text: string, cursor: number): { start: number; end: number; column: number } {
  const safeCursor = Math.min(Math.max(0, cursor), text.length);
  const start = text.lastIndexOf("\n", Math.max(0, safeCursor - 1)) + 1;
  const nextBreak = text.indexOf("\n", safeCursor);
  const end = nextBreak === -1 ? text.length : nextBreak;
  return {
    start,
    end,
    column: safeCursor - start
  };
}

export function moveCursorLineUp(state: ComposerState): boolean {
  clampCursor(state);
  const current = lineBoundsAt(state.text, state.cursor);
  if (current.start === 0) return false;
  const previousEnd = current.start - 1;
  const previousStart = state.text.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
  state.cursor = Math.min(previousStart + current.column, previousEnd);
  return true;
}

export function moveCursorLineDown(state: ComposerState): boolean {
  clampCursor(state);
  const current = lineBoundsAt(state.text, state.cursor);
  if (current.end >= state.text.length) return false;
  const nextStart = current.end + 1;
  const nextBreak = state.text.indexOf("\n", nextStart);
  const nextEnd = nextBreak === -1 ? state.text.length : nextBreak;
  state.cursor = Math.min(nextStart + current.column, nextEnd);
  return true;
}

export function moveCursorStart(state: ComposerState): void {
  state.cursor = 0;
}

export function moveCursorEnd(state: ComposerState): void {
  state.cursor = state.text.length;
}

export function killToStart(state: ComposerState): void {
  clampCursor(state);
  state.yankBuffer = state.text.slice(0, state.cursor);
  state.text = state.text.slice(state.cursor);
  state.cursor = 0;
  resetHistoryCursor(state);
}

export function killToEnd(state: ComposerState): void {
  clampCursor(state);
  state.yankBuffer = state.text.slice(state.cursor);
  state.text = state.text.slice(0, state.cursor);
  resetHistoryCursor(state);
}

export function deletePreviousWord(state: ComposerState): void {
  clampCursor(state);
  if (state.cursor === 0) return;
  let start = state.cursor;
  while (start > 0 && /\s/.test(state.text[start - 1] ?? "")) start -= 1;
  while (start > 0 && !/\s/.test(state.text[start - 1] ?? "")) start -= 1;
  state.yankBuffer = state.text.slice(start, state.cursor);
  state.text = `${state.text.slice(0, start)}${state.text.slice(state.cursor)}`;
  state.cursor = start;
  resetHistoryCursor(state);
}

export function yank(state: ComposerState): void {
  if (!state.yankBuffer) return;
  insertText(state, state.yankBuffer);
}

export function rememberInput(state: ComposerState, value: string): void {
  if (!value) return;
  if (state.history[state.history.length - 1] !== value) state.history.push(value);
  if (state.history.length > 100) state.history.shift();
  resetHistoryCursor(state);
}

export function recallHistory(state: ComposerState, direction: "up" | "down"): void {
  if (state.history.length === 0) return;
  if (state.historyIndex === null) {
    state.historyIndex = state.history.length;
    state.historyDraft = state.text;
  }
  state.historyIndex = direction === "up"
    ? Math.max(0, state.historyIndex - 1)
    : Math.min(state.history.length, state.historyIndex + 1);

  if (state.historyIndex === state.history.length) {
    state.text = state.historyDraft ?? "";
    state.cursor = state.text.length;
    resetHistoryCursor(state);
    return;
  }

  state.text = state.history[state.historyIndex] ?? "";
  state.cursor = state.text.length;
}

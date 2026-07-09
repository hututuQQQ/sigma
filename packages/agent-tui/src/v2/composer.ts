export interface ComposerState {
  graphemes: string[];
  cursor: number;
}

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((item) => item.segment);
}

export function createComposer(text = ""): ComposerState {
  const items = graphemes(text);
  return { graphemes: items, cursor: items.length };
}

export function composerText(state: ComposerState): string {
  return state.graphemes.join("");
}

export function insertText(state: ComposerState, text: string): ComposerState {
  const before = state.graphemes.slice(0, state.cursor).join("");
  const inserted = text.replace(/\r\n/g, "\n");
  const combined = graphemes(`${before}${inserted}${state.graphemes.slice(state.cursor).join("")}`);
  const target = before.length + inserted.length;
  let consumed = 0;
  let cursor = 0;
  while (cursor < combined.length && consumed < target) consumed += combined[cursor++].length;
  return { graphemes: combined, cursor };
}

export function backspace(state: ComposerState): ComposerState {
  if (state.cursor === 0) return state;
  return { graphemes: [...state.graphemes.slice(0, state.cursor - 1), ...state.graphemes.slice(state.cursor)], cursor: state.cursor - 1 };
}

export function moveCursor(state: ComposerState, delta: number): ComposerState {
  return { ...state, cursor: Math.max(0, Math.min(state.graphemes.length, state.cursor + delta)) };
}

export function clearComposer(): ComposerState {
  return { graphemes: [], cursor: 0 };
}

const wideRanges: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1b000, 0x1b2ff], [0x1f200, 0x1f251], [0x20000, 0x3fffd]
];

function fullWidth(codePoint: number): boolean {
  if (codePoint === 0x303f) return false;
  if (codePoint === 0x2329 || codePoint === 0x232a) return true;
  return wideRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function cellWidth(value: string): number {
  let width = 0;
  for (const item of graphemes(value)) {
    const codePoint = item.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) continue;
    if (/\p{Extended_Pictographic}/u.test(item) || /^\p{Regional_Indicator}{2}$/u.test(item)
      || item.includes("\u20e3") || (codePoint !== undefined && fullWidth(codePoint))) width += 2;
    else if (/^\p{Mark}+$/u.test(item)) continue;
    else width += 1;
  }
  return width;
}

export interface TextLine {
  number: number;
  text: string;
}

/** Iterates CR, LF, and CRLF text lines without inventing a trailing line. */
export function* textLines(content: string): Generator<TextLine> {
  let start = 0;
  let number = 1;
  while (start < content.length) {
    let end = start;
    while (end < content.length && content[end] !== "\r" && content[end] !== "\n") end += 1;
    yield { number, text: content.slice(start, end) };
    if (end >= content.length) return;
    if (content[end] === "\r" && content[end + 1] === "\n") end += 1;
    start = end + 1;
    number += 1;
  }
}

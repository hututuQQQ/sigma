const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function lexicalTokens(value: string, locale = "und"): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase(locale);
  const words: string[] = [];
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  for (const item of segmenter.segment(normalized)) {
    const token = item.segment.trim();
    if (item.isWordLike && token) words.push(token);
  }
  const cjkChars = [...normalized].filter((character) => cjk.test(character));
  for (let index = 0; index < cjkChars.length; index += 1) {
    words.push(cjkChars[index]);
    if (index + 1 < cjkChars.length) words.push(`${cjkChars[index]}${cjkChars[index + 1]}`);
  }
  return [...new Set(words)];
}

export function approximateTokens(value: string): number {
  const bytes = new TextEncoder().encode(value).length;
  const cjkCount = [...value].filter((character) => cjk.test(character)).length;
  return Math.max(1, Math.ceil((bytes - cjkCount * 2) / 4) + cjkCount);
}

export function lexicalScore(query: string, document: string): number {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.length === 0) return 0;
  const documentTokens = new Set(lexicalTokens(document));
  return queryTokens.reduce((score, token) => score + (documentTokens.has(token) ? 1 : 0), 0) / queryTokens.length;
}

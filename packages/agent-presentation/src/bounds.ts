export const maximumTranscriptCharacters = 512_000;
export const maximumActivityDetailCharacters = 64_000;

export function boundedPresentationText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "\n... [earlier presentation content omitted] ...\n";
  const available = Math.max(0, maximum - marker.length);
  const leading = Math.floor(available / 4);
  return `${value.slice(0, leading)}${marker}${value.slice(-(available - leading))}`;
}

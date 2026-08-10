const DEFAULT_MAX = 1_000;

/**
 * Split a reply into one message per paragraph, the way people text: each
 * blank-line-separated thought becomes its own bubble. Single line breaks
 * stay inside a bubble, so short structured lines (and anything the model
 * deliberately keeps together, like a drafted email) arrive as one message.
 * Paragraphs over the platform cap are further split at sentence, then space
 * boundaries.
 */
export function splitMessage(text: string, max = DEFAULT_MAX): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    chunks.push(...splitOversized(paragraph.trim(), max));
  }
  return chunks;
}

function splitOversized(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) {
    return paragraph ? [paragraph] : [];
  }
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut + 1 : max;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

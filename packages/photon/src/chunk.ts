const DEFAULT_MAX = 1_000;

/**
 * Split a long reply into iMessage-sized chunks, preferring paragraph
 * boundaries, then sentence/space boundaries for oversized paragraphs.
 */
export function splitMessage(text: string, max = DEFAULT_MAX): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed ? [trimmed] : [];
  }

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    for (const piece of splitOversized(paragraph.trim(), max)) {
      if (!current) {
        current = piece;
      } else if (current.length + piece.length + 2 <= max) {
        current = `${current}\n\n${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
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

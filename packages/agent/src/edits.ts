/**
 * Exact-match batch edit application (pi-style). Every oldText is matched
 * against the ORIGINAL content, must be unique, and must not overlap another
 * edit in the batch. No fuzzy matching: workspace files are agent-authored LF
 * markdown the model just read, so "re-read and copy exactly" is the fix.
 */
export interface FileEdit {
  oldText: string;
  newText: string;
}

export type EditOutcome = { ok: true; result: string } | { ok: false; error: string };

export function applyEdits(content: string, edits: FileEdit[]): EditOutcome {
  const label = (index: number): string =>
    edits.length > 1 ? `edit ${index + 1} of ${edits.length}: ` : "";

  const matches: Array<{ start: number; end: number; index: number }> = [];
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText === "") {
      return { ok: false, error: `Error: ${label(index)}oldText must not be empty.` };
    }
    const occurrences = findOccurrences(content, edit.oldText);
    if (occurrences.length === 0) {
      return {
        ok: false,
        error:
          `Error: ${label(index)}oldText not found in file. Read the file again and ` +
          `copy the text exactly, including whitespace.`,
      };
    }
    if (occurrences.length > 1) {
      return {
        ok: false,
        error:
          `Error: ${label(index)}oldText matches ${occurrences.length} locations in the ` +
          `file. Add surrounding lines to make it unique.`,
      };
    }
    matches.push({ start: occurrences[0]!, end: occurrences[0]! + edit.oldText.length, index });
  }

  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    if (ordered[i]!.end > ordered[i + 1]!.start) {
      const [a, b] = [ordered[i]!.index + 1, ordered[i + 1]!.index + 1].sort((x, y) => x - y);
      return {
        ok: false,
        error: `Error: edits ${a} and ${b} overlap. Merge them into one edit.`,
      };
    }
  }

  // Apply back-to-front so earlier offsets stay valid.
  let result = content;
  for (const match of [...ordered].reverse()) {
    result =
      result.slice(0, match.start) + edits[match.index]!.newText + result.slice(match.end);
  }

  if (result === content) {
    return { ok: false, error: "Error: the edits produce no change to the file." };
  }
  return { ok: true, result };
}

function findOccurrences(content: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (true) {
    const at = content.indexOf(needle, from);
    if (at === -1) break;
    found.push(at);
    from = at + needle.length;
    if (found.length > 1) break; // two is enough to fail uniqueness
  }
  return found;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = partsFormatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    partsFormatters.set(timeZone, cached);
  }
  return cached;
}

function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Epoch ms of the most recent local midnight in `timeZone` at instant `at`. */
export function startOfDayInZone(at: Date, timeZone: string): number {
  const offset = zoneOffsetMs(timeZone, at);
  const local = new Date(at.getTime() + offset);
  const wallMidnightAsUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const firstGuess = wallMidnightAsUtc - offset;
  return wallMidnightAsUtc - zoneOffsetMs(timeZone, new Date(firstGuess));
}

export function formatLocalTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(at);
}

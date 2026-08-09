import type { Logger } from "@nudge/agent";

const priorities = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof priorities;

export function createLogger(level: LogLevel): Logger {
  const threshold = priorities[level];
  const log = (
    entryLevel: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) => {
    if (priorities[entryLevel] < threshold) return;
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...context,
    });
    const output = entryLevel === "error" ? console.error : console.log;
    output(entry);
  };
  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
  };
}

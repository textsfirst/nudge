import type { Settings } from "./config.js";

export interface StartupIssue {
  message: string;
  action: string;
}

export function collectStartupIssues(
  environment: NodeJS.ProcessEnv,
  settings: Settings,
): StartupIssue[] {
  const issues: StartupIssue[] = [];
  if (!settings.owner_handle.trim()) {
    issues.push({
      message: "Owner handle is not configured.",
      action: "Open Console → Settings and set owner_handle to your iMessage handle.",
    });
  }
  for (const [key, label] of [
    ["SPECTRUM_PROJECT_ID", "Photon project ID"],
    ["SPECTRUM_PROJECT_SECRET", "Photon project secret"],
  ] as const) {
    if (!environment[key]?.trim()) {
      issues.push({
        message: `${label} is missing.`,
        action: `Open Console → Secrets and set ${key}.`,
      });
    }
  }
  if (settings.provider.selected === "openai-api" && !environment.OPENAI_API_KEY?.trim()) {
    issues.push({
      message: "The OpenAI API provider is selected, but OPENAI_API_KEY is missing.",
      action: "Open Console → Secrets and set OPENAI_API_KEY, or choose another provider in Settings.",
    });
  }
  if (
    settings.provider.selected === "custom" &&
    (!settings.provider.custom.base_url || !settings.provider.custom.model)
  ) {
    issues.push({
      message: "The custom provider is selected but its base URL or model is empty.",
      action: "Open Console → Settings → Provider and set both custom provider fields.",
    });
  }
  return issues;
}

export function formatStartupIssues(
  issues: StartupIssue[],
  consoleUrl = process.env.NUDGE_CONSOLE_URL || "http://localhost:5174",
): string {
  const list = issues
    .map((issue, index) => `${index + 1}. ${issue.message}\n   ${issue.action}`)
    .join("\n");
  return (
    `Nudge needs ${issues.length} setup ${issues.length === 1 ? "item" : "items"} before it can start:\n\n` +
    `${list}\n\nConsole: ${consoleUrl}\n` +
    "Start it with `pnpm console`, make the changes, then run Nudge again."
  );
}

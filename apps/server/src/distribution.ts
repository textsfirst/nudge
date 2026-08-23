/**
 * How this install was obtained — a packaged release archive (`bin/nudge …`)
 * or a source checkout (`pnpm …`) — and the user-facing commands that go with
 * each. Evaluated per call so launchers that set NUDGE_DISTRIBUTION after
 * module load are still seen.
 */

export interface DistributionCommands {
  /** Starts the console. */
  console: string;
  /** Shows or rotates the console access code. */
  auth: string;
  /** Runs the Nudge server. */
  run: string;
}

export function isReleaseDistribution(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.NUDGE_DISTRIBUTION === "release";
}

export function distributionCommands(
  environment: NodeJS.ProcessEnv = process.env,
): DistributionCommands {
  return isReleaseDistribution(environment)
    ? { console: "nudge console", auth: "nudge auth", run: "nudge run" }
    : { console: "pnpm console", auth: "pnpm console:auth", run: "pnpm dev" };
}

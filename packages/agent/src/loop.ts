import type {
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  StopCondition,
  ToolSet,
} from "ai";
import type { Logger } from "./types.js";

/** Fraction of the cap reserved as wind-down runway (1/16th, at least 3 calls). */
export const WIND_DOWN_FRACTION = 16;

/** Minimum model calls of runway the wind-down note guarantees. */
export const WIND_DOWN_MIN_STEPS = 3;

/** Runway grows with the cap: a bigger budget earns a longer wrap-up window. */
export function windDownSteps(maxToolSteps: number): number {
  return Math.max(WIND_DOWN_MIN_STEPS, Math.round(maxToolSteps / WIND_DOWN_FRACTION));
}

/** Tool steps with nothing texted to the owner before the silence nudge fires. */
export const PROGRESS_NUDGE_STEPS = 4;

/** No-progress repeats before the model is warned it looks stuck. */
export const STALL_WARN_STEPS = 3;

/** No-progress repeats before the loop is stopped. */
export const STALL_STOP_STEPS = 6;

export interface LoopGuard {
  prepareStep: PrepareStepFunction<ToolSet>;
  stopCondition: StopCondition<ToolSet>;
}

/**
 * Guards one tool loop. The step cap is a backstop against runaway loops, not
 * a task budget, so the guard's job is to keep honest long-horizon work
 * unbothered while catching the two real failure shapes:
 *
 * - Near the cap, a wind-down note tells the model how many calls remain so it
 *   can finish — or park its progress and report — instead of being cut off.
 * - A stall means no new information: the same tool calls returning the same
 *   results, repeatedly. Repetition alone is not a stall — polling a changing
 *   status or retrying to a different result varies the output and never
 *   trips this. A stalled model is warned first (it may be waiting on
 *   something and can say so, or vary the call); only a warned model that
 *   keeps extracting nothing gets stopped.
 *
 * When `progressTool` is set (the send_update tool is in the set), a turn that
 * runs several steps without texting the owner anything gets one nudge to send
 * a line — the model rarely re-considers the option mid-work on its own.
 *
 * Stateful (the warning fires once per streak), so create one guard per
 * streamText call.
 */
export function createLoopGuard(options: {
  maxToolSteps: number;
  logger: Logger;
  progressTool?: boolean;
}): LoopGuard {
  const windDownAt = options.maxToolSteps - windDownSteps(options.maxToolSteps);
  let warnedSignature: string | undefined;

  const prepareStep: PrepareStepFunction<ToolSet> = ({ stepNumber, messages, steps }) => {
    const notes: ModelMessage[] = [];
    if (options.progressTool && stepNumber === PROGRESS_NUDGE_STEPS && !textedOwner(steps)) {
      notes.push({
        role: "user",
        content:
          "[System note: several tool steps in and the owner has heard nothing yet. If " +
          "finishing takes more than another moment, use send_update now to text one short " +
          "line about what you're doing.]",
      });
    }
    if (windDownAt >= 1 && stepNumber === windDownAt) {
      notes.push({
        role: "user",
        content:
          `[System note: this turn has used ${stepNumber} of its ${options.maxToolSteps} tool ` +
          `steps; only ${options.maxToolSteps - stepNumber} model calls remain before the loop ` +
          "is stopped. Wrap up: finish the task if it is within reach, otherwise save your " +
          "progress (files, memory, or a scheduled follow-up) and reply with where things " +
          "stand and what remains.]",
      });
    }
    const stall = stalledStreak(steps);
    if (stall && stall.length >= STALL_WARN_STEPS && stall.signature !== warnedSignature) {
      warnedSignature = stall.signature;
      notes.push({
        role: "user",
        content:
          `[System note: your last ${stall.length} tool steps repeated the same calls and got ` +
          "identical results back — no new information. If that is deliberate (waiting on " +
          "something slow), vary the call, e.g. add a wait before retrying. If you keep " +
          `repeating it unchanged, the loop stops after ${STALL_STOP_STEPS} identical steps ` +
          "and you will be asked to report instead.]",
      });
    }
    return notes.length > 0 ? { messages: [...messages, ...notes] } : undefined;
  };

  const stopCondition: StopCondition<ToolSet> = ({ steps }) => {
    const stall = stalledStreak(steps);
    if (!stall || stall.length < STALL_STOP_STEPS) return false;
    options.logger.warn("Stopping the tool loop: repeated identical calls with identical results", {
      steps: steps.length,
      repeated:
        stall.signature.length > 200 ? `${stall.signature.slice(0, 200)}…` : stall.signature,
    });
    return true;
  };

  return { prepareStep, stopCondition };
}

/** Whether any step so far texted the owner via send_update. */
function textedOwner(steps: Array<StepResult<ToolSet>>): boolean {
  return steps.some((step) => step.toolCalls.some((call) => call.toolName === "send_update"));
}

/**
 * The trailing run of steps whose tool calls AND results are all identical.
 * Undefined when the last step made no tool calls or the streak is 1.
 */
function stalledStreak(
  steps: Array<StepResult<ToolSet>>,
): { length: number; signature: string } | undefined {
  const last = steps.at(-1);
  if (!last) return undefined;
  const signature = stepSignature(last);
  if (signature === undefined) return undefined;
  let length = 1;
  for (let index = steps.length - 2; index >= 0; index -= 1) {
    if (stepSignature(steps[index]!) !== signature) break;
    length += 1;
  }
  return length > 1 ? { length, signature } : undefined;
}

/** Calls plus their results: a step only matches when it learned nothing new. */
function stepSignature(step: StepResult<ToolSet>): string | undefined {
  if (step.toolCalls.length === 0) return undefined;
  return JSON.stringify(
    step.toolCalls.map((call, index) => [
      call.toolName,
      call.input,
      step.toolResults[index]?.output,
    ]),
  );
}

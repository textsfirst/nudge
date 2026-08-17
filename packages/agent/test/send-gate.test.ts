import { describe, expect, it } from "vitest";
import { makeAgent, textChunks, toolCallChunks } from "./helpers.js";
import { GWS_SEND_ENV } from "../src/index.js";

const HANDLE = "+15551234567";

/** A bash probe whose output tells us which env the tool set carried. */
const PROBE = toolCallChunks("bash", {
  command: `echo "send=\${${GWS_SEND_ENV}:-unset}"`,
});

function promptText(call: { prompt: unknown }): string {
  return JSON.stringify(call.prompt);
}

describe("gws send flag by turn type", () => {
  it("marks interaction turns as allowed to send", async () => {
    const { agent, source } = makeAgent([PROBE, textChunks("checked")]);
    await agent.reply(HANDLE, "check something for me");
    expect(promptText(source.calls[1]!)).toContain("send=1");
  });

  it("leaves scheduled runTask turns unflagged — no approval in a cold transcript", async () => {
    const { agent, source } = makeAgent([PROBE, textChunks("[SILENT]")]);
    await agent.runTask(HANDLE, "Morning rundown", "build the rundown");
    expect(promptText(source.calls[1]!)).toContain("send=unset");
  });

  it("leaves standing-agent execution turns unflagged", async () => {
    const { agent, source } = makeAgent([
      PROBE,
      textChunks("prepared a draft, id r-123"),
      textChunks("[SILENT]"),
    ]);
    agent.setReportDelivery(async () => undefined);
    await agent.runAgentTask(HANDLE, "Inbox watch (work)", "triage new mail", "email");
    expect(promptText(source.calls[1]!)).toContain("send=unset");
  });
});

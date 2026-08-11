import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { ModelSource } from "../src/index.js";
import { errorChunks, makeAgent, promptMessages, textChunks, toolCallChunks } from "./helpers.js";

const HANDLE = "+15551234567";

/**
 * Execution runs are fire-and-forget, so their model calls interleave with
 * the dispatching turn's in whatever order the microtask queue lands on. A
 * routed source answers by prompt content instead of call order, which keeps
 * these tests deterministic.
 */
class RoutedSource implements ModelSource {
  readonly id = "routed";
  /** Off-registry on purpose, so tests get the conservative default window. */
  readonly modelId = "scripted-test-model";
  readonly mock: MockLanguageModelV3;

  constructor(route: (lastMessage: string) => string | LanguageModelV3StreamPart[]) {
    this.mock = new MockLanguageModelV3({
      doStream: async (options) => {
        // Route on the newest message only: owner history accumulates old
        // report tags, so matching the whole prompt would misroute later turns.
        const resolved = route(JSON.stringify(options.prompt.at(-1)));
        return {
          stream: simulateReadableStream({
            chunks: typeof resolved === "string" ? textChunks(resolved) : resolved,
          }),
        };
      },
    });
  }

  get calls(): LanguageModelV3CallOptions[] {
    return this.mock.doStreamCalls;
  }

  languageModel() {
    return Promise.resolve(this.mock);
  }

  isAuthError() {
    return false;
  }
}

function makeDispatchAgent(route: (lastMessage: string) => string | LanguageModelV3StreamPart[]) {
  const routed = new RoutedSource(route);
  const harness = makeAgent([], { sources: [routed] });
  const delivered: string[] = [];
  harness.agent.setReportDelivery(async (_handle, text) => {
    delivered.push(text);
  });
  return { ...harness, routed, delivered };
}

const isReportTurn = (lastMessage: string) => lastMessage.includes("Report from background agent");
const isExecutionTurn = (lastMessage: string) => lastMessage.includes("[Task from the assistant]");

describe("dispatching execution agents", () => {
  it("runs a dispatched task in the background and delivers the curated report", async () => {
    let interactionStep = 0;
    const { agent, store, routed, delivered } = makeDispatchAgent((prompt) => {
      if (isReportTurn(prompt)) return "found your receipt — $420 from june 3";
      if (isExecutionTurn(prompt)) return "The airbnb receipt is $420, dated June 3.";
      interactionStep += 1;
      return interactionStep === 1
        ? toolCallChunks("dispatch_agent", {
            name: "find-receipt",
            brief: "find the airbnb receipt from june in the owner's email",
          })
        : "on it, digging for the receipt";
    });

    await expect(agent.reply(HANDLE, "find my airbnb receipt")).resolves.toBe(
      "on it, digging for the receipt",
    );
    await vi.waitFor(() => {
      expect(delivered).toEqual(["found your receipt — $420 from june 3"]);
    });

    // The temp agent ran in its own session and retired after its report.
    const agentRow = store
      .listSessions()
      .sessions.map((session) => session.agentId)
      .filter((id): id is number => id !== null)
      .map((id) => store.agentById(id)!)[0]!;
    expect(agentRow).toMatchObject({ name: "find-receipt", kind: "temp", status: "done" });
    expect(store.findAgentByName(HANDLE, "find-receipt")).toBeUndefined();

    const workerSession = store.activeAgentSession(agentRow.id)!;
    expect(
      store.sessionMessages(workerSession.id).map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "[Task from the assistant]\nfind the airbnb receipt from june in the owner's email"],
      ["assistant", "The airbnb receipt is $420, dated June 3."],
    ]);

    // The owner thread carries the tagged report and the curated reply.
    const ownerMessages = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .map((message) => [message.role, message.content] as const);
    expect(ownerMessages).toHaveLength(4);
    expect(ownerMessages[2]![0]).toBe("user");
    expect(ownerMessages[2]![1]).toContain('Report from background agent "find-receipt"');
    expect(ownerMessages[2]![1]).toContain("not a message from the owner");
    expect(ownerMessages[3]).toEqual(["assistant", "found your receipt — $420 from june 3"]);

    // The execution turn ran on the worker stack, not the texting persona.
    const executionCall = routed.calls.find((call) =>
      promptMessages(call).some((message) => message.text.includes("[Task from the assistant]")),
    )!;
    const executionSystem = promptMessages(executionCall).find(
      (message) => message.role === "system",
    )!;
    expect(executionSystem.text).toContain('You are "find-receipt"');
    expect(executionSystem.text).toContain("Execution agent");
    expect(executionSystem.text).not.toContain("## Delegation");

    // The interaction turn carried the delegation guidance.
    const interactionSystem = promptMessages(routed.calls[0]!).find(
      (message) => message.role === "system",
    )!;
    expect(interactionSystem.text).toContain("## Delegation");
  });

  it("drops a report the interaction agent answers with [SILENT]", async () => {
    let interactionStep = 0;
    const { agent, store, delivered } = makeDispatchAgent((prompt) => {
      if (isReportTurn(prompt)) return "[SILENT]";
      if (isExecutionTurn(prompt)) return "Checked the inbox: nothing urgent.";
      interactionStep += 1;
      return interactionStep === 1
        ? toolCallChunks("dispatch_agent", { name: "inbox-sweep", brief: "triage the inbox" })
        : "on it";
    });

    await agent.reply(HANDLE, "anything urgent in email?");
    await vi.waitFor(() => {
      expect(store.sessionMessages(store.activeSession(HANDLE)!.id)).toHaveLength(4);
    });

    expect(delivered).toEqual([]);
    const last = store.sessionMessages(store.activeSession(HANDLE)!.id).at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("[SILENT]");
  });

  it("reuses a standing agent by name and shows it in the roster", async () => {
    let interactionStep = 0;
    let executionStep = 0;
    const { agent, store, routed } = makeDispatchAgent((prompt) => {
      if (isReportTurn(prompt)) return "[SILENT]";
      if (isExecutionTurn(prompt)) {
        executionStep += 1;
        return executionStep === 1 ? "Inbox triaged: nothing urgent." : "Still nothing new.";
      }
      interactionStep += 1;
      switch (interactionStep) {
        case 1:
          return toolCallChunks("dispatch_agent", {
            name: "email",
            mode: "standing",
            description: "owner's gmail — triage and follow-ups",
            brief: "triage the inbox",
          });
        case 2:
          return "on it";
        case 3:
          return toolCallChunks("dispatch_agent", { name: "email", brief: "check again" });
        default:
          return "checking again";
      }
    });

    await agent.reply(HANDLE, "triage my email");
    await vi.waitFor(() => {
      expect(store.sessionMessages(store.activeSession(HANDLE)!.id)).toHaveLength(4);
    });
    const standing = store.findAgentByName(HANDLE, "email")!;
    expect(standing).toMatchObject({ kind: "standing", status: "active" });

    await agent.reply(HANDLE, "check email again");
    await vi.waitFor(() => {
      expect(store.sessionMessages(store.activeSession(HANDLE)!.id)).toHaveLength(8);
    });

    // Same agent, one session, both tasks in its permanent memory.
    expect(store.findAgentByName(HANDLE, "email")!.id).toBe(standing.id);
    const workerMessages = store
      .sessionMessages(store.activeAgentSession(standing.id)!.id)
      .map((message) => message.content);
    expect(workerMessages).toEqual([
      "[Task from the assistant]\ntriage the inbox",
      "Inbox triaged: nothing urgent.",
      "[Task from the assistant]\ncheck again",
      "Still nothing new.",
    ]);

    // The second owner turn saw the standing agent in its roster.
    const rosterCall = routed.calls.find((call) =>
      promptMessages(call).some(
        (message) =>
          message.role === "system" && message.text.includes("## Your agents"),
      ),
    )!;
    const system = promptMessages(rosterCall).find((message) => message.role === "system")!;
    expect(system.text).toContain("- email (standing");
    expect(system.text).toContain("owner's gmail — triage and follow-ups");
  });

  it("queues a second brief behind a busy agent instead of rejecting it", async () => {
    let interactionStep = 0;
    let executionStep = 0;
    const { agent, store } = makeDispatchAgent((prompt) => {
      if (isReportTurn(prompt)) return "[SILENT]";
      if (isExecutionTurn(prompt)) {
        executionStep += 1;
        return executionStep === 1 ? "First task done." : "Second task done.";
      }
      interactionStep += 1;
      switch (interactionStep) {
        case 1:
          return toolCallChunks("dispatch_agent", { name: "errands", brief: "first task" });
        case 2:
          return toolCallChunks("dispatch_agent", { name: "errands", brief: "second task" });
        default:
          return "both moving";
      }
    });

    await expect(agent.reply(HANDLE, "two things please")).resolves.toBe("both moving");
    // Two reports → two silent report turns on the owner thread.
    await vi.waitFor(() => {
      expect(store.sessionMessages(store.activeSession(HANDLE)!.id)).toHaveLength(6);
    });

    const turn = store
      .sessionMessages(store.activeSession(HANDLE)!.id)
      .find((message) => message.role === "assistant" && message.toolPayload)!;
    const outputs = (JSON.parse(turn.toolPayload!) as { output: string }[]).map(
      (call) => call.output,
    );
    expect(outputs[0]).toContain("dispatched: created temp agent");
    expect(outputs[1]).toContain("queued:");

    // Per-agent serialization ran the briefs in order in one session.
    const agentId = store
      .listSessions()
      .sessions.find((session) => session.agentId !== null)!.agentId!;
    const workerMessages = store
      .sessionMessages(store.activeAgentSession(agentId)!.id)
      .map((message) => message.content);
    expect(workerMessages).toEqual([
      "[Task from the assistant]\nfirst task",
      "First task done.",
      "[Task from the assistant]\nsecond task",
      "Second task done.",
    ]);
  });

  it("runs scheduled tasks through a standing agent that keeps memory across firings", async () => {
    let executionStep = 0;
    const { agent, store, delivered } = makeDispatchAgent((lastMessage) => {
      if (isReportTurn(lastMessage)) return "your inbox has one urgent thing — the visa email";
      if (lastMessage.includes("[Scheduled task")) {
        executionStep += 1;
        return executionStep === 1 ? "Swept the inbox: one urgent visa email." : "Nothing new.";
      }
      return "unexpected";
    });

    await agent.runAgentTask(HANDLE, "Inbox sweep", "Check for urgent mail.", "email");
    await vi.waitFor(() => {
      expect(delivered).toEqual(["your inbox has one urgent thing — the visa email"]);
    });

    const standing = store.findAgentByName(HANDLE, "email")!;
    expect(standing).toMatchObject({ kind: "standing", status: "active" });
    expect(standing.description).toContain('scheduled task "Inbox sweep"');

    // The second firing lands in the same session — memory across firings.
    await agent.runAgentTask(HANDLE, "Inbox sweep", "Check for urgent mail.", "email");
    const workerMessages = store
      .sessionMessages(store.activeAgentSession(standing.id)!.id)
      .map((message) => message.content);
    expect(workerMessages).toHaveLength(4);
    expect(workerMessages[0]).toContain('[Scheduled task "Inbox sweep" is firing now.');
    expect(workerMessages[2]).toContain("your earlier runs are the turns above");
    expect(store.findAgentByName(HANDLE, "email")!.id).toBe(standing.id);
  });

  it("never binds a scheduled task to a temp agent", async () => {
    const { agent, store } = makeDispatchAgent((lastMessage) => {
      if (isReportTurn(lastMessage)) return "[SILENT]";
      if (lastMessage.includes("[Scheduled task")) return "Done.";
      return "unexpected";
    });
    store.createAgent({ handle: HANDLE, name: "sweep", kind: "temp", description: "one-off", at: 1_000 });

    await agent.runAgentTask(HANDLE, "Sweep", "Do the sweep.", "sweep");

    const match = store.findAgentByName(HANDLE, "sweep")!;
    expect(match.kind).toBe("standing");
  });

  it("reports an execution failure instead of losing it", async () => {
    let interactionStep = 0;
    const { agent, delivered } = makeDispatchAgent((prompt) => {
      if (isReportTurn(prompt)) {
        return prompt.includes("The background task failed")
          ? "hit a snag with that — i'll retry in a bit"
          : "unexpected";
      }
      if (isExecutionTurn(prompt)) return errorChunks(new Error("boom"));
      interactionStep += 1;
      return interactionStep === 1
        ? toolCallChunks("dispatch_agent", { name: "doomed", brief: "try the thing" })
        : "on it";
    });

    await agent.reply(HANDLE, "do the thing");
    await vi.waitFor(() => {
      expect(delivered).toEqual(["hit a snag with that — i'll retry in a bit"]);
    });
  });
});

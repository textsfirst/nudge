import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NudgeStore } from "@nudge/store";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp, type ConsoleApp } from "../src/server/app.js";
import { json, secureTestOptions } from "./auth-helper.js";

let root: string | undefined;

function makeWorkspace(options: { env?: string } = {}): string {
  root = mkdtempSync(join(tmpdir(), "console-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  // PORT steers the status probe away from 3000, where a real dev server may be listening.
  writeFileSync(
    join(root, ".env"),
    `NUDGE_DATA_DIR=.data\nPORT=59983\n${options.env ?? "SPECTRUM_PROJECT_ID=p1\n# a comment\n"}`,
  );
  mkdirSync(join(root, ".data", "skills", "demo"), { recursive: true });
  writeFileSync(join(root, ".data", "SYSTEM.md"), "Be helpful.");
  writeFileSync(join(root, ".data", "README.md"), "system manual");
  writeFileSync(join(root, ".data", "SCHEDULE.md"), "## Ping\nwhen: every day at 7:30\nSay hi.\n");
  writeFileSync(
    join(root, ".data", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo\n---\nBody.\n",
  );
  writeFileSync(join(root, ".data", "chatgpt-auth.json"), "{}");
  writeFileSync(join(root, ".data", "console-auth.json"), '{"capability":"secret"}');
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function app(): ConsoleApp {
  return createConsoleApp({ root: makeWorkspace(), ...secureTestOptions });
}

describe("console API", () => {
  it("serves agent visibility: roster stats, activity feed, costs, schedule state", async () => {
    const application = app();
    const store = new NudgeStore(join(root!, ".data", "nudge.db"));
    const owner = "+15550001111";
    const agent = store.createAgent({
      handle: owner,
      name: "email",
      kind: "standing",
      description: "owner's gmail",
      at: 1_000,
    });
    const worker = store.startSession(owner, 1_000, undefined, agent.id);
    store.appendMessage({
      sessionId: worker.id,
      handle: owner,
      role: "user",
      content: "[Task from the assistant]\ntriage the inbox",
      at: 1_000,
    });
    store.appendMessage({
      sessionId: worker.id,
      handle: owner,
      role: "assistant",
      content: "Nothing urgent.",
      inputTokens: 500,
      outputTokens: 60,
      at: 2_000,
    });
    const thread = store.startSession(owner, 3_000);
    store.appendMessage({
      sessionId: thread.id,
      handle: owner,
      role: "user",
      content: '[Report from background agent "email". Not owner input.]\nNothing urgent.',
      at: 3_000,
    });
    store.appendMessage({
      sessionId: thread.id,
      handle: owner,
      role: "assistant",
      content: "[SILENT]",
      inputTokens: 200,
      outputTokens: 5,
      at: Date.now(),
    });
    store.recordScheduleCheck("ping-1", { hash: "aaa" }, 4_000);
    store.recordScheduleCheck("ping-1", { hash: "bbb", changed: true, woke: true }, 5_000);
    store.close();

    const agents = await json(application, "/api/agents");
    expect(agents.status).toBe(200);
    expect(agents.body.agents).toHaveLength(1);
    expect(agents.body.agents[0]).toMatchObject({
      name: "email",
      kind: "standing",
      sessionId: worker.id,
      messageCount: 2,
      inputTokens: 500,
      outputTokens: 60,
    });

    const activity = await json(application, "/api/activity");
    expect(activity.status).toBe(200);
    const types = activity.body.events.map((event: { type: string }) => event.type);
    expect(types).toContain("dispatch");
    expect(types).toContain("report");
    const report = activity.body.events.find((event: { type: string }) => event.type === "report");
    expect(report).toMatchObject({ agentName: "email", outcome: "silent" });
    expect(report.text).toBe("Nothing urgent.");
    const dispatch = activity.body.events.find(
      (event: { type: string }) => event.type === "dispatch",
    );
    expect(dispatch).toMatchObject({ agentName: "email", scheduled: false, text: "triage the inbox" });

    const costs = await json(application, "/api/costs?days=90");
    expect(costs.status).toBe(200);
    expect(costs.body.watcher).toEqual({ checksRun: 2, wakes: 1, avoided: 1 });
    const kinds = costs.body.usage.map((row: { kind: string }) => row.kind);
    expect(kinds).toContain("report");

    const state = await json(application, "/api/schedule/state");
    expect(state.status).toBe(200);
    expect(state.body.states).toHaveLength(1);
    expect(state.body.states[0]).toMatchObject({ entryId: "ping-1", checksRun: 2, wakes: 1 });
  });

  it("reports status from the workspace, flagging the unset owner handle", async () => {
    const application = app();
    const before = await json(application, "/api/status");
    expect(before.status).toBe(200);
    expect(before.body.settingsValid).toBe(false);
    expect(before.body.ownerHandle).toBeNull();
    expect(before.body.serverUp).toBe(false);
    expect(before.body.serverError).toContain("owner_handle is not set");

    await json(application, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: { owner_handle: "+15551234567" } }),
    });
    const after = await json(application, "/api/status");
    expect(after.body.settingsValid).toBe(true);
    expect(after.body.ownerHandle).toBe("+15551234567");
    expect(after.body.serverError).toContain("Missing required secrets");
  });

  it("round-trips typed settings, storing only non-default overrides", async () => {
    const application = app();
    const before = await json(application, "/api/settings");
    expect(before.status).toBe(200);
    expect(before.body.settings.owner_handle).toBe("");
    expect(before.body.overrides).toEqual({});
    expect(before.body.form.length).toBeGreaterThan(0);

    const invalid = await json(application, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: { threads: { idle_hours: 999 } } }),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.issues).toEqual([
      { path: "threads.idle_hours", message: expect.stringContaining("168") },
    ]);
    // The broken write must not land in the database.
    expect((await json(application, "/api/settings")).body.overrides).toEqual({});

    const valid = await json(application, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        settings: { owner_handle: "+15551234567", threads: { idle_hours: 2 } },
      }),
    });
    expect(valid.status).toBe(200);
    const after = await json(application, "/api/settings");
    expect(after.body.settings.threads.idle_hours).toBe(2);
    expect(after.body.overrides).toEqual({
      owner_handle: "+15551234567",
      "threads.idle_hours": 2,
    });
  });

  it("lists secrets without values and edits .env preserving comments", async () => {
    const application = app();
    const list = await json(application, "/api/secrets");
    expect(list.body.secrets.find((s: any) => s.key === "SPECTRUM_PROJECT_ID").set).toBe(true);
    expect(list.body.secrets.find((s: any) => s.key === "FIRECRAWL_API_KEY").set).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain("p1");

    const set = await json(application, "/api/secrets/FIRECRAWL_API_KEY", {
      method: "PUT",
      body: JSON.stringify({ value: "fc-123" }),
    });
    expect(set.status).toBe(200);
    const env = readFileSync(join(root!, ".env"), "utf8");
    expect(env).toContain("# a comment");
    expect(env).toContain("FIRECRAWL_API_KEY=fc-123");

    const removed = await json(application, "/api/secrets/FIRECRAWL_API_KEY", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(readFileSync(join(root!, ".env"), "utf8")).not.toContain("FIRECRAWL_API_KEY");
  });

  it("serves data files but hides secrets and runtime state", async () => {
    const application = app();
    const { body } = await json(application, "/api/files");
    const paths = body.files.map((file: any) => file.path);
    expect(paths).toContain("SYSTEM.md");
    expect(paths).toContain("skills/demo/SKILL.md");
    expect(paths).not.toContain("chatgpt-auth.json");
    expect(paths).not.toContain("console-auth.json");

    const hidden = await json(application, "/api/files/content?path=chatgpt-auth.json");
    expect(hidden.status).toBe(403);
    expect((await json(application, "/api/files/content?path=console-auth.json")).status).toBe(403);
    const outside = await json(application, "/api/files/content?path=../.env");
    expect(outside.status).toBe(400);
  });

  it("lets the owner edit SYSTEM.md but not the system-written README", async () => {
    const application = app();
    // Overwriting an existing file without the hash it was read at is refused —
    // a console save must never blindly clobber a concurrent agent write.
    const blind = await json(application, "/api/files/content", {
      method: "PUT",
      body: JSON.stringify({ path: "SYSTEM.md", content: "Be bolder." }),
    });
    expect(blind.status).toBe(428);

    const read = await json(application, "/api/files/content?path=SYSTEM.md", { method: "GET" });
    const write = await json(application, "/api/files/content", {
      method: "PUT",
      body: JSON.stringify({ path: "SYSTEM.md", content: "Be bolder.", hash: read.body.hash }),
    });
    expect(write.status).toBe(200);
    expect(readFileSync(join(root!, ".data", "SYSTEM.md"), "utf8")).toBe("Be bolder.");

    const readme = await json(application, "/api/files/content", {
      method: "PUT",
      body: JSON.stringify({ path: "README.md", content: "nope" }),
    });
    expect(readme.status).toBe(403);
  });

  it("applies the agent's validators to owner writes", async () => {
    const application = app();
    const schedule = await json(application, "/api/files/content?path=SCHEDULE.md", {
      method: "GET",
    });
    const badSchedule = await json(application, "/api/files/content", {
      method: "PUT",
      body: JSON.stringify({
        path: "SCHEDULE.md",
        content: "## Broken\nwhen: whenever\nHi.\n",
        hash: schedule.body.hash,
      }),
    });
    expect(badSchedule.status).toBe(422);
    expect(badSchedule.body.error).toContain("SCHEDULE.md");

    const oversized = await json(application, "/api/files/content", {
      method: "PUT",
      body: JSON.stringify({ path: "MEMORY.md", content: "x".repeat(3000) }),
    });
    expect(oversized.status).toBe(422);
    expect(oversized.body.error).toContain("2200");
  });

  it("deletes skills and prunes their empty directories", async () => {
    const application = app();
    const removed = await json(
      application,
      "/api/files/content?path=skills/demo/SKILL.md",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(existsSync(join(root!, ".data", "skills", "demo"))).toBe(false);
  });

  it("previews schedules with next-run times and errors", async () => {
    const preview = await json(app(), "/api/schedule/preview", {
      method: "POST",
      body: JSON.stringify({
        content: "## Ping\nwhen: every day at 7:30\nSay hi.\n\n## Broken\nwhen: whenever\nX.\n",
      }),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.entries).toHaveLength(1);
    expect(preview.body.entries[0].nextRun).toBeTruthy();
    expect(preview.body.errors.length).toBeGreaterThan(0);
  });

  it("manages threads: list, detail, end, delete", async () => {
    const application = app();
    const store = new NudgeStore(join(root!, ".data", "nudge.db"));
    const session = store.startSession("+15551234567", 1_000);
    const message = store.appendMessage({
      sessionId: session.id,
      handle: "+15551234567",
      role: "user",
      content: "hello there",
    });
    store.appendMessage({
      sessionId: session.id,
      handle: "+15551234567",
      role: "assistant",
      content: "hi!",
      inputTokens: 1_234,
      outputTokens: 56,
      metrics: JSON.stringify({
        ttftMs: 420,
        modelMs: 900,
        modelId: "gpt-5-mini",
        cacheReadTokens: 1000,
        stepTimings: [
          {
            step: 1,
            modelId: "gpt-5-mini",
            finishReason: "stop",
            durationMs: 950,
            modelMs: 900,
            ttftMs: 420,
          },
        ],
      }),
    });
    store.appendMessage({
      sessionId: session.id,
      handle: "+15551234567",
      role: "assistant",
      content: "again",
      metrics: "not json",
    });
    store.setTurnProgress(
      session.id,
      "+15551234567",
      JSON.stringify([{ tool: "bash", input: { command: "ls" }, output: "ok" }]),
    );
    store.close();

    const list = await json(application, "/api/threads");
    expect(list.body.total).toBe(1);
    expect(list.body.sessions[0].messageCount).toBe(3);

    const detail = await json(application, `/api/threads/${session.id}`);
    expect(detail.body.messages[0].content).toBe("hello there");
    expect(detail.body.messages[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      metrics: null,
    });
    expect(detail.body.messages[1]).toMatchObject({ inputTokens: 1_234, outputTokens: 56 });
    expect(detail.body.messages[1].metrics).toEqual({
      ttftMs: 420,
      modelMs: 900,
      modelId: "gpt-5-mini",
      cacheReadTokens: 1000,
      stepTimings: [
        {
          step: 1,
          modelId: "gpt-5-mini",
          finishReason: "stop",
          durationMs: 950,
          modelMs: 900,
          ttftMs: 420,
        },
      ],
    });
    // Malformed metrics JSON degrades to null instead of breaking the page.
    expect(detail.body.messages[2].metrics).toBeNull();
    expect(detail.body.progress.toolCalls).toEqual([
      { tool: "bash", input: { command: "ls" }, output: "ok" },
    ]);

    const search = await json(application, "/api/search?q=hello");
    expect(search.body.hits).toHaveLength(1);

    const ended = await json(application, `/api/threads/${session.id}/end`, { method: "POST" });
    expect(ended.status).toBe(200);
    // Ending the session drops any leftover progress trace.
    const endedDetail = await json(application, `/api/threads/${session.id}`);
    expect(endedDetail.body.progress).toBeNull();
    const endedAgain = await json(application, `/api/threads/${session.id}/end`, { method: "POST" });
    expect(endedAgain.status).toBe(409);

    const dropMessage = await json(
      application,
      `/api/threads/${session.id}/messages/${message.id}`,
      { method: "DELETE" },
    );
    expect(dropMessage.status).toBe(200);

    const dropThread = await json(application, `/api/threads/${session.id}`, { method: "DELETE" });
    expect(dropThread.status).toBe(200);
    expect((await json(application, "/api/threads")).body.total).toBe(0);
  });

});

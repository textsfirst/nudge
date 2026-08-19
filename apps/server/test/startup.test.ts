import { describe, expect, it } from "vitest";
import { settingsFromOverrides } from "../src/config.js";
import { collectStartupIssues, formatStartupIssues } from "../src/startup.js";

const READY_ENV = {
  SPECTRUM_PROJECT_ID: "project",
  SPECTRUM_PROJECT_SECRET: "secret",
};

describe("Nudge startup preflight", () => {
  it("collects first-run setup problems into one actionable report", () => {
    const issues = collectStartupIssues({}, settingsFromOverrides({}));
    expect(issues.map((issue) => issue.message)).toEqual([
      "Owner handle is not configured.",
      "Photon project ID is missing.",
      "Photon project secret is missing.",
    ]);
    const message = formatStartupIssues(issues, "http://localhost:5174");
    expect(message).toContain("3 setup items");
    expect(message).toContain("Console → Settings");
    expect(message).toContain("Console → Secrets");
    expect(message).toContain("pnpm console");
  });

  it("passes a configured subscription setup", () => {
    const settings = settingsFromOverrides({ owner_handle: "+15551234567" });
    expect(collectStartupIssues(READY_ENV, settings)).toEqual([]);
  });

  it("checks provider-specific requirements", () => {
    const openai = settingsFromOverrides({
      owner_handle: "+15551234567",
      "provider.selected": "openai-api",
    });
    expect(collectStartupIssues(READY_ENV, openai)[0]?.message).toContain("OPENAI_API_KEY");

    const custom = settingsFromOverrides({
      owner_handle: "+15551234567",
      "provider.selected": "custom",
    });
    expect(collectStartupIssues(READY_ENV, custom)[0]?.message).toContain("custom provider");
  });
});

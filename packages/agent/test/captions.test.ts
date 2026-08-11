import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { buildImageCaptioner } from "../src/captions.js";
import type { ModelSource } from "../src/types.js";
import { quietLogger } from "./helpers.js";

function captionSource(text: string): {
  source: ModelSource;
  calls: LanguageModelV3CallOptions[];
  modelRequests: (string | undefined)[];
} {
  const calls: LanguageModelV3CallOptions[] = [];
  const modelRequests: (string | undefined)[] = [];
  const mock = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    source: {
      id: "caption-test",
      modelId: "gpt-5-mini",
      languageModel: (modelOverride?: string) => {
        modelRequests.push(modelOverride);
        return Promise.resolve(mock);
      },
      isAuthError: () => false,
    },
    calls,
    modelRequests,
  };
}

describe("buildImageCaptioner", () => {
  it("sends the image as a file part and returns the trimmed description", async () => {
    const { source, calls } = captionSource("  A receipt from a hardware store.\n");
    const caption = buildImageCaptioner({ sources: [source], logger: quietLogger });

    await expect(caption(Buffer.from("jpeg"), "image/jpeg")).resolves.toBe(
      "A receipt from a hardware store.",
    );
    const prompt = calls[0]!.prompt;
    const user = prompt.find((message) => message.role === "user")!;
    const parts = user.content as Array<{ type: string; mediaType?: string }>;
    expect(parts.some((part) => part.type === "file" && part.mediaType === "image/jpeg")).toBe(
      true,
    );
  });

  it("asks for the configured caption model override", async () => {
    const { source, modelRequests } = captionSource("A dog.");
    const caption = buildImageCaptioner({
      sources: [source],
      model: "gpt-5-mini",
      logger: quietLogger,
    });
    await caption(Buffer.from("jpeg"), "image/jpeg");
    expect(modelRequests).toEqual(["gpt-5-mini"]);
  });

  it("throws on an empty description so ingest can degrade to a bare name", async () => {
    const { source } = captionSource("   ");
    const caption = buildImageCaptioner({ sources: [source], logger: quietLogger });
    await expect(caption(Buffer.from("jpeg"), "image/jpeg")).rejects.toThrow(/empty/);
  });
});

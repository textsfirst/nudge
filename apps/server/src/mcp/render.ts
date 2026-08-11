import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "@nudge/agent";

/**
 * Pure formatters for the mcp CLI, one per disclosure level: `ls` names
 * servers, `tools` names tools, `schema` spells out one tool's arguments.
 * Nothing here truncates — the bash tool's cap-and-spill applies downstream.
 */

export function renderServerList(config: McpConfig): string {
  const entries = Object.entries(config.servers);
  if (entries.length === 0) return "No MCP servers in mcp/servers.json yet.";
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries
    .map(([name, server]) => {
      const target =
        server.transport === "http" ? server.url : [server.command, ...server.args].join(" ");
      const disabled = server.enabled ? "" : "   (disabled)";
      return `${name.padEnd(width)}   ${server.transport.padEnd(5)}   ${target}${disabled}`;
    })
    .join("\n");
}

export function renderToolList(server: string, tools: Tool[]): string {
  if (tools.length === 0) return `${server}: no tools.`;
  const lines = tools.map((tool) => `  ${tool.name} — ${firstSentence(tool.description)}`);
  return [
    `${server}: ${tools.length === 1 ? "1 tool" : `${tools.length} tools`}`,
    ...lines,
    `[Use \`mcp schema ${server} <tool>\` for arguments, then \`mcp call ${server} <tool> '<json>'\`.]`,
  ].join("\n");
}

export function renderToolSchema(server: string, tool: Tool): string {
  const lines = [`${tool.name} — ${(tool.description ?? "(no description)").trim()}`];
  const properties = asRecord(tool.inputSchema.properties);
  const required = new Set(
    Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [],
  );
  if (properties && Object.keys(properties).length > 0) {
    lines.push("Arguments:");
    const width = Math.max(...Object.keys(properties).map((name) => name.length));
    for (const [name, schema] of Object.entries(properties)) {
      const meta = asRecord(schema) ?? {};
      const type = `${typeLabel(meta)}${required.has(name) ? ", required" : ""}`;
      const description =
        typeof meta.description === "string" ? ` — ${firstSentence(meta.description)}` : "";
      lines.push(`  ${name.padEnd(width)}   ${type}${description}`);
    }
  } else if (properties || !hasOpenShape(tool.inputSchema)) {
    // No properties on a plain object schema (some servers omit the key
    // entirely for no-arg tools) — nothing to pass.
    lines.push("Arguments: none.");
  } else {
    // A shape this renderer cannot flatten — show the schema as the server sent it.
    lines.push("Input schema:", JSON.stringify(tool.inputSchema, null, 2));
  }
  lines.push(`Call: mcp call ${server} ${tool.name} '${callSkeleton(properties, required)}'`);
  return lines.join("\n");
}

/**
 * Text blocks verbatim; structured content as JSON only when there is no
 * text; binary blocks become a placeholder naming the file they were saved
 * to (inline base64 is a token bomb — same posture as web.ts).
 */
export function renderCallResult(
  result: CallToolResult,
  saveBinary: (base64: string, mimeType: string) => string,
): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image" || block.type === "audio") {
      parts.push(binaryPlaceholder(block.type, block.data, block.mimeType, saveBinary));
    } else if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource && typeof resource.text === "string") {
        parts.push(resource.text);
      } else if ("blob" in resource && typeof resource.blob === "string") {
        parts.push(
          binaryPlaceholder("resource", resource.blob, resource.mimeType ?? "unknown", saveBinary),
        );
      }
    } else if (block.type === "resource_link") {
      parts.push(`[resource: ${block.uri}${block.description ? ` — ${block.description}` : ""}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n") || "(empty result)";
}

export function renderResourceList(server: string, resources: Resource[]): string {
  if (resources.length === 0) return `${server}: no resources.`;
  const lines = resources.map((resource) => {
    const label = resource.name ? `${resource.name} — ` : "";
    return `  ${resource.uri}   ${label}${firstSentence(resource.description)}`;
  });
  return [
    `${server}: ${resources.length === 1 ? "1 resource" : `${resources.length} resources`}`,
    ...lines,
    `[Read one with \`mcp read ${server} <uri>\`.]`,
  ].join("\n");
}

export function renderResourceContents(
  result: ReadResourceResult,
  saveBinary: (base64: string, mimeType: string) => string,
): string {
  const parts = result.contents.map((entry) => {
    if ("text" in entry && typeof entry.text === "string") return entry.text;
    if ("blob" in entry && typeof entry.blob === "string") {
      return binaryPlaceholder("resource", entry.blob, entry.mimeType ?? "unknown", saveBinary);
    }
    return `[${entry.uri}: no content]`;
  });
  return parts.join("\n") || "(empty resource)";
}

// -- helpers ----------------------------------------------------------------

function firstSentence(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) return "(no description)";
  const line = text.trim().split("\n")[0]!;
  const sentence = /^(.*?[.!?])\s/.exec(line)?.[1] ?? line;
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence;
}

function typeLabel(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) {
    return `one of: ${schema.enum.map((value) => JSON.stringify(value)).join(" | ")}`;
  }
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "array") {
    const items = asRecord(schema.items);
    return items ? `array of ${typeLabel(items)}` : "array";
  }
  return type ?? "any";
}

/** Composed or free-form schemas the argument renderer cannot flatten. */
function hasOpenShape(schema: Record<string, unknown>): boolean {
  if (["anyOf", "oneOf", "allOf", "$ref", "patternProperties"].some((key) => key in schema)) {
    return true;
  }
  return schema.additionalProperties !== undefined && schema.additionalProperties !== false;
}

function callSkeleton(
  properties: Record<string, unknown> | undefined,
  required: Set<string>,
): string {
  const skeleton: Record<string, unknown> = {};
  for (const name of Object.keys(properties ?? {})) {
    if (!required.has(name)) continue;
    const meta = asRecord(properties?.[name]) ?? {};
    skeleton[name] =
      meta.type === "number" || meta.type === "integer"
        ? 0
        : meta.type === "boolean"
          ? true
          : meta.type === "array"
            ? []
            : meta.type === "object"
              ? {}
              : "…";
  }
  return JSON.stringify(skeleton);
}

function binaryPlaceholder(
  kind: string,
  base64: string,
  mimeType: string,
  saveBinary: (base64: string, mimeType: string) => string,
): string {
  const kb = Math.max(1, Math.round((base64.length * 3) / 4 / 1024));
  return `[${kind} (${mimeType}, ${kb}KB) saved to ${saveBinary(base64, mimeType)}]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

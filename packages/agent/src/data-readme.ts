import { readBundledFile } from "./content.js";

/**
 * DATA_DIR/README.md — the agent's on-demand manual (content/DATA-README.md).
 * The server writes it at boot; the workspace marks it read-only to the agent.
 * Keeping formats here instead of the system prompt means they cost tokens
 * only when consulted.
 */
export const DATA_README = readBundledFile("DATA-README.md");

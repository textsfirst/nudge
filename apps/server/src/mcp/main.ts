import process from "node:process";
import { runMcpCli } from "./cli.js";

// The bin/mcp launcher's entry point. process.exit, not exitCode: a stdio
// server's child process must not keep the CLI alive after the verdict.
const code = await runMcpCli(process.argv.slice(2), process.env, process.stdout, process.stderr);
process.exit(code);

import process from "node:process";
import { runSkillsCli } from "./cli.js";

// The bin/skills launcher's entry point.
const code = await runSkillsCli(process.argv.slice(2), process.env, process.stdout, process.stderr);
process.exit(code);

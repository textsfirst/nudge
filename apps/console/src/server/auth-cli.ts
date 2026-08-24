import { distributionCommands } from "@nudge/server/distribution";
import { ConsoleAuth, rotateConsoleCapability } from "./auth.js";
import { ConsoleContext } from "./context.js";

const command = process.argv[2] ?? "show";
const context = new ConsoleContext();

try {
  if (command === "show") {
    const auth = new ConsoleAuth(context.dataDir());
    console.log("Nudge Console access code:\n");
    console.log(auth.revealCapability());
    console.log(`\nStored in ${auth.file} (mode 0600).`);
  } else if (command === "rotate") {
    const capability = rotateConsoleCapability(context.dataDir());
    console.log("Nudge Console access code rotated:\n");
    console.log(capability);
    console.log("\nRestart the console if it is currently running, then paste this code into the login page.");
  } else {
    console.error(`Usage: ${distributionCommands().auth} [show|rotate]`);
    process.exitCode = 1;
  }
} finally {
  context.close();
}

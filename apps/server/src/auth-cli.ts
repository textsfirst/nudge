import { runChatGptDeviceLogin } from "@nudge/agent";
import { loadWorkspaceEnvironment } from "./env.js";
import { resolveFromWorkspace } from "./paths.js";

loadWorkspaceEnvironment();

const authFile = resolveFromWorkspace(
  process.env.CHATGPT_AUTH_FILE ?? ".data/chatgpt-auth.json",
);

try {
  const tokens = await runChatGptDeviceLogin({
    authFile,
    onPrompt: ({ verificationUrl, userCode }) => {
      console.log("Sign in to ChatGPT to authorize Nudge:");
      console.log(`  ${verificationUrl}`);
      console.log(`  Code: ${userCode}`);
      console.log("Waiting for authorization…");
    },
  });
  console.log(`ChatGPT subscription auth saved to ${authFile}`);
  console.log(`Account: ${tokens.accountId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

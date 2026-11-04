import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// SDK 0.11.2 has no cancellation action. Use the documented CLI against this
// plugin host's explicit daemon home, with an exact ID obtained from the SDK.
export async function stopAgent(agentId: string) {
  if (!agentId || agentId.startsWith("-") || agentId.length > 200) throw new Error("Invalid agent ID");
  await exec("paseo", ["agent", "stop", agentId, "--home", process.env.PASEO_HOME || join(homedir(), ".paseo"), "--json"], {
    timeout: 15000, maxBuffer: 65536,
  });
}

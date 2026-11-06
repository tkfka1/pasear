import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type DeleteExecutor = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

// Public SDK 0.11.2 exposes archive but not hard deletion. Pin the documented
// CLI to this daemon home and pass only the exact ID resolved/authorized by SDK.
export function createAgentDeleter(home = process.env.PASEO_HOME || join(homedir(), ".paseo"), execute: DeleteExecutor = exec) {
  return async (agentId: string): Promise<void> => {
    if (!agentId || agentId.length > 200 || /^-|[\x00-\x1f\x7f]/.test(agentId)) throw new Error("Invalid agent ID");
    const { stdout } = await execute("paseo", ["agent", "delete", agentId, "--home", home, "--json"], {
      timeout: 15000, maxBuffer: 65536,
    });
    // CLI can exit successfully despite an individual deletion failure. Do not
    // accept a zero-count, bulk, or different-target receipt as success.
    const receipt = JSON.parse(stdout);
    if (receipt?.deletedCount !== 1 || !Array.isArray(receipt.agentIds)
      || receipt.agentIds.length !== 1 || receipt.agentIds[0] !== agentId) throw new Error("Invalid deletion receipt");
  };
}

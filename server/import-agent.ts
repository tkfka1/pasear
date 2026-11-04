import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type NativeImportExecutor = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
export interface NativeImportInput {
  provider: string;
  sessionId: string;
  cwd: string;
  requestId: string;
  intentHash: string;
  connectionId: string;
}

// The public SDK has no import action in 0.11.2. Keep the documented CLI
// fallback local to this installation, just like current-run cancellation.
// This CLI cannot bind a workspace ID, so callers MUST require host-wide access.
export function createNativeImporter(home = process.env.PASEO_HOME || join(homedir(), ".paseo"), execute: NativeImportExecutor = exec) {
  return async (input: NativeImportInput): Promise<string> => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.provider)
      || !input.sessionId || input.sessionId.length > 200 || /^-|[\x00-\x1f\x7f]/.test(input.sessionId)
      || !isAbsolute(input.cwd) || /[\x00-\x1f\x7f]/.test(input.cwd)
      || !/^[a-f0-9]{64}$/.test(input.requestId)
      || !/^[a-f0-9]{64}$/.test(input.intentHash)
      || !/^[A-Za-z0-9_-]{1,200}$/.test(input.connectionId)) throw new Error("Invalid native import input");
    const { stdout } = await execute("paseo", [
      "agent", "import", input.sessionId, "--provider", input.provider, "--cwd", input.cwd,
      "--label", "source=pasear", "--label", `connection=${input.connectionId}`,
      "--label", `pasearRequest=${input.requestId}`, "--label", "pasearImportMode=native",
      "--label", `pasearImportIntent=${input.intentHash}`,
      "--home", home, "--json",
    ], { timeout: 20000, maxBuffer: 65536 });
    const result = JSON.parse(stdout);
    if (typeof result.agentId !== "string" || !result.agentId || result.agentId.length > 200) throw new Error("Invalid import receipt");
    return result.agentId;
  };
}

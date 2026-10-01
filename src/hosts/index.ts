import { AgentError } from "../core/errors.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { opencode } from "./opencode.js";
import { HOST_IDS, type HostAdapter, type HostId } from "./types.js";

export const HOSTS: Record<HostId, HostAdapter> = { claude, opencode, codex };

const ALIASES: Record<string, HostId> = {
  claude: "claude",
  "claude-code": "claude",
  claudecode: "claude",
  cc: "claude",
  opencode: "opencode",
  "open-code": "opencode",
  oc: "opencode",
  codex: "codex",
  "codex-cli": "codex",
  openai: "codex",
};

export function parseHost(name: string): HostId {
  const id = ALIASES[name.toLowerCase()];
  if (!id) {
    throw new AgentError(`Unknown coding agent "${name}".`, {
      hint: `Supported: ${HOST_IDS.join(", ")}.`,
      exitCode: 2,
    });
  }
  return id;
}

export * from "./types.js";
export { claude, codex, opencode };

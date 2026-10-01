import { AGENT_VERSION } from "../version.js";

/**
 * The always-loaded instruction block written into CLAUDE.md / AGENTS.md.
 *
 * It is deliberately short: it only has to make a host agent notice that a
 * project is a Sillo project and load the `sillo` skill, which routes to the
 * focused skills. Everything else is loaded on demand.
 *
 * The block is delimited by markers. Only the text between them is ever
 * touched; everything the user wrote around it is preserved byte for byte.
 */
export const BLOCK_BEGIN = "<!-- sillo-agent:begin";
export const BLOCK_END = "<!-- sillo-agent:end -->";

export function instructionBlockBody(): string {
  return [
    "## Sillo",
    "",
    "When a project depends on the Sillo Python framework (`sillo-framework` in its",
    "dependencies, or `from sillo import …` in its code):",
    "",
    "- Load the `sillo` skill before writing or changing Sillo code. It checks the installed",
    "  version and routes to focused `sillo-*` skills (routing, record, auth, queues, …).",
    "- Never invent Sillo APIs. When a skill does not answer a question, read the installed",
    '  framework source (`python -c "import sillo, os; print(os.path.dirname(sillo.__file__))"`).',
    "- Follow the project's existing structure, make the smallest coherent change, keep",
    "  unrelated edits, and verify framework changes with the project's tests or `sillo routes`.",
  ].join("\n");
}

export function renderBlock(body = instructionBlockBody()): string {
  return `${BLOCK_BEGIN} v${AGENT_VERSION} — managed by sillo-agent; edit outside this block -->\n${body}\n${BLOCK_END}`;
}

export interface BlockLocation {
  start: number;
  end: number;
  inner: string;
}

/** Find the managed block. Refuses to guess when markers are unbalanced. */
export function findBlock(text: string): BlockLocation | "unbalanced" | undefined {
  const begin = text.indexOf(BLOCK_BEGIN);
  const endMarker = text.indexOf(BLOCK_END);
  if (begin === -1 && endMarker === -1) return undefined;
  if (begin === -1 || endMarker === -1 || endMarker < begin) return "unbalanced";
  if (text.indexOf(BLOCK_BEGIN, begin + 1) !== -1) return "unbalanced";
  const end = endMarker + BLOCK_END.length;
  return { start: begin, end, inner: text.slice(begin, end) };
}

/** Insert or replace the block, preserving everything outside it. */
export function upsertBlock(text: string | undefined, block: string): string {
  const current = text ?? "";
  const found = findBlock(current);
  if (found === "unbalanced") throw new Error("unbalanced sillo-agent markers");
  if (found) return current.slice(0, found.start) + block + current.slice(found.end);
  if (!current.trim()) return `${block}\n`;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const sep = current.endsWith("\n") ? eol : eol + eol;
  return `${current}${current.endsWith(eol + eol) ? "" : sep}${block}${eol}`;
}

/** Remove the block and the blank line it was separated by. */
export function removeBlock(text: string): string {
  const found = findBlock(text);
  if (!found || found === "unbalanced") return text;
  let before = text.slice(0, found.start);
  let after = text.slice(found.end);
  after = after.replace(/^\r?\n/, "");
  if (!after.trim()) before = before.replace(/(\r?\n)+$/, before.trim() ? "\n" : "");
  else before = before.replace(/(\r?\n){3,}$/, "\n\n");
  return before + after;
}

/** True when CLAUDE.md already pulls AGENTS.md in with an `@AGENTS.md` import. */
export function importsAgentsMd(claudeMd: string | undefined): boolean {
  return Boolean(claudeMd && /^\s*@(\.\/)?AGENTS\.md\s*$/m.test(claudeMd));
}

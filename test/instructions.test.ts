import { describe, expect, it } from "vitest";
import {
  findBlock,
  importsAgentsMd,
  removeBlock,
  renderBlock,
  upsertBlock,
} from "../src/install/instructions.js";

describe("instruction block", () => {
  const block = renderBlock();

  it("creates a file from nothing", () => {
    expect(upsertBlock(undefined, block)).toBe(`${block}\n`);
  });

  it("appends without touching existing text", () => {
    const out = upsertBlock("# Mine\n\nhello\n", block);
    expect(out.startsWith("# Mine\n\nhello\n")).toBe(true);
    expect(findBlock(out)).toMatchObject({ inner: block });
  });

  it("is idempotent", () => {
    const once = upsertBlock("# Mine\n", block);
    expect(upsertBlock(once, block)).toBe(once);
  });

  it("removes exactly what it added", () => {
    const original = "# Mine\n\nhello\n";
    expect(removeBlock(upsertBlock(original, block))).toBe(original);
  });

  it("refuses unbalanced markers", () => {
    const broken = block.slice(0, block.indexOf("-->") + 3);
    expect(findBlock(broken)).toBe("unbalanced");
    expect(() => upsertBlock(broken, block)).toThrow();
  });

  it("detects an @AGENTS.md import", () => {
    expect(importsAgentsMd("@AGENTS.md\n")).toBe(true);
    expect(importsAgentsMd("see AGENTS.md")).toBe(false);
  });
});

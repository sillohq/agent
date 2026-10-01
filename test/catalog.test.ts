import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/cli/context.js";
import { builtinSkillsDir } from "../src/skills/load.js";
import { Router } from "../src/skills/route.js";
import { LIMITS } from "../src/skills/schema.js";

describe("bundled catalog", async () => {
  const catalog = await loadCatalog();

  it("loads every skill directory", () => {
    const dirs = readdirSync(builtinSkillsDir(), { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    expect(catalog.skills.length).toBe(dirs.length);
  });

  it("ships a skill for every official package capability", () => {
    const names = new Set(catalog.skills.map((s) => s.meta.name));
    for (const name of [
      "sillo-oauth",
      "sillo-wire",
      "sillo-graphql",
      "sillo-admin",
      "sillo-scaffolding",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("keeps the listing inside the Codex budget", () => {
    const n = catalog.skills.reduce(
      (s, k) => s + k.meta.name.length + k.meta.description.length + 4,
      0,
    );
    expect(n).toBeLessThanOrEqual(LIMITS.codexListingBudget);
  });

  it("routes requests to the right skill", () => {
    const router = new Router(catalog.skills);
    const cases: Array<[string, string]> = [
      ["add sign in with Google", "sillo-oauth"],
      ["broadcast to everyone in a chat room", "sillo-wire"],
      ["add a GraphQL endpoint", "sillo-graphql"],
      ["add an admin panel for staff", "sillo-admin"],
      ["create a new Sillo project", "sillo-scaffolding"],
      ["send an email with an attachment", "sillo-mail"],
    ];
    for (const [query, expected] of cases) {
      expect(
        router.rank(query, 3).map((h) => h.skill),
        query,
      ).toContain(expected);
    }
  });
});

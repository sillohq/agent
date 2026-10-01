import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { AGENT_VERSION } from "../src/version.js";

let home: string;
let project: string;

function io(cwd: string) {
  let out = "";
  let err = "";
  return {
    run: (args: string[]) =>
      main(args, {
        stdout: {
          write: (t: string) => {
            out += t;
          },
        },
        stderr: {
          write: (t: string) => {
            err += t;
          },
        },
        env: { HOME: home, NO_COLOR: "1", SILLO_AGENT_TEST: "1" },
        cwd,
      }),
    out: () => out,
    err: () => err,
  };
}

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sillo-agent-"));
  home = path.join(base, "home");
  project = path.join(base, "project");
  await fs.mkdir(home);
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, "pyproject.toml"),
    '[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = ["sillo-framework>=1.0"]\n',
  );
});

afterEach(async () => {
  await fs.rm(path.dirname(home), { recursive: true, force: true });
});

describe("cli", () => {
  it("prints its version", async () => {
    const t = io(project);
    expect(await t.run(["--version"])).toBe(0);
    expect(t.out().trim()).toBe(AGENT_VERSION);
  });

  it("rejects unknown flags with exit code 2", async () => {
    const t = io(project);
    expect(await t.run(["install", "--nope"])).toBe(2);
  });

  it("dry-run writes nothing", async () => {
    const t = io(project);
    expect(await t.run(["install", "claude", "--global", "--dry-run"])).toBe(0);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("installs, is idempotent, preserves edits, and uninstalls", async () => {
    const skill = path.join(home, ".claude", "skills", "sillo-oauth", "SKILL.md");

    const first = io(project);
    expect(await first.run(["install", "claude", "--global"])).toBe(0);
    expect(await fs.readFile(skill, "utf8")).toContain("name: sillo-oauth");

    const again = io(project);
    expect(await again.run(["install", "claude", "--global"])).toBe(0);
    expect(again.out()).toContain("0 created, 0 updated");

    await fs.appendFile(skill, "\nmy own note\n");
    const update = io(project);
    await update.run(["update", "--global"]);
    expect(await fs.readFile(skill, "utf8")).toContain("my own note");

    const removal = io(project);
    expect(await removal.run(["uninstall", "--global"])).toBe(0);
    expect(await fs.readFile(skill, "utf8")).toContain("my own note");
    await expect(
      fs.access(path.join(home, ".claude", "skills", "sillo-graphql", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("refuses a project install into the home directory", async () => {
    const t = io(home);
    expect(await t.run(["install", "claude", "--project"])).toBe(2);
  });
});

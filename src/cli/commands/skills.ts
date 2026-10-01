import { AgentError } from "../../core/errors.js";
import { computeCoverage } from "../../framework/coverage.js";
import { renderSkillMarkdown, type SkillFormat } from "../../skills/render.js";
import { Router } from "../../skills/route.js";
import { type Context, loadCatalog } from "../context.js";

export async function skillsList(
  ctx: Context,
  flags: { json?: boolean; all?: boolean },
): Promise<number> {
  const { skills } = await loadCatalog();
  const shown = skills.filter((s) => flags.all || s.meta.status !== "draft");
  if (flags.json) {
    ctx.io.stdout.write(
      `${JSON.stringify(
        shown.map((s) => ({
          name: s.meta.name,
          title: s.meta.title,
          status: s.meta.status,
          description: s.meta.description,
          capabilities: s.meta.capabilities,
          related: s.meta.related,
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  ctx.ui.heading(`Sillo skills (${shown.length})`);
  ctx.ui.line();
  ctx.ui.table(
    ["Skill", "Covers"],
    shown.map((s) => [
      ctx.ui.paint("cyan", s.meta.name),
      s.meta.title +
        (s.meta.status === "stable" ? "" : ctx.ui.paint("yellow", ` [${s.meta.status}]`)),
    ]),
  );
  ctx.ui.line();
  ctx.ui.muted('  sillo-agent skills show <name>   ·   sillo-agent skills route "<request>"');
  return 0;
}

export async function skillsShow(
  ctx: Context,
  name: string | undefined,
  flags: { format?: string; raw?: boolean },
): Promise<number> {
  if (!name)
    throw new AgentError("Which skill?", {
      hint: "sillo-agent skills show sillo-queues",
      exitCode: 2,
    });
  const { skills, versions } = await loadCatalog();
  const wanted = name.startsWith("sillo") ? name : `sillo-${name}`;
  const skill = skills.find((s) => s.meta.name === wanted);
  if (!skill) {
    const close = skills.filter((s) => s.meta.name.includes(name)).map((s) => s.meta.name);
    throw new AgentError(`No skill named ${wanted}.`, {
      hint: close.length ? `Did you mean ${close.join(", ")}?` : "sillo-agent skills list",
      exitCode: 2,
    });
  }
  if (flags.raw) {
    ctx.io.stdout.write(`${skill.body}\n`);
    return 0;
  }
  const format = (flags.format ?? "claude") as SkillFormat;
  if (format !== "claude" && format !== "agents")
    throw new AgentError(`Unknown format ${format}; use claude or agents.`, { exitCode: 2 });
  ctx.io.stdout.write(renderSkillMarkdown(skill, format, { versions }));
  if (skill.files.length) {
    ctx.io.stdout.write(
      `\n<!-- supporting files: ${skill.files.map((f) => f.path).join(", ")} -->\n`,
    );
  }
  return 0;
}

export async function skillsCoverage(ctx: Context, flags: { json?: boolean }): Promise<number> {
  const { skills, capabilities } = await loadCatalog();
  const report = computeCoverage(capabilities, skills);
  if (flags.json) {
    ctx.io.stdout.write(
      `${JSON.stringify(
        {
          percent: report.percent,
          covered: report.covered,
          required: report.required,
          absentDocumented: report.absentDocumented,
          absentTotal: report.absentTotal,
          capabilities: report.rows.map((r) => ({
            id: r.capability.id,
            title: r.capability.title,
            status: r.capability.status,
            required: r.capability.required,
            state: r.state,
            skills: r.skills,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return report.covered === report.required ? 0 : 1;
  }
  const ui = ctx.ui;
  ui.heading("Sillo Skill Coverage");
  let area = "";
  for (const row of report.rows) {
    if (row.capability.status === "internal") continue;
    if (row.capability.area !== area) {
      area = row.capability.area;
      ui.section(area);
    }
    const title = row.capability.title.padEnd(34);
    const skills = row.skills.join(", ");
    switch (row.state) {
      case "covered":
        ui.ok(title, skills + (row.capability.required ? "" : "  (optional)"));
        break;
      case "documented-absent":
        ui.skip(title, `not in Sillo — documented in ${skills}`);
        break;
      case "draft-only":
        ui.warn(title, `draft only: ${skills}`);
        break;
      default:
        ui.fail(title, row.capability.required ? "not covered" : "not covered (optional)");
    }
  }
  ui.line();
  ui.line(
    ui.paint("bold", `Coverage: ${report.percent}%`) +
      ui.paint(
        "gray",
        `  (${report.covered} of ${report.required} required capabilities; ${report.absentDocumented} of ${report.absentTotal} absent features documented)`,
      ),
  );
  ui.muted(
    "  The denominator is framework/capabilities.yml: every public Sillo subsystem, mapped from the surface snapshot.",
  );
  return report.covered === report.required ? 0 : 1;
}

export async function skillsRoute(
  ctx: Context,
  words: string[],
  flags: { json?: boolean },
): Promise<number> {
  const query = words.join(" ").trim();
  if (!query)
    throw new AgentError(
      'Give a request to route, e.g. sillo-agent skills route "send this email in the background"',
      { exitCode: 2 },
    );
  const { skills } = await loadCatalog();
  const router = new Router(skills.filter((s) => s.meta.status !== "draft"));
  const hits = router.compose(query, 5, 2);
  if (flags.json) {
    ctx.io.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
    return 0;
  }
  ctx.ui.heading(`"${query}"`);
  ctx.ui.muted("  A lexical approximation of how a host picks skills from their descriptions.");
  ctx.ui.line();
  for (const hit of hits) {
    if (hit.via) ctx.ui.info(hit.skill, `related to ${hit.via}`);
    else ctx.ui.ok(hit.skill, hit.score.toFixed(2));
  }
  return 0;
}

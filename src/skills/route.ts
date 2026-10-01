import type { Skill } from "./schema.js";

/**
 * A deterministic stand-in for how a host picks skills.
 *
 * Hosts route with their model over each skill's name and description; we
 * cannot run that in CI. What we can check is that the text a model routes on
 * actually carries the signal for the requests we care about. This ranks
 * skills by BM25 over exactly that text (plus intents, which Claude also sees
 * as `when_to_use`), then expands the top hits along `related` edges the way
 * a skill's Compose section tells the agent to.
 *
 * It is a proxy, and reported as one: passing means the words are there, not
 * that every model will choose well.
 */

const STOP = new Set(
  "a an the to of for and or in on at by with from into this that these those it its is are be as i me my we our you your can could should would will do does did make add use using want need so when then than please just also all any some how what why where which who get set up".split(
    " ",
  ),
);

/** Light stemming: enough to match "emails"/"email", "queued"/"queue", "caching"/"cache". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ied")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => !STOP.has(t) && t.length > 1)
    .map(stem);
}

interface Doc {
  name: string;
  tf: Map<string, number>;
  length: number;
}

function routingText(skill: Skill): string {
  const topic = skill.meta.name.replace(/^sillo-?/, "").replace(/-/g, " ");
  // The name and title are what a model reads first; weight them by repetition.
  return [
    topic,
    topic,
    skill.meta.title,
    skill.meta.title,
    skill.meta.description,
    skill.meta.intents.join(". "),
    skill.meta.capabilities.join(" ").replace(/_/g, " "),
  ].join(". ");
}

export interface RouteHit {
  skill: string;
  score: number;
  via?: string;
}

export class Router {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avg: number;
  private readonly related: Map<string, string[]>;

  constructor(skills: Skill[]) {
    this.docs = skills.map((s) => {
      const tokens = tokenize(routingText(s));
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { name: s.meta.name, tf, length: tokens.length };
    });
    this.avg = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
    this.related = new Map(skills.map((s) => [s.meta.name, s.meta.related]));
  }

  rank(query: string, limit = 5): RouteHit[] {
    const terms = tokenize(query);
    const n = this.docs.length;
    const k1 = 1.4;
    const b = 0.6;
    const scored = this.docs.map((doc) => {
      let score = 0;
      for (const t of new Set(terms)) {
        const f = doc.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * doc.length) / this.avg));
      }
      return { skill: doc.name, score };
    });
    return scored
      .filter((s) => s.score > 0 && s.skill !== "sillo")
      .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill))
      .slice(0, limit);
  }

  /**
   * The skills an agent would plausibly end up loading: the ranked hits, plus
   * the `related` skills of the top hits, which each skill's Compose section
   * points the agent at.
   */
  compose(query: string, limit = 5, expandTop = 2): RouteHit[] {
    const hits = this.rank(query, limit);
    const out = [...hits];
    const seen = new Set(hits.map((h) => h.skill));
    for (const hit of hits.slice(0, expandTop)) {
      for (const rel of this.related.get(hit.skill) ?? []) {
        if (!seen.has(rel)) {
          seen.add(rel);
          out.push({ skill: rel, score: 0, via: hit.skill });
        }
      }
    }
    return out;
  }
}

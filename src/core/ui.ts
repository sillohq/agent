/**
 * Terminal output. Colour and Unicode are used only when the stream is a TTY
 * that supports them, and `NO_COLOR` / `FORCE_COLOR` are honoured, so piped
 * output and CI logs stay plain.
 */
export interface Writer {
  write(text: string): void;
  isTTY?: boolean;
}

export interface UiOptions {
  color?: boolean;
  unicode?: boolean;
  quiet?: boolean;
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
} as const;

export type Tone = keyof typeof CODES;

export class Ui {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly quiet: boolean;

  constructor(
    private readonly out: Writer,
    env: NodeJS.ProcessEnv,
    options: UiOptions = {},
  ) {
    const tty = Boolean(out.isTTY);
    const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
    this.color =
      options.color ?? (forced || (tty && env.NO_COLOR === undefined && env.TERM !== "dumb"));
    this.unicode = options.unicode ?? (process.platform !== "win32" || Boolean(env.WT_SESSION));
    this.quiet = options.quiet ?? false;
  }

  paint(tone: Tone, text: string): string {
    if (!this.color) return text;
    const [open, close] = CODES[tone];
    return `\u001b[${open}m${text}\u001b[${close}m`;
  }

  get symbols() {
    return this.unicode
      ? { ok: "✓", fail: "✗", warn: "!", info: "•", arrow: "→", skip: "–" }
      : { ok: "+", fail: "x", warn: "!", info: "*", arrow: "->", skip: "-" };
  }

  line(text = ""): void {
    this.out.write(`${text}\n`);
  }

  heading(text: string): void {
    this.line(this.paint("bold", text));
  }

  section(text: string): void {
    this.line();
    this.line(this.paint("bold", text));
  }

  ok(text: string, detail?: string): void {
    this.item(this.paint("green", this.symbols.ok), text, detail);
  }

  fail(text: string, detail?: string): void {
    this.item(this.paint("red", this.symbols.fail), text, detail);
  }

  warn(text: string, detail?: string): void {
    this.item(this.paint("yellow", this.symbols.warn), text, detail);
  }

  info(text: string, detail?: string): void {
    this.item(this.paint("cyan", this.symbols.info), text, detail);
  }

  skip(text: string, detail?: string): void {
    this.item(this.paint("gray", this.symbols.skip), text, detail);
  }

  muted(text: string): void {
    this.line(this.paint("gray", text));
  }

  private item(mark: string, text: string, detail?: string): void {
    this.line(`  ${mark} ${text}${detail ? `  ${this.paint("gray", detail)}` : ""}`);
  }

  /** Aligned two-column rows, for status and info output. */
  pairs(rows: Array<[string, string]>, indent = 2): void {
    const width = Math.max(0, ...rows.map(([k]) => k.length));
    for (const [k, v] of rows) {
      this.line(`${" ".repeat(indent)}${this.paint("gray", k.padEnd(width))}  ${v}`);
    }
  }

  table(headers: string[], rows: string[][], indent = 2): void {
    const widths = headers.map((h, i) =>
      Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))),
    );
    const pad = " ".repeat(indent);
    const fmt = (cells: string[]) =>
      cells.map((c, i) => c + " ".repeat((widths[i] ?? 0) - visibleLength(c))).join("  ");
    this.line(pad + this.paint("bold", fmt(headers)));
    this.line(pad + this.paint("gray", widths.map((w) => "─".repeat(w)).join("  ")));
    for (const row of rows) this.line(pad + fmt(row));
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

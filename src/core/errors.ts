/**
 * An error meant for a person at a terminal: what went wrong, and what to do
 * about it. Anything else that escapes is a bug and is reported as one.
 */
export class AgentError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(
    message: string,
    options: { hint?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentError";
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

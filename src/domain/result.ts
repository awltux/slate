/**
 * Every operation answers with an envelope and every failure is a code. Surfaces (CLI, HTTP, MCP) render these;
 * they never invent their own error shape, and they never see a thrown exception.
 */

export const ERROR_CODES = [
  "capability_missing",
  "service_unavailable",
  "capability_mismatch",
  "budget_exhausted",
  "approval_required",
  "approval_expired",
  "stale_upstream",
  "readiness_failed",
  "pair_invalid",
  "policy_rejected",
  "provider_error",
  /** The model accepted the job and did not finish in the time allowed; the job was asked to stop. */
  "provider_timeout",
  "conflict",
  "unauthorized",
  "forbidden",
  "invalid_input",
  "invalid_document",
  "media_missing",
  "hash_mismatch",
  "not_found",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SlateErrorShape {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: Record<string, unknown>;
}

export class SlateError extends Error implements SlateErrorShape {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SlateError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.detail) this.detail = options.detail;
  }

  toShape(): SlateErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export interface Warning {
  code: string;
  message: string;
}

export interface Envelope<T> {
  ok: true;
  data: T;
  /** Document revision after the operation. */
  version: number;
  /** Commit created by a write operation. */
  commit?: string;
  /** Nodes that became stale, and nodes that stopped being stale, as a result. */
  stale: { added: string[]; cleared: string[] };
  /** Which rung of a service chain actually ran, when an operation used external tools. */
  via?: string;
  warnings: Warning[];
  /** Legal next operations, short and specific. */
  next: string[];
}

export interface FailureEnvelope {
  ok: false;
  error: SlateErrorShape;
}

export function ok<T>(
  data: T,
  options: {
    version?: number;
    commit?: string;
    via?: string;
    warnings?: Warning[];
    next?: string[];
    stale?: { added: string[]; cleared: string[] };
  } = {},
): Envelope<T> {
  return {
    ok: true,
    data,
    version: options.version ?? 0,
    ...(options.commit ? { commit: options.commit } : {}),
    stale: options.stale ?? { added: [], cleared: [] },
    ...(options.via ? { via: options.via } : {}),
    warnings: options.warnings ?? [],
    next: options.next ?? [],
  };
}

export function fail(error: unknown): FailureEnvelope {
  if (error instanceof SlateError) return { ok: false, error: error.toShape() };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "internal", message, retryable: false } };
}

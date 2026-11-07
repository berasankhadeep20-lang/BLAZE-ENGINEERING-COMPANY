/** Typed application errors. The UI maps `code` to a precise message; services never throw bare strings. */
export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'INSUFFICIENT_STOCK',
  'OVERPAYMENT',
  'CUSTOMER_NOT_APPROVED',
  'CONFLICT',
  'INVARIANT', // a programming error: the code broke a rule it should never break
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

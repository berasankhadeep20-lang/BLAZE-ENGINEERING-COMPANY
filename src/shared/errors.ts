/** Typed application errors. The UI maps `code` to a precise message; services never throw bare strings. */
export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'AUTH_FAILED', // wrong credentials, unknown user, disabled account or expired session (deliberately indistinguishable)
  'ACCOUNT_LOCKED',
  'PASSWORD_CHANGE_REQUIRED',
  'INSUFFICIENT_STOCK',
  'OVERPAYMENT',
  'CUSTOMER_NOT_APPROVED',
  'ACK_REQUIRED', // the user must explicitly acknowledge something (for example a sale below cost) and resubmit
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

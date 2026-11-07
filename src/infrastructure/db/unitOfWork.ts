import { AppError } from '../../shared/errors';
import { systemClock, type Clock } from '../../shared/clock';
import type { Db } from './connection';

export interface Actor {
  userId: number;
  role: 'OWNER' | 'EMPLOYEE';
}

/** Everything a use case needs inside one transaction. `now` and `actor` are fixed for the whole transaction. */
export interface TxContext {
  readonly db: Db;
  readonly actor: Actor | null; // null only for pre-login events such as a failed sign-in
  readonly now: string; // UTC ISO timestamp
}

/**
 * One use case = one transaction. If `fn` throws, every write made through ctx.db is rolled back
 * (bill, stock, balances and audit rows together). Nested run() calls become savepoints.
 */
export class UnitOfWork {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  run<T>(actor: Actor | null, fn: (ctx: TxContext) => T): T {
    const ctx: TxContext = { db: this.db, actor, now: this.clock.now().toISOString() };
    return this.db.transaction((): T => {
      const result = fn(ctx);
      if (result instanceof Promise) {
        // An async body would commit before its awaits finish. Throwing here rolls everything back.
        throw new AppError('INVARIANT', 'UnitOfWork.run needs a synchronous function');
      }
      return result;
    })();
  }
}

export function assertInTransaction(ctx: TxContext, what: string): void {
  if (!ctx.db.inTransaction) {
    throw new AppError('INVARIANT', `${what} must be called inside UnitOfWork.run`);
  }
}

export function requireActor(ctx: TxContext, what: string): Actor {
  if (!ctx.actor) throw new AppError('INVARIANT', `${what} needs a signed-in user`);
  return ctx.actor;
}

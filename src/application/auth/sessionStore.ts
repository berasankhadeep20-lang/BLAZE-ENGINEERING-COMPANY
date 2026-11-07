import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from '../../shared/clock';

interface Session {
  userId: number;
  lastActivity: number;
}

/**
 * Sessions live only in memory, so closing the app signs everyone out and the sign-in screen always appears on launch.
 * An optional idle timeout (0 = off) signs out an unattended counter PC.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly idleTimeoutMs = 0,
  ) {}

  create(userId: number): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { userId, lastActivity: this.clock.now().getTime() });
    return token;
  }

  /** The user id behind a token, or null if unknown or idle too long. Counts as activity. */
  resolve(token: string): number | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    const now = this.clock.now().getTime();
    if (this.idleTimeoutMs > 0 && now - s.lastActivity > this.idleTimeoutMs) {
      this.sessions.delete(token);
      return null;
    }
    s.lastActivity = now;
    return s.userId;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }

  destroyAllForUser(userId: number, exceptToken?: string): void {
    for (const [token, s] of this.sessions) {
      if (s.userId === userId && token !== exceptToken) this.sessions.delete(token);
    }
  }
}

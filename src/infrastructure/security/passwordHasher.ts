import { Algorithm, hash, verify } from '@node-rs/argon2';

/** Passwords are only ever stored as salted argon2id hashes. The interface lets tests inject a fast fake. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

// OWASP-recommended argon2id settings: 19 MiB memory, 2 passes, 1 lane.
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const argon2idHasher: PasswordHasher = {
  hash: (password) => hash(password, OPTIONS),
  async verify(stored, password) {
    try {
      return await verify(stored, password);
    } catch {
      return false; // malformed hash: treat as a failed match, never crash the sign-in
    }
  },
};

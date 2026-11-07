import { describe, expect, it } from 'vitest';
import { argon2idHasher } from '../../src/infrastructure/security/passwordHasher';

describe('argon2id hasher (real)', () => {
  it('hashes with argon2id, salts, and verifies', async () => {
    const a = await argon2idHasher.hash('correct horse battery');
    const b = await argon2idHasher.hash('correct horse battery');
    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toContain('correct horse');
    expect(a).not.toBe(b); // random salt
    expect(await argon2idHasher.verify(a, 'correct horse battery')).toBe(true);
    expect(await argon2idHasher.verify(a, 'wrong')).toBe(false);
  });
  it('treats a malformed stored hash as a failed match', async () => {
    expect(await argon2idHasher.verify('not-a-hash', 'x')).toBe(false);
    expect(await argon2idHasher.verify('', 'x')).toBe(false);
  });
});

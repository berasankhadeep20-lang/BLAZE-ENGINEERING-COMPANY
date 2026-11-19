import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Disks on Windows machines flush far more slowly than Linux ones, and several tests build a whole sample business.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

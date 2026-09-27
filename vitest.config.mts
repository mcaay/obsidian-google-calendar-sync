import { defineConfig } from 'vitest/config';

// Only the maintained suite. Review artifacts under output/ are ignored.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] } });

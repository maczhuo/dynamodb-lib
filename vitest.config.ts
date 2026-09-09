import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/unit.test.ts'], coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text', 'html', 'json-summary'], thresholds: { statements: 85, branches: 70, functions: 90, lines: 85 } } } });

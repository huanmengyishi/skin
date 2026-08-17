import { defineConfig } from 'vitest/config'

/** E2E 专用配置：include 覆盖 .e2e.ts（vitest 默认 include 只含 *.spec.ts）。 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})

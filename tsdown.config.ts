// 独立仓库的 client bundle 预设：镜像宿主 packages/client/tsdown.client.ts 的
// factory-closure 形态（window.__ModuleLoader__.load({id, factory})），externals
// 与宿主平台模块表一致（packages/client/web/src/platform.ts）。
// 皮肤自身的 bundle（skins/<id>/client/index.js）是手写 factory 脚本，不经本预设。
import { defineConfig } from 'tsdown'

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

export default defineConfig([
  // Host 半（Node，被 Loader import）：@deepseek-ai/* 全部外置（profile 提供）
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    entryFileNames: 'index.js',
    external: [/^@deepseek-ai\//, /^react/],
    clean: false,
  },
  // Client 半（浏览器）：factory closure，平台模块全部外置
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    entryFileNames: 'client.js',
    external: PLATFORM_EXTERNALS,
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-skin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: 'return module.exports; }});',
    },
    clean: false,
    minify: false,
    sourcemap: true,
  },
])

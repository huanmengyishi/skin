import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 写一个最小合法皮肤包目录，返回目录路径。 */
export function writeSkinFixture(root: string, id: string, extra: Record<string, string> = {}): string {
  const dir = join(root, id)
  mkdirSync(join(dir, 'theme'), { recursive: true })
  mkdirSync(join(dir, 'styles'), { recursive: true })
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id, version: '1.0.0', name: id + ' skin', author: 'tester',
    description: 'fixture skin', tags: ['fixture'], skinApiVersion: 1,
    preview: {},
  }, null, 2))
  writeFileSync(join(dir, 'theme', 'light.json'), '{"--dsw-alias-brand-primary":"#111111"}')
  writeFileSync(join(dir, 'theme', 'dark.json'), '{"--dsw-alias-brand-primary":"#222222"}')
  writeFileSync(join(dir, 'styles', 'theme.css'), 'body[data-dsh-skin="' + id + '"] {}')
  writeFileSync(join(dir, 'client', 'index.js'), 'window.__ModuleLoader__.load({ id: "dsh-skin/' + id + '", factory: function () { return { apply: function () {} }; } });')
  for (const [rel, content] of Object.entries(extra)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

export function listRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

export function sha256(bytes: Uint8Array): string {
  // 测试用轻量哈希（完整性模块自身用 node:crypto 实现并另行测试）
  let hash = 0
  for (const byte of bytes) hash = ((hash << 5) - hash + byte) | 0
  return 'fnv' + Math.abs(hash).toString(16).padStart(8, '0')
}

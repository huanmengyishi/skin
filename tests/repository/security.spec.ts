import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from '../../src/repository/fs'
import { isExecutablePath, scanExecutables, scanRemoteUrls, scanPackageSecurity } from '../../src/repository/security'

describe('安全门（安装期静态扫描）', () => {
  it('可执行扩展名黑名单（大小写不敏感，Windows 兼容）', () => {
    for (const name of ['evil.exe', 'EVIL.EXE', 'x.BAT', 'y.ps1', 'z.lnk', 'w.scr', 'a/../b.exe'.split('/').pop() ?? '']) {
      if (name.length === 0) continue
      expect(isExecutablePath(name), name).toBe(true)
    }
    expect(isExecutablePath('client/index.js')).toBe(false)
    expect(isExecutablePath('preview/light.svg')).toBe(false)
    expect(isExecutablePath('styles/theme.css')).toBe(false)
  })

  it('scanExecutables：递归发现并拒绝', async () => {
    const dir = join(tmpdir(), 'dsh-skin-sec-' + Date.now())
    mkdirSync(join(dir, 'client'), { recursive: true })
    writeFileSync(join(dir, 'client', 'index.js'), 'ok')
    writeFileSync(join(dir, 'client', 'payload.EXE'), 'x')
    const issues = await scanExecutables(nodeFs(), dir)
    expect(issues.join(';')).toContain('payload.EXE')
  })

  it('scanRemoteUrls：css/js 内远程 URL 拒绝；本地相对路径放行', async () => {
    const dir = join(tmpdir(), 'dsh-skin-sec-' + Date.now() + '-u')
    mkdirSync(join(dir, 'styles'), { recursive: true })
    mkdirSync(join(dir, 'client'), { recursive: true })
    writeFileSync(join(dir, 'styles', 'theme.css'), 'body[data-x="a"] { background: url("https://evil.example/x.png"); }')
    writeFileSync(join(dir, 'client', 'index.js'), 'var x = 1;')
    const issues = await scanRemoteUrls(nodeFs(), dir)
    expect(issues.join(';')).toContain('远程 URL')
    // 移除远程引用后放行
    writeFileSync(join(dir, 'styles', 'theme.css'), 'body[data-x="a"] { background: url("preview/light.svg"); }')
    expect((await scanRemoteUrls(nodeFs(), dir)).length).toBe(0)
  })

  it('scanPackageSecurity：组合扫描', async () => {
    const dir = join(tmpdir(), 'dsh-skin-sec-' + Date.now() + '-c')
    mkdirSync(join(dir, 'client'), { recursive: true })
    writeFileSync(join(dir, 'client', 'index.js'), 'ok')
    writeFileSync(join(dir, 'x.cmd'), 'x')
    const issues = await scanPackageSecurity(nodeFs(), dir)
    expect(issues.length).toBeGreaterThan(0)
  })
})

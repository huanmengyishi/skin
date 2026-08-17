# Skin Security（信任模型与安全边界，v1.0.0）

## 信任模型（诚实声明）

- Trusted：builtin（随插件分发）、installed（本机安装）、generated（本机 AI 生成）。
- Untrusted：downloaded（Workshop 下载）——UI 显示 ⚠ untrusted 徽标。
- 浏览器内执行边界：皮肤代码只经 SkinContext 运行，拿不到宿主 ctx/loader/settings 服务/fs/网络凭据/模型密钥。
- 不声称的边界：皮肤代码与页面同源执行，恶意 CSS/JS 可影响页面外观、可发起同源请求（与其他同源页面脚本一致）；本项目不是 OS 级沙箱（宿主 preview 亦无第三方 JS 沙箱）。下载来源默认 untrusted 标注是静态治理，不是执行隔离。

## 已实现防护（全部有测试）

- 路径：Skin ID 白名单字符集 + 保留字；包内相对路径拒绝绝对/盘符/.. /反斜杠；逐段 lstat 拒绝 symlink（安装/复制/导出/文件服务）。
- zip：下载解包 zip-slip 矩阵拒绝（../、绝对路径、盘符、反斜杠、空名，大小写不敏感扩展名黑名单）。
- 完整性：sha256 integrity（包内 integrity.json 存在则必须匹配；安装缺失则生成）；下载必须 checksum 匹配（缺失/不匹配拒绝）。
- 恶意文件：安装期安全门拒绝可执行扩展名（exe/dll/bat/cmd/ps1/vbs/scr/msi/com/reg/lnk/sys/pif/cpl，大小写不敏感）与 css/js/html 内远程 URL 引用（防跟踪/注入）。
- 原子性：staging → 校验 → atomic rename；失败零残留；replace 失败回滚旧包。
- 入口：写类 API loopback + 同源栅栏；生成/发布/下载入口图片与包 ≤8MB；发布只读本地（上传失败本地零改动）；downloaded 来源禁止再发布。
- 互斥与回收：任意时刻一个激活皮肤；SkinContext dispose 逆序回收（E2E 断言零残留）。

## 威胁清单对照（任务书 §28）

manifest spoofing → 校验 + id/目录一致；path traversal / zip-slip / symlink → 上述路径与 zip 防护；arbitrary overwrite → staging+rename+回滚；恶意 HTML/SVG → 静态资源仅经同源页面加载（皮肤 HTML 非入口形态，仅预览页自用）；script/CSS injection → 皮肤代码受限 SkinContext + 安装期远程 URL 拒绝；tracking → 远程 URL 拒绝；hidden executables → 扩展名黑名单；dependency confusion / name & version spoofing → 皮肤无 npm 依赖图（唯一依赖为宿主平台模块，无 externals）。

## 兼容性治理

- skinApiVersion = 1（dsh-skin 定义并维护）：manifest 契约 / theme token 对 / client 工厂形态 / scope 属性 / integrity 格式。
- Harness 版本与 Skin Package 版本独立分治；harnessCompatibility（远端元数据）为信息性字段，不参与本地判定。
- 宿主仍 preview：每次阶段开工前复核 master 关键文件（本仓库惯例，见 SKIN_ARCHITECTURE_AUDIT.md §5 验证记录）。

## 未决与 upstream 候选

- 宿主 Web settings 网关的 namespace 白名单未向插件开放（settings-not-exposed）→ dsh-skin 自建 loopback API 走同一 settings seam；建议 upstream 提供 settings.register({ exposedToWeb: true }) 类通用扩展点。
- 无头浏览器 file:// 页面像素合成对部分 CSS 变化不敏感 → 视觉验证采用像素 + 计算样式指纹双判据。


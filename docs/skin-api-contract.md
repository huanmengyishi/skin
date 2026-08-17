# dsh-skin 皮肤 API 契约（skin-api-contract）

> 状态：Phase 1 冻结。本文件是 Skin Contract 的唯一规范来源；源码形状见 src/core/contract.ts、src/core/errors.ts、src/client/runtime/contract.ts。
> 冻结纪律：改动任何 FROZEN 项须走架构否决门 + minor 版本升级（docs/BASELINE.md）；不冻结实现内部（tryOnToken/epoch/Map/具体类）。

## 1. SkinManifest（冻结，src/core/manifest.ts）

| 字段 | 类型 | 规则（非法=ManifestError 语义） |
| --- | --- | --- |
| id | string | /^[a-z0-9][a-z0-9-]{0,63}$/ 且非保留字（RESERVED_SKIN_IDS） |
| version | string | SemVer x.y.z[-prerelease] |
| name | string | 非空，≤64 |
| author | string | 非空 |
| description | string | 非空，≤512 |
| tags | string[] | ≤16 个，每个 /^[a-z0-9][a-z0-9-]{0,31}$/ |
| skinApiVersion | number | 必须 === SKIN_API_VERSION(=1)；≠1 一律拒绝（兼容性语义见 §4） |
| preview | { light?, dark? } | 可选；包内相对路径（禁绝对/盘符/协议/反斜杠/.. 穿越） |

未知字段一律放行（前向兼容预留）。validateManifest 返回 {ok,issues} 结果协议（不是抛异常）。

## 2. SkinPackage（冻结，结构 = store.ts 常量 + SkinInfo.files 事实）

```text
<pkg>/
├── manifest.json        必需（§1 校验）
├── integrity.json       可选；存在必须与内容一致；安装时缺失则生成（sha256）
├── theme/light.json     可选（token 覆盖，两侧都有的键才合并）
├── theme/dark.json      可选
├── styles/theme.css     可选（作用域 body[data-dsh-skin="<id>"]；缺失=空样式容忍）
├── client/index.js      可选（factory：window.__ModuleLoader__.load({id:'dsh-skin/<id>', factory}) 导出 {apply(skinCtx)}；缺失=仅 token/CSS 皮肤）
└── preview/{light,dark}.*  可选（预览资产，Repository 层供给）
```

- SkinPackageFiles（冻结字段）：bundle / styles / themeLight / themeDark / previewLight? / previewDark?。
- **预览归 Package/Repository 层**：元数据 = manifest.preview；字节 = Repository.fileRef/readFile。Runtime 契约无 preview 操作。
- 安全门（安装期）：可执行扩展名 / 远程 URL / symlink 一律拒绝（SecurityError 语义）。

## 3. SkinSource / SkinTrust（两个独立维度，冻结）

- SkinSource = 'builtin' | 'installed' | 'generated' | 'downloaded'。
- SkinTrust = 'trusted' | 'untrusted'；trustOf(source)：downloaded→untrusted，其余→trusted。信任只由 source 推导，不随任何其他条件变化。

## 4. SkinCompatibility（冻结事实）

- 唯一受支持 skinApiVersion = 1（SKIN_API_VERSION）。
- compatibilityOf(v)：v===1 → compatible；v>1 → incompatible（CompatibilityError 语义）；v<1 → invalid。
- 现状：validateManifest 对 ≠1 一律拒绝（与兼容性分类对齐）；多版本共存是 deferred（见 §12）。

## 5. SkinResolutionPolicy（冻结，SKIN_RESOLUTION_POLICY）

- 同 id 冲突优先级：**installed > generated > downloaded > builtin**（后写者胜；被遮蔽者在 issues 记录“遮蔽”）。
- 安装冲突：同 id 二次 install → 拒绝（'ID 已存在'）；replace → 旧包挪垃圾桶→新包落位→失败回滚（RollbackError 语义）。
- builtin：不可覆盖、不可卸载。
- registry.json：内存权威 + 磁盘缓存；磁盘发现是权威（启动对账：load→refresh→persist，回写失败不阻断）。

## 6. SkinRepository（冻结接口面 SkinRepositoryFace）

```text
hydrate()                    启动对账（建根目录 + registry.hydrate）
list() / get(id)             registry 快照
readFile(id, rel)            包内文件字节（路径守卫）
fileRef(id, rel)             包内相对路径 → 受守卫绝对路径
install(sourceDir, {kind?})  validate → staging 复制 → 二次校验+安全门+完整性 → atomic rename → registry 刷新
replace(sourceDir, {kind?})  同 id 替换带回滚（非内置）
remove(id)                   卸载非内置（staging 垃圾桶 rename）
registry                     当前快照面 {current, get, list}
```

- 结果协议：{ok:true} | {ok:false, issues:string[]}（已验收事实，冻结；不抛异常）。
- discover 边界：discoverPackages(fs, builtin, installed, generated, downloaded)，损坏包进 state（ok/invalid/corrupt）不崩。

## 7. SkinRuntime（冻结契约面 SkinRuntimeFace）

| 契约名 | 实现名（v1.0.0 事实） | 语义 |
| --- | --- | --- |
| apply(id) | applySkin(id, {persist:true}) | 加载+应用+持久化；失败清理 partial effects 并抛 ApplyError；activeSkin 只在成功后更新 |
| switch(id) | switchSkin(id) | dispose A → apply B → 失败清理并恢复 A（RollbackError）；activeSkin 只在 B 成功后更新 |
| restore() | restoreDefault() | dispose 当前 + activeSkin 置 null |
| enter(id) | tryOn(id) | 试穿进入：**首次 enter 快照正式激活皮肤为基准**（tryOnBaseId）；卸载当前→加载目标（不持久化）；后续 enter 替换目标但基准不变；返回 TryOnHandle{id,exit} |
| exit() | exitTryOn() | 退出整个试穿会话：取消一切 in-flight enter，回收目标，恢复基准（首次 enter 时的正式激活皮肤）；activeSkin 持久值全程不变 |
| （内部） | applySkin opts.guard | 竞态守卫（非公共契约）：过期异步提交在注册前/提交前被丢弃（StaleApplyError 静默），不得注入任何效果；最后一次有效 enter 决定最终状态 |
| list() | listSkins() | 刷新列表快照 |
| remove(id) | removeSkin(id) | 卸载非内置；激活中先 restore |
| bootstrap(activeId) | bootstrap(activeId) | 启动恢复：按持久值重应用（失败不抹持久值） |
| getSnapshot/subscribe/activeId | 同名 | 状态订阅面 |

- **不冻结**：tryOnToken/epoch、AppliedSkin 结构、内部 Map/Set、方法名拼写（改名=Phase 2 候选）。
- 任意时刻最多一个激活皮肤；dispose 后验证 data-dsh-skin 无残留（否则 DisposeError）。
- **无 preview(id)**：预览不属于 Runtime 契约。

## 8. SkinRuntimeContext（冻结：ownership + disposer 不变量）

- 皮肤代码只经 SkinContext 产生副作用，绝不接触宿主 ctx/loader/settings/凭据。
- **核心契约 = 所有权追踪**：effect(fn) 登记 disposer；任何已登记副作用在 dispose 时逆序回收；dispose 幂等；单个 disposer 失败不阻断其余。
- 当前扩展点（便捷封装，**不是封闭集合**）：addStyle / addElement / addAttribute / addObserver / addTimer / theme.overrideTokens。未来可新增扩展点，但都必须遵守同一 ownership 不变量。
- dispose 后登记副作用 → 抛错（assertLive）。

## 9. SkinController（冻结编排面 SkinControllerFace）

- 定位：Skin Center 的**唯一上层编排入口**（Repository + Runtime 的编排面）。
- 冻结 Surface 名：runtime（SkinRuntimeFace）+ listSkins/getSkin + generate/regenerate/export/removeSkin + browseWorkshop/publish/report。
- **已落地（Phase 4 / run-008）**：Skin Center 全部操作经 SkinController（src/client/controller/controller.ts）编排——UI 不直连 runtime 生命周期、不直接 fetch 皮肤 API、不经手 bundle/registry/持久化；错误经 controller.describeError 展示（未处理 rejection 修复）。
- 不冻结：generate/regenerate 的 payload 细节（v1.2+）、workshop 的 RemoteRepository HTTP API（v1.6+，见 §12）。

## 10. SkinError 分类学（冻结，src/core/errors.ts）

| 类 | kind | retryable | recoverable | userActionRequired | fatal | 现有接线 |
| --- | --- | --- | --- | --- | --- | --- |
| ManifestError | manifest | ✗ | ✗ | ✓ | ✗ | 校验结果协议（issues 形式） |
| PackageError | package | ✗ | ✗ | ✓ | ✗ | 校验结果协议 |
| IntegrityError | integrity | ✗ | ✓ | ✓ | ✗ | 校验结果协议 |
| CompatibilityError | compatibility | ✗ | ✓ | ✓ | ✗ | skinApiVersion≠1（结果协议） |
| ResolutionError | resolution | ✗ | ✓ | ✓ | ✗ | 安装冲突（结果协议） |
| LoadError | load | ✓ | ✓ | ✗ | ✗ | loader.ts（缺 apply 导出 / loadScript 失败 / importModule 失败）/ applySkin 前置（已接线；loadScript/importModule 归类为 G 证据驱动的 patch 级加固） |
| ApplyError | apply | ✓ | ✓ | ✗ | ✗ | applySkin（已接线，消息不变） |
| DisposeError | dispose | ✗ | ✓ | ✗ | ✗ | disposeCurrent 验证（已接线） |
| RollbackError | rollback | ✓ | ✓ | ✗ | ✗ | switchSkin 回滚（已接线） |
| RepositoryError | repository | ✗ | ✓ | ✓ | ✗ | 仓库结果协议 |
| NetworkError | network | ✓ | ✓ | ✗ | ✗ | workshop（预留） |
| SecurityError | security | ✗ | ✗ | ✗ | ✓ | 安全扫描（结果协议） |

- 分类属性机器可判断：isSkinError / classifySkinError / SKIN_ERROR_FLAGS。
- 边界：仓库/校验层保持 {ok,issues} 结果协议（已验收事实）；抛出异常面当前接在运行时/加载层，消息与 v1.0.0 逐字一致。

## 11. 宿主适配面（非规范附录）

- /dsh-skin/api/{skins, skins/:id, active, install, remove, generate, regenerate, export, config, workshop/*}、/dsh-skin/skins/<id>/files/* 是宿主传输层（webServer 路由），不是冻结契约；active 走 settings seam loopback（上游 WEB_SETTINGS_NAMESPACES 白名单缺口，见 ARCHITECTURE_AUDIT §1.6）。

## 12. Contract Gaps / Deferred Decisions

1. 实现名改名（tryOn→enter、switchSkin→switch、restoreDefault→restore、applySkin→apply）：Phase 2 候选（改名即行为等价重构 + A/B/D 回归）。
7. **H 证据驱动的契约澄清（已落地）**：链式 enter 的 exit 语义从「恢复上一次 enter 的快照」澄清为「恢复首次 enter 时的正式激活皮肤（基准）」——旧语义会让试穿态逃逸（无句柄、无持久、刷新才复位）；epoch 测试断言已同步（runtime.spec epoch 用例）。
2. ~~Skin Center 接线迁移到 SkinController 实现：Phase 4。~~ 已完成（run-008）。
3. skinApiVersion 多版本共存（>1 时按版本路由而非一律拒绝）：v1.x 后研究，须先过否决门。
4. RemoteRepository HTTP API（workshop 协议）冻结：v1.6+ 单独版本冻结，不提前进入本契约。
5. SkinRuntimeContext 扩展点新增规范（新副作用类型的登记 API）：出现真实需求时按 §8 不变量追加。
6. 结果协议与异常分类的全面统一（仓库层也抛 SkinError）：如需，走独立 hardening 版本，不在 Quality 线内混做。


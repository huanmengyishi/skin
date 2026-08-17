# Skin Center

> v0.2.0。皮肤中心 = 唯一入口（settings → 插件 → Skins 卡），完整画廊/详情/操作闭环。

## 职责边界

- UI 只经 **SkinRuntime 服务**（客户端）与 **host API**（/dsh-skin/*）操作；
- React 组件不直接触碰 filesystem / registry 文件 / loader / settings 文件；
- 视图逻辑（搜索/过滤/排序）是纯函数（src/client/center/selectors.ts），可独立单测。

## Gallery

- 卡片：preview 图（包内 preview/light）、name、id、source（builtin/installed）、version、描述、tags、active/try-on/状态徽标；
- 搜索：按空格分词，每词 AND 命中 id/name/author/description（忽略大小写）；
- 标签过滤：AND 语义，标签条来自全部皮肤去重；
- 来源过滤：内置 / 本地（可多选）；
- 排序：名称 / ID / 版本（近似 SemVer）/ 更新时间（包目录 mtime）；
- 刷新按钮：重新拉取 registry（配合 install/uninstall 后可见性）。

## Detail

- 大图预览（light/dark 切换）、作者、版本、更新时间、skinApiVersion、source、描述、标签、issues；
- 操作：Try On / Apply / Exit Try-on（试穿中）/ Restore Default（激活中）/ 卸载（installed 皮肤；内置拒绝）。

## host API（本阶段新增/使用）

- GET /dsh-skin/api/skins（含 updatedAtMs）；GET /dsh-skin/api/skins/:id（含 files.previewLight/Dark、updatedAtMs、rev）；
- POST /dsh-skin/api/install { sourceDir }、POST /dsh-skin/api/remove { id }（同源栅栏）；
- GET|POST /dsh-skin/api/active（loopback-only 的 activeSkin 读写，存储介质=官方 settings seam）；
- GET /dsh-skin/skins/:id/files/*（皮肤包文件，路径守卫 + symlink 拒绝）。

## 验证

- 单元：selectors 搜索/标签 AND/来源/排序/updated 格式化（6 用例）；运行时/仓库/上下文回归（52 用例全绿）；
- 真实 GUI E2E（隔离 DSH_HOME + 独立端口 + Playwright，4/4）：roster 物化 → 发现 → Try-on → 退出恢复 → Apply → 刷新保持 → 切换 → 恢复默认零残留 → 搜索/标签/来源/排序/详情预览 → API 安装 → 详情卸载。


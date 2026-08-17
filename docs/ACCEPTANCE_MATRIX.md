# dsh-skin 验收矩阵（ACCEPTANCE_MATRIX）

> 什么情况下算完成。每阶段进入下一阶段前必须对照本矩阵逐项打勾；证据落 D:\deepskin\图库\dsh-skin-test\run-NNN\。

## 0. 已通过的门（v1.0.0 / v1.0.1，证据固化）

| 门 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| A | 共存：安装进日常 profile、activeSkin=default、宿主启动/设置/主题/会话正常、settings.yaml 不被写入 | PASS | run-002 stage-ab-log A1~A5 |
| B | clean 全链：Apply→刷新→重启→仍在→Restore→干净，再两轮 Default↔clean | PASS | run-002 B1~B13 |
| C | gallery-01 真实安装：/api/install → skins/installed → Try-on→退出→Apply→刷新→重启→Restore | PASS | run-002 C1~C17 |
| D | 六连压力：Default→clean→gallery-01→clean→Default→gallery-01→Default，每次刷新，settings==runtime 一致 | PASS | run-002 D0~D8 |
| E | 真实对话保护：默认皮肤对话→切 clean 对话→刷新会话持久→恢复 Default | PASS | run-002 E1~E17 |

## 1. Phase 5 新增门（进入 v1.1.x 前必须全过）

| 门 | 内容 | 判定标准 | 状态 |
| --- | --- | --- | --- |
| F | repository recovery | 中途杀掉安装（staging 残留/registry 半写）后重启，仓库自动恢复一致（staging 清空或忽略、registry 可重建），无孤儿包 | **PASS（run-007）** |
| G | failed apply rollback | 注入一个 apply 必失败的皮肤（缺文件/坏 manifest），apply 失败后：当前皮肤保持原样、无残留样式/属性、activeSkin 不变 | **PASS（run-004）** |
| H | try-on race | 连续快速 enter(A)→enter(B)→exit 交错，最终状态=最后一次语义操作结果，无 A/B 样式并存、epoch 生效 | **PASS（run-005）** |
| I | crash recovery | apply 后强制杀进程（模拟崩溃），重启后 activeSkin 恢复且渲染正确；崩溃时 settings 文件不损坏 | **PASS（run-006，I1~I3a/I3b）** |
| J | malformed skin | 畸形包（缺 manifest/坏 JSON/坏 integrity/executable/zip-slip/远程 URL）install 全部拒绝且不留下半成品 | **PASS（run-007，14 类矩阵 + 真实实例）** |

## 2. residue 指标（Phase 2 起每次 e2e 必测，全部 = 0）

```text
DOM residue = 0       （装饰元素/皮肤节点）
CSS residue = 0       （style[data-dsh-skin-owner] 计数）
attribute residue = 0 （body 属性；restore 后瞬时空 style="" 已于 run-006 最小修复：dispose 后移除空属性，同页即零残留）
listener residue = 0  （addEventListener 对应清理）
observer residue = 0  （MutationObserver disconnect）
timer residue = 0     （setTimeout/setInterval clear）
```

## 3. 分阶段验收标准

### Phase 1 Skin Contract
- 七个契约类型/接口有文档且被 TS 编译锁定；validate(package) 对合法/非法矩阵全绿；契约文档评审通过。
- 无行为改动：85 个既有单元测试全绿。

### Phase 2 Skin Runtime
- 三条铁链全过（default→A→B→default；失败恢复 A；try-on B→exit→A）。
- 强化维度全过：Apply/Refresh/Restart/Restore/Switch/Failed Apply/Partial Apply/Double Dispose/Repeated Switch/Try-on Race。
- residue 六指标 = 0；run-002 的 style="" 专项有明确断言。

### Phase 3 Repository
- install/uninstall 每一步（validate/stage/integrity/commit/registry）失败注入 → rollback 生效。
- F、J 门通过；registry.json 与磁盘一致性校验工具存在。

### Phase 4 Skin Center
- **PASS（run-008）**：UI 层不 import 任何仓库/运行时实现细节（仅 SkinController 面，架构隔离测试锁定）；A/B/D 门复跑通过 + E2E-1..8 全绿 + E 真实对话复跑。

### Phase 5 E2E / Hardening
- **PASS（run-009）**：A~J + X1~X7 全过；Runtime Gate / Repository Gate / Controller-UI Gate 三通过；全部证据落 run-009。

### v1.1.x QUALITY（每项独立交付，按 Q 编号写 run-NNN）
- Q1：保真度指标定义文档 + 生成循环接入 + run-001 数据（diffRatio 0.00028 vs 参考图 90.77%）在新指标下可解释。
- Q2：真实图生成 colors.json 非空且色值与图一致（run-001 同图重跑对比）。
- Q3：spec 校验拒绝中文/非 CSS 串；codegen 输出通过 CSS 语法校验。
- Q4：theme.css 无 ;; 与重复片段；快照测试锁定。
- Q5：429 场景有退避/排队/可配 keyed 链，失败分类完整记录。

### v1.2~v1.4 AI 线
- v1.2：任意 3 张真实图 → spec 全部通过 schema 校验 + 人工图意核对记录。
- v1.3：同一 spec 两次构建字节级可复现；包契约 + CSS 语法 + 截图存在。
- v1.4：对参考图保真度指标下降（或收敛语义达成）跨 3 轮迭代有记录；修复 prompt 与 spec diff 落盘。

### v1.6~v1.7 Workshop
- 断网：本地皮肤全功能可用（回归 A/B/D 门）。
- 读写：search/get/download/install/publish/update 六接口全过，checksum/zip-slip/executable/remote-URL 安全门全过。

### v1.8 / v2.0
- 安全与兼容矩阵（Windows/上游版本矩阵）全过；生态文档（authoring/发布/治理）齐备。

## 4. 判定纪律

- 任何门 FAIL：记录 run-NNN/result.json 的 issues，回滚对应改动，不进入下一阶段。
- 禁止用“看起来还行”代替本矩阵指标；禁止以 Quality 问题为由重构冻结面（走否决门 + minor 版本升级流程）。

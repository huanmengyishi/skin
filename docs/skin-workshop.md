# Skin Workshop（网络共享，v0.5.0：读取/下载/安装）

网络层只负责 search / metadata / download；安装语义 100% 复用本地仓库管线（staging→校验→atomic），禁止直写 installed/。

## 远端协议 v1（自定，src/workshop/protocol.ts）

```text
GET  {endpoint}/skins?q=&tags=&sort=        → { skins: WorkshopSkinInfo[] }
GET  {endpoint}/skins/:id                  → WorkshopSkinInfo
GET  {endpoint}/skins/:id/versions         → { skinId, versions: [{version, checksum, size, createdAt, harnessCompatibility, skinApiVersion}] }
GET  {endpoint}/skins/:id/download?version= → zip（Skin Package 交换格式）
```

WorkshopSkinInfo：skinId/version/name/author/description/tags/category/preview/downloadCount/rating/createdAt/updatedAt/harnessCompatibility/skinApiVersion/license/checksum/packageSize。
checksum 是协议硬要求：缺失或不匹配一律拒绝安装（防下载损坏/篡改）；skinApiVersion 必须 = 1。

## 下载安装管线（src/workshop/install.ts）

下载 zip → sha256 校验 → zip-slip 安全解包（拒绝绝对路径/盘符/.. /反斜杠）→ 写 provenance（metadata/remote.json：remoteId/version/checksum/downloadedAt）→ integrity 重算 → repository.install(kind: downloaded)（覆盖更新走 replace 回滚）。任何失败零残留。

## host API

- GET|POST /dsh-skin/api/config { workshopUrl }（loopback 写；设置持久于 settings.yaml 的 dsh-skin 段）
- GET /dsh-skin/api/workshop/skins?q=&tags=&sort=、GET .../skins/:id、GET .../skins/:id/versions（含本地已装版本对照）
- POST /dsh-skin/api/workshop/download { skinId, version? }、POST .../update { skinId }（loopback；update 依据 remote.json 的 remoteVersion 与远端最新比对，经 replace 覆盖）

## 离线降级

- Workshop 未配置 / 不可达 → 浏览返回 offline 状态，UI 显式提示；本地皮肤（内置/本地/生成/已下载）完全不受影响（E2E 断言）。

## 验证

- 单元 76 例（workshop 8 例：协议校验、list/detail/versions/download、离线错误、zip-slip 矩阵、checksum 不匹配/缺失拒绝零残留、provenance+integrity、replace 更新）；
- 真实 GUI E2E-7（本地 mock 服务器）：配置 → 浏览 → 下载安装（downloaded 来源）→ 远端发新版 → 更新（1.0.0→2.0.0）→ 断网降级（本地皮肤照常）→ 卸载。


## 发布（v0.6.0）

发布管线（src/workshop/publish.ts）：本地包 → 四门校验（manifest 合法 / registry 状态 ok / integrity 复核 / runtime 形态）→ zip + sha256 → 上传。
上传失败绝不改动本地皮肤（发布只读本地、只发远端；E2E 断言上传失败后 manifest 原样、state 仍 ok）。

- 来源守卫：内置不可发布；downloaded 不可再发布（避免转售）；installed / generated 可发布。
- 远端协议新增：POST {endpoint}/skins {packageBase64, packageSha256, name, description, tags} → {skinId, version, checksum}；POST /skins/:id/versions；POST /skins/:id/report {reason}。
- host API：POST /dsh-skin/api/workshop/publish、publish-version、report（loopback；8MB 上限）。
- UI：installed/generated 详情增加 发布 / 发布新版本；在线皮肤条目增加 举报。
- 验证：单元 79 例（发布四门/来源守卫/上传零改动/远端 400 本地不变）；E2E-8（mock 远端记录上传：发布 → 上传 zip 可解包含正确 manifest → 发布新版本 → 举报落库 → 离线发布失败本地零改动）。

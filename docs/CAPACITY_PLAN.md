# 幂等响应缓存与容量阶段

更新时间：2026-10-10。上一稳定版本 `8cdbc05`；本阶段仅在商业版实现，汇报版不变。

## 当前范围与断点

本阶段已实现并通过本地联合验收，源码已冻结。迁移 004、缓存工具、API 接入、PGlite 与真实 PostgreSQL 测试、完整项目检查和浏览器验收均已完成；没有实施订阅或业务记录容量硬停。2026-10-10 只读复核已有报告并补全文档，没有把旧报告称为当日重新测试。

### 已确认的接口

- 原写入成功仍返回 `{data,revision}`；有效缓存回放继续返回原快照。
- 相同空间、相同 Idempotency-Key 和请求内容，响应已到期或压缩时，返回 200 当前快照，并增加 `idempotency:{replayed:true,responseExpired:true,committedRevision:number}`。绝不再次执行 action，也不新增 revision/审计/流水。
- 相同 key 不同请求仍返回 409 `IDEMPOTENCY_CONFLICT`。旧 key 检查先于 If-Match；过期回放不得伪装成“本次未保存”并换 key 重做。
- 仅压缩大 response。key/hash/committed_revision 长期保留，业务和审计不清除。

### 缓存规则

- 每空间最多 32 个完整响应、32 MiB 数据库 UTF-8 JSON 文本，回放最长 24 小时；预算可提前淘汰旧缓存。AppConfig.idempotencyCache 可注入更小值用于测试，不能调高这些硬上限。
- 新成功写入及回放在持有 workspace 行锁的事务中压缩缓存；超大单个快照仍可作为成功响应返回，但不会长期缓存。
- 启动及定时清理分批运行；每轮默认扫描至多 128 条候选、16 个空间，跳过正忙空间、不重叠运行，关闭先停止并等待清理再关闭数据库。
- 缓存到期由请求路径直接判断，不依赖定时清理是否已运行。定时清理是尽力及时回收，不能宣称响应到期时磁盘立刻缩小。
- 迁移从旧 response.revision 回填 committed_revision，旧 audit_event_id 留 NULL，不猜测关联。迁移重复执行不能重设 TTL 或复活已清空缓存。
- 一次性迁移会压缩历史超限/过期缓存。先备份、停止旧应用并部署支持 NULL response 的版本；压缩后不可回退到直接返回旧 response 的未兼容应用。

### 后端入口与实际存储字段

- `server/migrations/004_idempotency_cache.sql`：新增 `committed_revision`、`response_expires_at`、`response_bytes`、可空 `audit_event_id`；允许 `response=NULL`。初次回填及历史压缩后，二次启动不重写已存在元数据。
- `server/idempotency.ts`：`idempotencyPolicy` 验证配置；`compactWorkspaceResponses` 供已持工作空间锁的事务调用；`cleanupExpiredResponses` 供后台分批回收过期快照。
- `createApp` 提供 `app.locals.startIdempotencyCleanup()`、`runIdempotencyCleanup()`、`closeIdempotencyCleanup()`、`idempotencyCleanupStats`。创建 app 本身不开 timer；生产入口 `server/index.ts` 启动一次有界清理，之后默认每 60 秒触发一轮，关闭时先停止并等待当前清理，再关邮件和数据库。
- 缓存保留顺序按 `committed_revision DESC`，不用事务开始时间推测最后成功写入。单个响应超过预算时只保存去重凭据，首次业务成功响应仍正常返回。
- 日常后台每轮有界不代表首次历史数据迁移成本固定；004 首次需要回填已有 key 元数据并压缩超预算响应，发布前应备份并安排迁移时间。

## 明确未实施

- 不设置 100,000 次业务写入硬停，不限制现有业务对象数、不实现订阅计费。
- 元数据和审计仍随业务操作次数线性增长，当前阶段不能宣称整个数据库有固定大小。
- 下一独立阶段再确认并实测：六类业务对象合计 10,000 条候选上限、紧凑备份 4 MiB、上传 5 MiB、普通写入请求 64 KiB，以及旧空间超限时的读取/导出/修正行为。这些数值只是方案，尚未成为服务承诺。
- 前端紧凑 JSON 导出已在本阶段完成，普通样例的导出/空空间恢复已通过浏览器验收；接近 5 MiB 的往返边界及承诺业务规模验收仍留到下一阶段。
- PostgreSQL 文件、TOAST、索引和 WAL 占用与缓存 JSON 字节不同；生产仍需要磁盘监控和 autovacuum。没有配置云监控或自动生产备份。

## 实际验收与继续入口

2026-10-06 实际执行：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node --experimental-strip-types --test server/tests/idempotency.test.ts
git diff --check -- server docs/CAPACITY_PLAN.md
```

- TypeScript exit 0；15 passed / 0 failed / 0 skipped，约 10 秒；补丁格式检查通过。
- 已覆盖：配置硬上限、原响应回放、真实 HTTP 到期 200 当前快照、同 key 异内容冲突、空间隔离、清理与重复收款并发、条数和中文 UTF-8 字节预算、默认 32 条、超大单响应/零 TTL、分批清理、写锁兼容、去重插入失败事务全回滚、维护器不重叠与关闭等待、003→004 迁移及二次启动保持墓碑/时效。
- 默认测试采用 PGlite；`IDEMPOTENCY_TEST_DATABASE_URL` 可指定专用 PostgreSQL 测试库，缺省时也可复用 `RECOVERY_TEST_DATABASE_URL` 指定的测试库地址。每次创建独立 `yunji_idempotency_test_<32位随机十六进制>` schema，连接只设置该 search_path，结束只删除本次创建的随机 schema，不清 public。
- 迁移用例在 PostgreSQL 模式也创建第二个独立 schema，从 001–003 真正升级至 004 后重新打开两次；不是用 PGlite 结果代替原生数据库结果。
- 主代理于 2026-10-06 完成 `pnpm check`：构建与类型检查通过，**77 项全部通过**（13 个业务、22 个 API、8 个安全、19 个账号恢复、15 个幂等缓存；API 数量含父测试）。
- 原生 PostgreSQL 17.10 普通 owner 实测：API **22/22**、账号恢复 **19/19**、幂等缓存 **15/15** 通过；11 张表的 dump/restore 一致，`dumpRestorePassed / authStateRestorePassed / idempotencyStateRestorePassed` 均为 true，包含 `response=NULL` 的永久去重记录恢复。报告完成时间 `2026-10-05T16:16:27.565Z`（香港时间 10 月 6 日 00:16:27），`stopped / cleaned / mappingRemoved` 均为 true。
- 核心浏览器 **16/16** 通过，`errors=[]`，完成时间 `2026-10-05T16:25:29.001Z`。其中 400 元收款提交后模拟响应丢失，清理缓存后用同 key 回放确认没有重复记账；后续 600 元收款提交后模拟响应丢失，刷新确认已足额收款，不再发送重复 POST。
- 账号恢复浏览器 **9/9** 通过，`errors=[]`，完成时间 `2026-10-05T16:25:43.413Z`；使用隔离 fake mailer，不代表真实 SMTP 投递验收。
- 上述断网浏览器证据覆盖分次及足额收款，不代表已经验证全额退款或耗尽库存出库的断网回放场景；这些场景不能据本报告标记已通过。
- 证据：`.local/test-results/postgres-verification.json`、`postgres-api.log`、`postgres-recovery.log`、`postgres-idempotency.log`；`test-results/commercial/report.json`、`test-results/auth-recovery/report.json`。本阶段提交及远端 CI 由主代理统一处理，以 `COMMERCIAL_PROGRESS.md` 为准。
- 后端源代码已冻结，未自行提交 Git；检查点见 `server/BACKEND_CHECKPOINT.md`。

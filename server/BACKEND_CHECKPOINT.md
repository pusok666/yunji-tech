# 后端恢复入口

更新时间：2026-10-10。后端实现位于 `D:\云迹科技-商业化\server`，方案记录位于本项目 docs；未修改汇报版。幂等响应缓存阶段已通过完整检查、真实 PostgreSQL 与浏览器联合验收，源码冻结；本日仅复核已有报告并补写检查点，没有重新执行上述测试。尚未声称真实 SMTP 投递或云端商业生产验收通过。

## 入口与约定

- `index.ts`：Node 24 原生 TypeScript 启动；默认 `127.0.0.1:4100`。
- `app.ts`：导出 `createApp({db,config,mailer?})`；config 包含 appOrigin、production、inviteCode、sessionTtlMs、authRateLimit、trustProxy、staticDir、smtp、requireVerifiedEmail 和邮件队列/时限参数。可注入 fake mailer；`app.locals.drainMail()` / `closeMail()` 供测试及退出清理。
- `db.ts`：导出 `openDatabase({dataDir?,url?})`，query / transaction / close / engine。
- 默认开发库 `.local/database`，`:memory:` 可用于测试，设置 `DATABASE_URL` 切换 `pg`。
- 生产入口拒绝缺少独立 PostgreSQL、HTTPS APP_ORIGIN、至少 16 字符 INVITE_CODE 或完整 SMTP 的配置，强制邮箱验证。TRUST_PROXY=1 仅在受控单层反向代理后使用。
- 001 建表迁移；002 增加稳定流水 sequence 和审计 before_state / after_state；003 增加邮箱验证、凭据版本、auth_tokens 和 auth_request_limits；004 增加幂等凭据元数据并允许压缩 response。启动依编号顺序执行幂等迁移；PostgreSQL 迁移使用 advisory lock。

## 实现内容

- 12–128 字符密码，随机盐 scrypt；随机会话令牌仅保存 SHA-256，Cookie HttpOnly / SameSite=Lax / 生产 Secure；Origin 与 CSRF 双检验，过期/退出会话拒绝。
- 改密码原子更新并撤销其他会话；并发慢登录重新核对数据库散列，不能在改密后用旧散列生成会话。
- 每个账号独立工作空间，所有实体、流水、快照、备份和审计均按服务端会话 workspace_id 查询。
- 客户、订单、商品、人工收支 CRUD；关联删除保护；所有金额以分运算、拒绝非法小数和 tiny 正数。
- 独立收款/退款，退款关联原收款并限制可退余额。订单已收由流水净额维护，不能直接改。期初库存留痕；后续库存只通过流水变更，校验日期顺序和任一时点负库存。
- workspace 行锁 + revision 乐观并发；幂等 key 与请求散列绑定，有效缓存返回原结果，缓存到期/压缩后返回当前快照及原操作已完成标记，不重新执行业务。业务变更、流水、审计、revision 与去重记录同一事务；PGlite 对整个事务串行，防请求误入同一事务。
- 备份不含账号密钥，仅允许恢复到空空间；服务端完整关联/金额/流水校验后原子恢复。同日流水保留插入顺序，恢复后可以继续出库。
- 审计接口保留原字段，新增 `before` / `after` 业务摘要；不含客户联系方式和认证秘密。
- 规则 AI 从当前授权空间数据计算；前端 context 忽略。统一现金流入、现金流出（含退款）、收支结余，退款/经营支出分列，按实际流水日期。
- 登录/注册/改密限流，JSON 5 MB 限制，安全错误响应不带 SQL/堆栈，生产静态资源安全响应头。

## 实际验证记录

2026-10-04 在独立商业化目录执行：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node --experimental-strip-types --test tests/api.test.mjs server/tests/hardening.test.ts
```

- TypeScript：exit 0，无错误。
- 组合测试：30 passed / 0 failed（包含 1 个父测试；21 个业务验收子项 + 8 个独立安全/持久化项），约 11.4 秒。
- 验证覆盖：身份与跨空间隔离、CSRF/Origin、并发版本冲突、重复提交、收退款、库存与回溯负库存保护、恢复后再次出库、审计前后摘要、坏备份原子拒绝、改密撤销旧会话、生产失败关闭、密码/令牌散列、限流、坏 JSON/超限请求、数据库关闭重开持久化。
- 首轮测试 fixture 使用中文邮箱 local part，与前端/服务端邮箱规则不一致；由 root 修改为 ASCII 测试邮箱。库存 fixture 改为当前期初日期。业务断言未放松。
- 修复的实质错误：跨模块 never 箭头函数导致 TS 不收窄；pg rowCount nullable；pg 迁移失败路径先 release 后 pool.end；恢复后同日流水排序；金额精度容差；改密与登录竞态。

## 原生 PostgreSQL 验收补充（2026-10-04）

- 使用 `.local/pg-native-tools` 中独立下载的原生 PostgreSQL 17.10，非 PGlite，未注册 Windows 服务。
- 仅监听 `127.0.0.1:55439`。应用验收使用专用 `NOSUPERUSER / NOCREATEDB` 数据库 owner；随机口令仅保留于内存、子进程环境及初始化命名管道。
- `node --experimental-strip-types scripts/test-postgres.mjs` 中真实 pg 驱动 API 验收：22/22 通过；生产 createApp 配置、健康接口和 HSTS 检查通过。
- Windows 原生 PG 在中文绝对路径初始化发生编码失败，脚本临时将本项目 `.local` 映射到未使用 ASCII 盘符，数据仍位于商业目录。每次结束核验 PID 与数据目录后停库、清理本次 run 目录，再核对映射目标并移除自身映射。
- 最终运行时间：2026-10-04 12:39:05–12:40:25（香港时间）。脚本 exit 0，真实 PostgreSQL API 22/22 通过，`apiPassed / normalRole / productionConfigPassed / dumpRestorePassed` 全部为 true。
- `stopped=true / cleaned=true / mappingRemoved=true`：已停本次 PG、清理仅本次 run 集群目录、移除自己创建的 Z: 映射。工具包和验收报告保留在 `.local`。
- 客户端工具采用 EDB 官方 `postgresql-17.11-4-windows-x64-binaries.zip`，运行版本 `pg_dump (PostgreSQL) 17.11`。下载源：`https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64-binaries.zip`；本地 SHA256 与维护者在 `https://github.com/EnterpriseDB/edb-installers/issues/706` 发布值一致：`b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28`。只提取 bin 到 `.local/pg-client-tools/pgsql/bin`，未执行安装器。
- 使用 `pg_dump --format=custom --no-owner` 导出验收库，`pg_restore --exit-on-error --no-owner` 恢复到同一隔离集群中的第二个空库；两库 9 张核心表计数、收退款净额、库存变动汇总完全一致。
- 恢复核对结果：users=4、workspaces=4、sessions=4、records=12、receipts=6、stock_movements=5、audit_events=13、idempotency_keys=12、schema_migrations=2；测试数据跨工作空间收退款净额合计 1800 元，库存变动净数量 13。
- 原始证据：`.local/test-results/postgres-api.log` 与 `.local/test-results/postgres-verification.json`。本次只验证数据库恢复操作，没有配置生产定时备份或云端灾难恢复。

## 邮箱验证与密码恢复阶段（2026-10-05）

### 落盘实现与安全边界

- `mail.ts`：可注入 Mailer、Nodemailer SMTP、队列默认最多 100 项/并发 2、默认总超时 15 秒。465 直接 TLS，其他端口要求 STARTTLS，证书校验和 TLS 1.2 下限；禁止邮件模板读取文件/URL、禁用 SMTP debug/logger。
- `recovery.ts`：随机 32 字节令牌仅存 SHA-256，绑定账号、用途、邮箱及 credential_version；验证默认 24 小时、重置默认 30 分钟。账号行锁先于令牌锁，同令牌或同账号不同令牌并发恢复最多一个成功。
- `003_account_recovery.sql` 保留旧账号密码与全部经营记录，旧账号邮箱默认未验证。没有重建用户数据；本地无 SMTP 仍可正常注册与使用业务。
- 注册成功后邮件未排队返回 `emailDelivery: unavailable`，未配置返回 `disabled`，接受队列返回 `queued`，不会把接受任务宣称为送达。公开找回对未知账号、冷却和队列满统一 202。
- 重置成功递增凭据版本、确认邮箱归属、撤销该账号全部旧会话和其余令牌。**reset 响应不发送 Set-Cookie，也不撤销其他账号会话**；避免晚到响应清除新登录 Cookie。普通改密在事务内重新确认当前会话有效，保留当前会话并撤销其他会话与恢复令牌。
- 公开令牌接口仍校验固定 Origin；验证重发需要登录和 CSRF；未验证账号由服务端阻止业务 API。会话增量字段和完整契约见 `docs/AUTH_RECOVERY_PLAN.md`。
- 发送失败/超时只作废新令牌，不影响旧有效邮件。已注销会话排队中的验证任务在执行时拒绝创建令牌/发送邮件。发送回写不会取消已消费或已撤销状态。
- 非持久队列中断遗留 pending 在下次申请、持有账号锁时回收：须超过 `max(mailTimeoutMs + 60000, 75000)` 毫秒；已发送和窗口内正在发送的记录保留。默认须等待至少 75 秒，并继续遵守邮箱冷却。
- 无原始令牌、完整链接、密码或 SMTP 凭据日志。本阶段全部邮件来自测试内存 fake transport，没有给真实邮箱发信。

### 实际执行与恢复入口

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node --experimental-strip-types --test server/tests/recovery.test.ts server/tests/hardening.test.ts tests/api.test.mjs
```

- 2026-10-05 最终执行：TypeScript exit 0；**49 passed / 0 failed**，约 13 秒（19 个 recovery、8 个 hardening、22 个 API，API 数量含 1 父测试）。先前 45 项通过记录属于增加身份/排队/中断边界测试前的阶段结果。
- 恢复测试覆盖：无 SMTP 本地兼容、生产失败关闭、未验证闸门、Origin/CSRF/伪造账号、令牌散列/用途/邮箱快照/到期/单次消费、同令牌/同账号多令牌并发、旧密码和会话撤销、跨账号会话保持、晚到 reset 响应、新登录会话保持、普通改密撤销旧链接、发送失败/总超时、队列满、并发冷却、孤立 pending 回收、注销后排队任务拒绝、003 升级保数据。
- `server/tests/recovery.test.ts` 默认 PGlite。设置 **RECOVERY_TEST_DATABASE_URL** 指向专用测试 PostgreSQL 后，fixture 自动创建 `yunji_recovery_test_<32位随机十六进制>` schema，以连接 `options=-c search_path=...` 限定所有迁移及请求。结束核验前缀/随机格式后只 DROP 此次创建的 schema，不清 public，不复用 API fixture 的数据。
- 邮箱阶段随后由主代理提交推送至 `8cdbc05`；新增恢复并发已在原生 PostgreSQL 运行，账号恢复浏览器也已实际执行。最近一次包含本阶段的联合验收结果列于下节，不以 2026-10-04 的核心报告代替。
- 若额度再次中断：先读本检查点、方案和 `COMMERCIAL_PROGRESS.md`，保留现有未提交改动，先检查最新联合验收结果再继续；提交由主代理统一处理。

## 幂等响应缓存阶段（2026-10-06）

- 上一稳定断点为主代理已提交推送的 `8cdbc05`。本阶段源码已冻结但未由本代理提交 Git；仅新增缓存压缩，没有引入业务总条数或累计写入硬停、订阅计费。
- 新文件：`server/idempotency.ts`、`server/migrations/004_idempotency_cache.sql`、`server/tests/idempotency.test.ts`；设计和约束见 `docs/CAPACITY_PLAN.md`。`app.ts / business.ts / index.ts` 已接入，hardening 迁移版本断言更新为 1–4。
- 每空间缓存最多 24 小时、32 个完整响应、32 MiB 数据库 UTF-8 JSON 文本。`AppConfig.idempotencyCache` 可注入更小预算/时效；超过硬上限的配置启动失败。单个响应超过预算仍成功处理业务，但只保存去重凭据。
- `key / request_hash / committed_revision` 长期保存；清理只将 response 设为 NULL、response_bytes 归零，不删除 key、审计或业务流水。新凭据的 audit_event_id 指向本次同事务审计，旧凭据不猜测关联。
- 在 workspace 行锁内先查旧 key/hash，之后才对新请求检查 If-Match。缓存有效时回放原响应；过期/压缩后返回 200 当前 Snapshot 与 `idempotency:{replayed:true,responseExpired:true,committedRevision}`，不执行 action、不增加 revision/审计/收款。相同 key 不同请求仍 409。
- 004 基于旧 created_at / response.revision 回填，首次迁移压缩历史超预算/过期快照；二次启动不重设时效、不会复活 NULL 响应。旧应用不理解 NULL，发布/回退必须使用兼容版本。
- 日常清理默认每轮至多 128 条候选、16 空间，跳过忙空间且不重叠；`index.ts` 启动触发并每 60 秒运行，退出先 await `closeIdempotencyCleanup()` 再关 mail/db。createApp 本身只提供启动/单轮/关闭 hook，不自动创建 timer。第一次升级历史数据的元数据回填并非固定成本，须单独安排迁移窗口。
- 2026-10-06 实际执行：服务端 tsc exit 0；`node --experimental-strip-types --test server/tests/idempotency.test.ts` **15/15 通过，无 skipped**，约 10 秒；`git diff --check -- server docs/CAPACITY_PLAN.md` 通过。
- 验证包括真实 HTTP 回放、并发清理与重复收款仅一次、跨空间隔离、条数/字节预算、零 TTL/超大单快照、后台批次和关闭、去重插入失败原子回滚、003→004 旧数据和二次 reopen。默认运行 PGlite；`IDEMPOTENCY_TEST_DATABASE_URL`（或 RECOVERY_TEST_DATABASE_URL）在专用 PostgreSQL 中创建随机独立 schema 跑同套测试，实际 PG、全项目和浏览器结果如下。
- 主代理 2026-10-06 完成 `pnpm check`：构建、类型检查及 **77 项测试全部通过**（业务 13、API 22、安全 8、账号恢复 19、幂等缓存 15；API 数量含父测试）。
- 原生 PostgreSQL 17.10 普通 owner：API **22/22**、recovery **19/19**、idempotency **15/15** 通过。生产配置检查通过；11 表 dump/restore、认证状态恢复、幂等状态恢复均通过，包含 `response=NULL` 的永久 key。报告 `finishedAt=2026-10-05T16:16:27.565Z`，停止、清理测试集群及移除映射均成功。
- 本次恢复核对：users=4、workspaces=4、sessions=4、records=12、receipts=6、stock_movements=5、audit_events=13、idempotency_keys=12、schema_migrations=4、auth_tokens=4、auth_request_limits=1；收退款净额合计 1800 元、库存变动净数量 13。证据为 `.local/test-results/postgres-verification.json` 及同目录 API/recovery/idempotency 日志。
- 核心浏览器 **16/16**、`errors=[]`，报告完成 `2026-10-05T16:25:29.001Z`：包含 400 元收款提交后响应丢失、缓存过期后同 key 安全回放，以及后续 600 元收款响应丢失、刷新确认足额到账后没有重复 POST。全额退款和耗尽库存出库的断网回放没有在这份浏览器报告中验收，不得据此宣称已通过。
- 账号恢复浏览器 **9/9**、`errors=[]`，报告完成 `2026-10-05T16:25:43.413Z`；验证清除 fragment 令牌、确认邮箱、跨浏览器重置和旧会话处理，仍使用 fake mailer。浏览器证据为 `test-results/commercial/report.json` 与 `test-results/auth-recovery/report.json`。这些 UTC 时间均对应香港时间 10 月 6 日凌晨。
- 前端紧凑 JSON 备份导出已完成，普通样例导出/空空间恢复通过；接近 5 MiB 边界的往返、支持业务规模及云端资源压力尚未验收。完整去重/审计元数据仍线性增长，不将缓存预算表述为数据库总量上限。
- 2026-10-10 仅更新本检查点及 `docs/CAPACITY_PLAN.md`，未改后端源码；本阶段提交与远端 CI 由主代理收尾，具体提交号以 Git 和总进度为准。
- 断点恢复：先核对总进度中的联合验收结果，保留根目录及前端代理修改；若新测试失败只修具体问题，不重新初始化任何用户数据库，不回退到不兼容 NULL response 的旧版本。

## 未完成与真实边界

- 已验证本机原生 PostgreSQL 17.10；尚未验证真实云数据库网络、TLS 和云平台备份。设置专用 TEST_DATABASE_URL 可复用 `tests/api.test.mjs`，不可指向生产库。
- 目前一个 owner 对应一个空间，没有成员邀请/多角色、订阅计费、支付回调、真实 LLM；需要后续阶段。邮箱验证/密码找回后端已实现，真实 SMTP TLS、发信身份与实际收件仍待用户配置资源后验证。
- 登录限流为单进程内存计数；邮箱恢复冷却/窗口使用数据库原子更新。多实例部署仍需统一登录/IP限流存储和可靠代理设置。
- 邮件队列不持久化，没有自动投递重试或必达保证；发信失败可重新申请，进程中断须遵守上文遗留令牌回收窗口。没有配置生产邮件监控或数据库令牌定期归档。
- 幂等完整响应已受时效/条数/字节预算控制；去重凭据和审计仍随业务操作线性增长，没有设定整个数据库固定容量。实际数据库文件、TOAST、索引和 WAL 占用需生产监控；清空 JSONB 不保证磁盘文件立即缩小。
- 工作空间导出只恢复经营数据；账号、完整审计、会话和去重记录的灾难恢复需数据库级备份，并实际演练。
- JSON 导入最大 5 MB，单数组结构校验最多 20000 条。大规模业务需要分页接口与分批导入，不应把当前快照方案当作已完成扩容。
- 本轮冻结后端源代码，后续如改动，需重跑相应检查并更新本文件。Git 提交由 root 统一执行。

## 请求大小限制 · 2026-10-10

解析 JSON 前按实际字节限制：普通 API 64 KiB；POST /api/assistant 2 MiB；POST /api/restore 5 MiB。接口大小写、结尾斜杠及查询参数按实际路由处理；其他方法和相似前缀不会获得较大限额。

超限返回 413，保留兼容错误码 BODY_TOO_LARGE，并增加 limitBytes。拒绝发生在业务写入前。助手额外预算兼容现有最长合法 history，包括 Unicode 转义；没有降低字段校验或恢复校验要求。

本轮 pnpm check 通过：13 业务 + 22 API + 11 安全 + 19 恢复 + 15 幂等，共 80 项，构建与双端类型检查通过。新增测试验证普通 64 KiB 精确边界、恢复 5 MiB 精确边界/超限不写入、助手最长合法历史及超限不修改数据。浏览器和本阶段远端测试仍以最终报告为准。

请求大小阶段最终浏览器回归：经营16/16、邮件9/9，errors=[]；报告结束分别为 2026-10-10T15:47:49.563Z、2026-10-10T15:48:05.117Z。80项检查、构建与双端类型检查均通过。当前阶段远端CI待对应提交验收。

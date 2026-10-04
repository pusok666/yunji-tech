# 后端恢复入口

更新时间：2026-10-04。所有改动仅在 `D:\云迹科技-商业化\server`，未修改汇报版。此阶段代码已通过本地后端验收，尚未声称云端商业生产验收通过。

## 入口与约定

- `index.ts`：Node 24 原生 TypeScript 启动；默认 `127.0.0.1:4100`。
- `app.ts`：导出 `createApp({db,config})`；config 包含 appOrigin、production、inviteCode、sessionTtlMs、authRateLimit、trustProxy、staticDir。
- `db.ts`：导出 `openDatabase({dataDir?,url?})`，query / transaction / close / engine。
- 默认开发库 `.local/database`，`:memory:` 可用于测试，设置 `DATABASE_URL` 切换 `pg`。
- 生产入口拒绝缺少独立 PostgreSQL、HTTPS APP_ORIGIN 或至少 16 字符 INVITE_CODE 的配置。TRUST_PROXY=1 仅在受控单层反向代理后使用。
- 001 建表迁移；002 增加稳定流水 sequence 和审计 before_state / after_state。启动依编号顺序执行幂等迁移；PostgreSQL 迁移使用 advisory lock。

## 实现内容

- 12–128 字符密码，随机盐 scrypt；随机会话令牌仅保存 SHA-256，Cookie HttpOnly / SameSite=Lax / 生产 Secure；Origin 与 CSRF 双检验，过期/退出会话拒绝。
- 改密码原子更新并撤销其他会话；并发慢登录重新核对数据库散列，不能在改密后用旧散列生成会话。
- 每个账号独立工作空间，所有实体、流水、快照、备份和审计均按服务端会话 workspace_id 查询。
- 客户、订单、商品、人工收支 CRUD；关联删除保护；所有金额以分运算、拒绝非法小数和 tiny 正数。
- 独立收款/退款，退款关联原收款并限制可退余额。订单已收由流水净额维护，不能直接改。期初库存留痕；后续库存只通过流水变更，校验日期顺序和任一时点负库存。
- workspace 行锁 + revision 乐观并发；幂等 key 与请求散列绑定，重复返回原结果。业务变更、流水、审计、revision 与去重记录同一事务；PGlite 对整个事务串行，防请求误入同一事务。
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

## 未完成与真实边界

- 已验证本机原生 PostgreSQL 17.10；尚未验证真实云数据库网络、TLS 和云平台备份。设置专用 TEST_DATABASE_URL 可复用 `tests/api.test.mjs`，不可指向生产库。
- 目前一个 owner 对应一个空间，没有成员邀请/多角色、邮箱验证/邮件找回密码、订阅计费、支付回调、真实 LLM；需要后续阶段。
- 登录限流为单进程内存计数。多实例部署需统一限流存储和可靠代理设置。
- 幂等响应保留完整快照，适合小规模受邀试用；长期运行需明确幂等保留窗口、归档与数据库增长监控。
- 工作空间导出只恢复经营数据；账号、完整审计、会话和去重记录的灾难恢复需数据库级备份，并实际演练。
- JSON 导入最大 5 MB，单数组结构校验最多 20000 条。大规模业务需要分页接口与分批导入，不应把当前快照方案当作已完成扩容。
- 本轮冻结后端源代码，后续如改动，需重跑相应检查并更新本文件。Git 提交由 root 统一执行。

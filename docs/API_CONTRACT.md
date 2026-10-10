# 商业化基础版接口契约（含账号邮件恢复）

前端 5174，同源 `/api` 代理至 127.0.0.1:4100。所有路由使用 JSON；日期 `YYYY-MM-DD`、CNY 金额对外元、业务计算使用整数分；禁止 NaN、无限值、超过两位小数。当前经营日期、周/月/年边界统一按 `Asia/Shanghai`，前端用日期字符串和 UTC 日历算术保持跨时区一致；审计时间戳在界面按北京时间显示。

## 身份

- `POST /api/auth/register`：`{email,password,name,workspaceName,inviteCode?}`，创建独立空间。生产邀请开通受服务端邀请码约束。
- `POST /api/auth/login`：`{email,password}`。
- 上两者与 `GET /api/auth/session` 返回 `{user:{id,email,name,emailVerified},workspace:{id,name,role:'owner'},csrfToken,auth:{emailEnabled,verificationRequired}}`。未登录 session 返回 401。
- 注册成功返回 201，并增加 `emailDelivery:'queued'|'disabled'|'unavailable'`。queued 仅表示排队申请已接受；disabled 表示未配置邮件；unavailable 表示账号已创建但本次邮件未能排队，不能把它显示为注册失败。
- `POST /api/auth/logout` 返回 `{ok:true}`。
- `POST /api/auth/password`：`{currentPassword,newPassword}`，需要 CSRF，更新后保留当前会话，其他会话及未消费的恢复/验证令牌失效。
- 密码长度为 12–128 个字符。会话使用 HttpOnly Cookie `yunji_commercial_session`，不使用 localStorage 登录标记。
- 所有 POST 校验 Origin；注册、登录和下表的公开令牌/找回接口不要求已有会话。登录后的写请求（包括退出、修改密码、验证重发）必须有 `X-CSRF-Token`。

## 邮箱验证与密码找回

| 接口 | 请求、认证与响应 |
| --- | --- |
| `GET /api/auth/capabilities` | 公开；返回 `{emailEnabled,verificationRequired}`，不暴露 SMTP 配置。 |
| `POST /api/auth/verification/request` | 当前会话 + CSRF，body `{}`；只给当前账号邮箱申请验证。202 `{ok:true,emailDelivery:'queued'}`。 |
| `POST /api/auth/verification/confirm` | 公开，body `{token}`；200 `{ok:true}`。确认邮箱归属，不自动创建登录会话。 |
| `POST /api/auth/password/forgot` | 公开，body `{email}`；正常受理返回 202 `{ok:true,message:'如果该邮箱已注册，我们会发送密码重置邮件。'}`。账号不存在、邮箱冷却中等情况使用相同响应。 |
| `POST /api/auth/password/reset` | 公开，body `{token,newPassword}`；200 `{ok:true,relogin:true}`。撤销目标账号全部旧会话和剩余恢复/验证令牌，同时标记该邮箱已验证。 |

- 未配置 SMTP 时 `emailEnabled=false`，邮件接口返回 503 `EMAIL_NOT_CONFIGURED`，不会伪造发送成功。本地默认不强制邮箱验证，原有注册登录业务可用。
- 生产环境强制 `verificationRequired=true`。未验证账号仍可读取 session、退出、修改密码和申请验证；业务接口由服务器返回 403 `EMAIL_NOT_VERIFIED`，前端先展示验证引导，不请求业务快照。
- 验证和重置链接固定由服务端 `APP_ORIGIN` 构造，分别为 `/#/verify-email?token=...` 与 `/#/reset-password?token=...`。令牌只放 fragment；前端读取后立即清理地址栏，只保留于当前页面内存。GET 打开链接不消费令牌，用户点击确认或提交新密码才 POST。
- 默认邮箱验证链接有效 24 小时，重置链接有效 30 分钟；令牌单次使用，并绑定用途、邮箱和凭据版本。数据库只存令牌散列。
- reset 成功不发送 `Set-Cookie`，不影响请求期间后来登录的其他账号 cookie；只撤销目标账号数据库会话。前端按会话世代清理旧身份并要求重新登录，不自动登录邮件所指账号。
- 进程内邮件队列不保证持久投递。queued/202 不等于到达；重启、失败或队列繁忙后，用户需在冷却期后重新申请。SMTP 失败不回滚账号创建，不破坏其他仍有效的链接。

| HTTP / code | 含义 |
| --- | --- |
| 503 `EMAIL_NOT_CONFIGURED` | 全局邮件功能未配置。 |
| 403 `EMAIL_NOT_VERIFIED` | 当前账号需验证邮箱后才能使用业务接口。 |
| 400 `AUTH_TOKEN_INVALID` | 令牌无效、过期、已消费、被撤销或用途不符，统一提示重新申请。 |
| 429 `RATE_LIMITED` | 请求过于频繁；已登录重发可明确提示，公开找回的邮箱冷却仍统一返回 202。 |
| 503 `MAIL_QUEUE_BUSY` | 已登录验证重发暂时无法入队。 |

## 业务快照与写入

- `GET /api/data` 返回 `Snapshot = {data:BusinessData,revision:number}`。
- 保留当前四个数组及实体字段。`BusinessData.version=1`（接口格式版本），新增始终存在的 `receipts:Receipt[]`、`stockMovements:StockMovement[]`，不从订单再次派生收款。
- `Receipt={id,orderId,type:'收款'|'退款',amount,date,notes,receiptId?:string}`；退款必须关联原收款，不能超过该原收款可退余额。订单 `paidAmount` 由流水净额派生，前端不能修改它。
- `StockMovement={id,productId,delta,date,notes}`。库存创建时可提交期初 stock，由服务端建立期初流水；以后变更只能使用库存流水接口。
- `PUT /api/records/:kind/:id`：`{value:Entity}`，创建或编辑四类实体（customers/orders/products/transactions）；路径 ID 必须匹配，新增订单 paidAmount 必须为 0。
- `DELETE /api/records/:kind/:id`：删除无历史/关联的记录。有收款订单、有库存流水商品及有关联订单客户不能删除。
- `POST /api/orders/:id/payments`：Receipt 对象，创建独立收款/退款。已取消订单不能新增收款；有未退余额不能取消。金额变更不能小于已收净额。
- `POST /api/products/:id/stock-movements`：StockMovement 对象，禁止负库存、零变动，理由必填。
- 所有业务写入必须携带 `If-Match: "<revision>"`、`Idempotency-Key: <随机唯一ID>` 和 CSRF。新写入返回最新 Snapshot。尚未成功提交的新请求版本不符返回 409；已成功的同 key、同内容请求按下面规则回放，不重复写入；同一 key 不同请求返回 409 `IDEMPOTENCY_CONFLICT`。
- 原子性：业务记录、流水、操作审计、快照版本与去重记录在同一数据库事务内。按当前会话 workspace_id 限定所有查询，不能信任前端 workspace_id。
- `GET /api/audit` 返回 `{events:[{id,action,entityKind,entityId,createdAt}]}`，按空间读取。

### 永久去重与有限响应缓存

- `idempotency_keys` 按 workspace + key 隔离。key、request_hash、committed_revision 长期保留，不能为节省快照空间而删除去重凭据。
- 只限制完整 `response` 缓存：每空间最长 24 小时、最多 32 条、合计最多 32 MiB，字节按数据库 UTF-8 JSON 文本计算；预算可使缓存提前清理。这些限制不针对经营记录数量或工作空间业务容量。
- 命中仍有效缓存时返回原 Snapshot，可不带额外字段。原 response 已到期或被压缩时，返回 HTTP 200 当前 Snapshot，并附 `idempotency:{replayed:true,responseExpired:true,committedRevision:number}`；`committedRevision` 是原操作提交版本，顶层 `revision` 是当前快照版本。不得再次执行业务 action，也不得新增流水、审计或版本。
- 清理仅将 response 置空并清零 response_bytes；后台分批回收与写入使用同空间事务锁，定时清理不是删除旧 key 的任务。
- 客户端沿用 sessionEpoch 与 revision 保护接收快照，回放成功提示「该操作此前已完成，已刷新当前数据」，不能误当 409 或自动换 key 再写一次。
- 网络或 5xx 后，收退款/出入库弹窗提供「刷新并保留输入」。当前授权服务器快照中已有同 intent ID 的不可变流水时，逐项比较实际提交字段（含规范化说明、退款原收款 ID、库存带符号数量）：完全相同只确认完成，不再 POST；任意不同拒绝再次提交并保留输入。没有同 ID 则保留原余额/库存校验，以原请求键重试。
- 未确认请求只留在当前页面内存；经营数据刷新保留，账号退出/切换清理，不提供跨整页重载或离线持久重试队列。

## 备份与 AI

- `GET /api/backup` 返回 `{format:'yunji-commercial-backup',version:1,exportedAt,data,revision}`，只含当前空间经营数据，不含账号、会话、密钥。
- 前端导出紧凑 JSON，保留以上 schema；导入仍限制 5 MiB，不保证任意规模的导出均可导回。没有实现每空间 10,000 条/4 MiB 之类业务硬容量限制。
- `POST /api/restore` body 为上面的备份，需要版本/去重/CSRF，只允许恢复到空工作空间；服务端完整验证关联、金额、流水和期初库存，原子恢复。
- `POST /api/assistant`：`{question,history?:[{role,content}]}`。从当前用户服务器数据计算回答，禁止相信浏览器传入 context。返回 `{answer,mode:'rules'|'llm'}`；暂未配置真实模型时明确标注规则模式。
- 错误返回 `{error:string,code?:string}`，不泄露栈、SQL、密码、其他空间信息。

## 本地与生产

服务端 Node 24 + Express 5，开发数据库使用本目录 `.local/database` 的 PGlite；有 DATABASE_URL 时使用 pg 驱动。生产必须显式配置 APP_ORIGIN、邀请口令、HTTPS、独立 PostgreSQL 和完整 SMTP，并强制邮箱验证。迁移保存于 server/migrations；003 增加账号邮箱验证状态、凭据版本、`auth_tokens` 与 `auth_request_limits`，不重新初始化原有账号与经营数据。不得向汇报版导入数据，不使用其 localStorage 键及端口。

004 迁移增加提交版本、响应到期时间/字节数与可空审计关联，并允许 response=NULL；首次回填历史去重凭据并压缩超预算缓存。升级前停止旧应用并备份数据库，禁止让不支持该结构的旧应用继续写入或直接回退旧镜像。

服务端导出 `createApp({db,config,mailer?})`；数据库导出 `openDatabase({dataDir?,url?})`，包含 query/transaction/close。config 包含 appOrigin、production、inviteCode，以及 smtp / requireVerifiedEmail 等配置。测试注入内存 fakeMailer，不使用真实收件人；配置和真实投递验收要求见 OPERATIONS.md。

`pnpm test:idempotency` 覆盖去重回放、缓存条数/字节、并发与 003→004 迁移。默认隔离 PGlite；指定 `IDEMPOTENCY_TEST_DATABASE_URL`（缺省可继承 `RECOVERY_TEST_DATABASE_URL`）时，在专用 PostgreSQL 测试库创建随机独立 schema 并仅清理自己的 schema，不清 `public`。本轮新增 15 项在 PGlite 和原生 PostgreSQL 17.10 均通过；完整 check 共 77 项通过，经营浏览器 16/16、账号恢复浏览器 9/9 最终回归通过，非预期错误列表均为空；远端 CI 待最终提交验收。

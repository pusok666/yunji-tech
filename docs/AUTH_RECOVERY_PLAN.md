# S4 前置：邮箱验证与密码找回实现方案

更新时间：2026-10-05。

## 当前状态与恢复入口

**后端已按本方案实现，正在完成前后端联合验收。** 后端包含增量迁移、邮件适配器、账号验证/恢复接口和隔离测试；真实 SMTP 投递尚未验证。最终完成状态及检查结果以 `COMMERCIAL_PROGRESS.md` 和 `server/BACKEND_CHECKPOINT.md` 为准。

- 实施目录仅为 `D:\云迹科技-商业化`，禁止修改 `D:\云迹科技` 汇报版。
- 开始前阅读 `COMMERCIAL_PROGRESS.md`、`docs/API_CONTRACT.md`、本文件和 `server/BACKEND_CHECKPOINT.md`，检查 Git 状态并保留所有现有改动。
- 此阶段只增加账号验证与恢复，不增加收费、支付或团队权限。
- 现有账号、工作空间、客户、订单、资金与库存流水必须保留，不重新初始化数据库。
- 每阶段实现、实际测试结果和剩余问题写入检查点，主代理统一提交。

## 已确认的产品与配置决策

1. **生产环境 `verificationRequired` 强制为 true，必须提供完整且可用的 SMTP 配置。** 不允许通过关闭验证开关绕过生产要求。配置检查通过不代表真实投递通过；SMTP 连通性与实际邮件到达仍需用户提供资源后验证。
2. 本地未配置 SMTP 时，`emailEnabled=false`，允许保持原有本地注册和登录体验；必须明确提示邮件功能未配置，不能显示“已发送”或伪造验证成功。
3. 本地测试通过注入内存 fakeMailer 验证所有流程，不向真实收件人发送邮件。不创建真实外部测试邮箱，不依赖外部测试邮件服务。
4. 公开验证和重置链接固定从服务端 `APP_ORIGIN` 构造，令牌放在 HashRouter 的 fragment 中，不能使用请求 Host 或客户端提供的跳转地址。
5. 前端读出令牌后清理地址栏，仅在页面内存保留，不写 localStorage、sessionStorage、埋点或日志。
6. 邮件队列为有上限的进程内队列，**不具备持久投递保证**；进程退出前未完成的任务需要用户重新申请。

## 一、依赖与邮件适配器

主代理准备运行依赖 `nodemailer`，开发依赖 `@types/nodemailer`。内存假邮件传输即可完成主要验收，暂不需要 Redis 或额外 SMTP 服务。

```ts
interface Mailer {
  send(message: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void>;
}

createApp({ db, config, mailer? });
```

真实 SMTP 使用 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM` 等配置。465 使用直接 TLS；587 强制 STARTTLS；生产不得关闭证书校验。设置有限连接、问候和套接字超时，关闭 Nodemailer debug/logger，禁用模板访问本地文件和 URL。

SMTP 凭据仅由服务端环境或部署平台密钥配置提供。测试发信函数只接收 fakeMailer，并把邮件保存在测试内存，不能输出正文、令牌或完整链接。

参考：[Nodemailer SMTP 文档](https://nodemailer.com/smtp)。

## 二、最小接口契约

所有接口继续返回 JSON，保留现有 `{error,code}` 错误结构。所有 POST 继续校验 Origin。

| 接口 | 请求与行为 |
| --- | --- |
| `GET /api/auth/capabilities` | 无需登录，返回 `{emailEnabled, verificationRequired}`，不暴露 SMTP 配置或凭据。 |
| `POST /api/auth/verification/request` | 需要登录与 CSRF。为当前账号申请验证邮件，不接受客户端指定收件邮箱。 |
| `POST /api/auth/verification/confirm` | `{token}`，成功返回 `{ok:true}`。凭单次令牌确认，不自动创建登录会话。 |
| `POST /api/auth/password/forgot` | `{email}`。存在、不存在或邮箱处于冷却期时均返回相同的 202 与通用文案。 |
| `POST /api/auth/password/reset` | `{token,newPassword}`，成功返回 `{ok:true,relogin:true}`，要求用户重新正常登录。 |

公开令牌确认、忘记密码与重置接口放在现有会话中间件之前，继续执行请求体限制、Origin 检查和相关限流。验证邮件申请属于登录后的操作，必须校验 CSRF。

无 SMTP 的本地环境不排队、不生成假邮件；capabilities 明确关闭功能，邮件请求返回受控的 `EMAIL_NOT_CONFIGURED`，对所有邮箱一致。

错误码建议固定为：`EMAIL_NOT_CONFIGURED`、`EMAIL_NOT_VERIFIED`、`AUTH_TOKEN_INVALID`、`RATE_LIMITED`、`MAIL_QUEUE_BUSY`。无效、过期、已消费、被撤销或用途不符的公开令牌统一为 `AUTH_TOKEN_INVALID`，不泄露账号状态。内部 SMTP 错误不原样传给浏览器。

### Session 与注册兼容

保留现有 `user`、`workspace`、`csrfToken`，只增量增加：

```ts
user.emailVerified: boolean;
auth: {
  emailEnabled: boolean;
  verificationRequired: boolean;
};
```

注册创建账号成功仍返回 201；增加 `emailDelivery:'queued'|'disabled'|'unavailable'`。`queued` 仅代表已接受发信任务，不代表已经送达；`disabled` 仅用于未配置邮件；`unavailable` 表示账号已创建但邮件暂未排队，可稍后重发。不能因为 SMTP 后续失败或队列满把账号创建成功误报成注册失败。

生产未验证账号仍可读取 session、申请验证、退出及执行必要的账号恢复操作，但服务端必须拒绝其业务数据接口；不能只在前端隐藏页面。前端应先依据 session 判断验证状态，再决定是否加载业务快照，避免产生误导性的加载失败提示。

## 三、数据库迁移 003

只使用增量、可重复执行的迁移：

- `users.email_verified_at timestamptz NULL`。
- `users.credential_version integer NOT NULL DEFAULT 0`。
- 新建 `auth_tokens`：`id`、`user_id`、`purpose`、`token_hash UNIQUE`、`email_snapshot`、`credential_version`、`created_at`、`expires_at`、`consumed_at`、`invalidated_at`；按需增加 `sent_at` 和受控投递状态。
- 新建 `auth_request_limits`：按哈希后的邮箱/IP与用途保存窗口、次数及下次允许时间，使用数据库原子更新，避免多请求绕过。
- 令牌用途限定为 `verify_email` 与 `reset_password`，外键引用已有 users。

现有用户默认未验证，不自动证明其邮箱归属，不修改其用户 ID、邮箱、密码或工作空间。生产启用新版本后由验证/恢复流程证明归属；本地无 SMTP 时原有业务体验保持可用。

业务 JSON 备份仍不包含身份数据与恢复令牌。数据库级备份和恢复应覆盖新表，但生产恢复操作后还需评估撤销已有会话及未消费恢复令牌，避免旧备份复活凭据。

## 四、令牌与并发规则

1. 用 `randomBytes(32)` 生成随机令牌，数据库仅保存 SHA-256 散列。建议邮箱验证有效期 24 小时、密码恢复有效期 30 分钟。
2. 令牌绑定账号、用途、邮箱快照和凭据版本，不能跨用途消费，不能在账号邮箱或凭据变更后继续有效。
3. 消费顺序固定：查询候选令牌所属账号，锁账号行，再锁令牌行，重新检查状态和时效。账号修改、令牌消费与审计同一事务。
4. 同令牌或同账号多个令牌并发提交，最多一个恢复成功。允许少量有效链接并存；任一成功后撤销同账号其他相关令牌，避免重发失败让旧邮件同时失效。
5. 密码恢复成功后：保存新 scrypt 散列、递增凭据版本、把邮箱标记为已验证、撤销该账号全部会话、撤销其剩余恢复/验证令牌，再要求重新登录。
6. 现有修改密码接口也递增凭据版本并作废恢复令牌，保留“当前会话保留、其他会话撤销”的既有行为。
7. 保留登录时账号行锁和密码散列复核，避免慢登录在密码变化后创建旧凭据会话。
8. 单纯申请密码恢复不得修改密码、锁定账号或撤销现有会话。邮箱验证成功不自动创建会话；已有登录状态通过重新读取 session 更新验证状态。
9. 公开确认页面由用户点击按钮触发 POST；GET 打开邮件链接不消费令牌，避免邮件扫描器提前使链接失效。

参考：[OWASP 密码找回指南](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。

## 五、邮件失败、限流与日志

- 找回接口统一限流和排队响应；账号查找与发送在受限队列内进行，减少 SMTP 耗时暴露账号存在性的差异。
- 队列必须设置总数量、并发及发送超时上限；不在持有 SQL 事务锁时等待 SMTP。
- 发信失败仅作废本次新令牌，不回滚已创建账号、不破坏经营数据、不使其他仍有效的旧链接一并失效。
- 进程退出导致未发送任务丢失时，用户可重新申请；文档明确这是非持久队列，不声称投递必达。中断遗留的 pending 令牌在下一次申请时于账号锁内回收：须超过发信总超时再加 60 秒安全余量，且至少等待 75 秒。已发送链接及仍处于该窗口的 pending 不受影响；邮箱冷却仍适用。
- 初始限流建议：每邮箱 60 秒一次、15 分钟最多 5 次；另设 IP 窗口上限和队列上限。额度可配置用于隔离测试。
- 未登录找回接口的邮箱级冷却继续统一返回 202；IP 限流统一返回 429。已登录的验证重发可以明确告知冷却时间。
- SMTP 配置缺失是全局功能状态，对所有邮箱一致；SMTP 对某次发送拒绝或超时不能用于公开区分账号是否存在。
- 可记录事件类型、请求 ID、令牌记录 ID和经过允许列表筛选的错误码；禁止日志记录原始令牌、完整链接、邮件正文、新旧密码、SMTP 密钥或原始 SMTP 响应。
- 重置成功应发送安全通知，通知不包含密码；通知失败不得撤销已经成功完成的密码恢复。

## 六、前端要求

- 登录页增加忘记密码入口；由 capabilities 决定是否可用。
- 新增验证等待页、邮件验证确认页、密码重置页；保留现有登录和注册入口。
- 固定链接形态如 `APP_ORIGIN/#/verify-email?token=...` 和 `APP_ORIGIN/#/reset-password?token=...`，不把令牌放进发送给服务器的 URL 查询部分。
- 读取 fragment 后立即清理地址栏并仅保留于当前页面内存；不在 toast、错误报告或聊天记录中回显。
- 密码重置表单二次确认新密码，继续采用与注册相同的 12–128 字符规则。
- 验证成功后重新获取 session；无会话时提示正常登录，不自动登录邮箱所指账号。
- 密码恢复成功后清除本次客户端旧 session 状态并回到登录页；若请求途中已经完成另一次登录，不得清除较新的前端身份状态。后端 reset 不发送 Set-Cookie，避免晚到响应删除新登录的 Cookie；只撤销令牌所属账号的旧会话，不改动其他账号会话。

## 七、必须执行的验收

- [x] 迁移前已有账号和业务样本升级后保留，本地无 SMTP 流程兼容；既有业务全套验收仍通过。
- [x] 验证成功、过期、重放、错误用途、伪造账号/邮箱快照拒绝。
- [x] 同令牌以及同账号多个令牌并发恢复最多一个成功（PGlite；真实 PG 待下项联合验收）。
- [x] 密码恢复后旧密码、旧会话及旧恢复链接全部失效；新密码可正常登录。
- [ ] 普通修改密码与恢复/慢登录并发时不会复活旧凭据。
- [x] fake SMTP 失败、超时、队列满和中断 pending 回收不损坏账号；保留旧已发送链接和活跃 pending。
- [x] 公开找回响应不区分账号存在性；数据库冷却不能被并发绕过。
- [x] 生产强制验证，未验证账号无法绕过前端直接访问业务 API。
- [x] 本地未配置邮件时不伪造已发送，不生成可从浏览器或日志获取的恢复令牌。
- [x] fakeMailer 完成全流程，令牌仅由测试内存中的邮件取出，没有真实外发邮件。
- [x] 重置仅撤销令牌所属账号会话；其他账号不受影响，晚到响应不发 Set-Cookie，不清除新登录。
- [x] 已注销会话的排队验证请求在执行时不生成令牌、不发送邮件。
- [ ] PGlite 与原生 PostgreSQL 两条数据库路径验证新增迁移与关键并发行为。
- [ ] 浏览器确认 fragment 清理、会话兼容、验证等待页和重置后重新登录。
- [ ] 用户提供真实 SMTP/域名后另行验证 TLS、发信身份与实际投递；此项不能由假传输测试代替。

2026-10-05 后端 `tsc` 通过；recovery / hardening / API 组合 49/49 通过（其中 recovery 19 项）。当前真实 PG 与浏览器由主代理联合验收，源代码已冻结；最终结果以总进度及后端检查点为准。

## 八、用户后续需提供

邮件服务供应商与 SMTP 参数、可用发件地址、发信域名管理权限、正式 HTTPS APP_ORIGIN。相关凭据通过服务端环境或部署密钥提供，不放进 Git、文档、浏览器或聊天示例。

收到资源前可以实现和验证全部隔离流程，但不得把真实邮件投递、生产上线或商业运营标记完成。

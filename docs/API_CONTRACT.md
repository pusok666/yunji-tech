# 商业化基础版接口契约（S1/S2）

当前用于前后端并行开发。前端 5174，同源 `/api` 代理至 127.0.0.1:4100。所有路由使用 JSON；日期 `YYYY-MM-DD`、CNY 金额对外元、业务计算使用整数分；禁止 NaN、无限值、超过两位小数。

## 身份

- `POST /api/auth/register`：`{email,password,name,workspaceName,inviteCode?}`，创建独立空间。生产邀请开通受服务端邀请码约束。
- `POST /api/auth/login`：`{email,password}`。
- 上两者与 `GET /api/auth/session` 返回 `{user:{id,email,name},workspace:{id,name,role:'owner'},csrfToken}`。未登录 session 返回 401。
- `POST /api/auth/logout` 返回 `{ok:true}`。
- `POST /api/auth/password`：`{currentPassword,newPassword}`，需要 CSRF，更新后其他会话失效。
- 会话使用 HttpOnly Cookie `yunji_commercial_session`，不使用 localStorage 登录标记。非认证写请求必须有 `X-CSRF-Token`，服务端校验 Origin。

## 业务快照与写入

- `GET /api/data` 返回 `Snapshot = {data:BusinessData,revision:number}`。
- 保留当前四个数组及实体字段。`BusinessData.version=1`（接口格式版本），新增始终存在的 `receipts:Receipt[]`、`stockMovements:StockMovement[]`，不从订单再次派生收款。
- `Receipt={id,orderId,type:'收款'|'退款',amount,date,notes,receiptId?:string}`；退款必须关联原收款，不能超过该原收款可退余额。订单 `paidAmount` 由流水净额派生，前端不能修改它。
- `StockMovement={id,productId,delta,date,notes}`。库存创建时可提交期初 stock，由服务端建立期初流水；以后变更只能使用库存流水接口。
- `PUT /api/records/:kind/:id`：`{value:Entity}`，创建或编辑四类实体（customers/orders/products/transactions）；路径 ID 必须匹配，新增订单 paidAmount 必须为 0。
- `DELETE /api/records/:kind/:id`：删除无历史/关联的记录。有收款订单、有库存流水商品及有关联订单客户不能删除。
- `POST /api/orders/:id/payments`：Receipt 对象，创建独立收款/退款。已取消订单不能新增收款；有未退余额不能取消。金额变更不能小于已收净额。
- `POST /api/products/:id/stock-movements`：StockMovement 对象，禁止负库存、零变动，理由必填。
- 所有业务写入必须携带 `If-Match: "<revision>"`、`Idempotency-Key: <随机唯一ID>` 和 CSRF。响应为最新 Snapshot。旧版本返回 409，重复相同请求返回同一个结果，不重复写入；同一 key 不同请求返回 409。
- 原子性：业务记录、流水、操作审计、快照版本与去重记录在同一数据库事务内。按当前会话 workspace_id 限定所有查询，不能信任前端 workspace_id。
- `GET /api/audit` 返回 `{events:[{id,action,entityKind,entityId,createdAt}]}`，按空间读取。

## 备份与 AI

- `GET /api/backup` 返回 `{format:'yunji-commercial-backup',version:1,exportedAt,data,revision}`，只含当前空间经营数据，不含账号、会话、密钥。
- `POST /api/restore` body 为上面的备份，需要版本/去重/CSRF，只允许恢复到空工作空间；服务端完整验证关联、金额、流水和期初库存，原子恢复。
- `POST /api/assistant`：`{question,history?:[{role,content}]}`。从当前用户服务器数据计算回答，禁止相信浏览器传入 context。返回 `{answer,mode:'rules'|'llm'}`；暂未配置真实模型时明确标注规则模式。
- 错误返回 `{error:string,code?:string}`，不泄露栈、SQL、密码、其他空间信息。

## 本地与生产

服务端 Node 24 + Express 5，开发数据库使用本目录 `.local/database` 的 PGlite；有 DATABASE_URL 时使用 pg 驱动。生产必须显式配置 APP_ORIGIN、邀请口令、HTTPS，采用独立 PostgreSQL。迁移保存于 server/migrations。不得向汇报版导入数据，不使用其 localStorage 键及端口。

服务端导出 `createApp({db, config})`；数据库导出 `openDatabase({dataDir?,url?})`，包含 query/transaction/close。config 至少含 appOrigin、production、inviteCode，可扩展测试配置。具体导出如调整须及时通知测试实现方。

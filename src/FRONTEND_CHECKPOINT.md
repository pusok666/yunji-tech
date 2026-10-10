# 商业化前端断点 · 2026-10-04

仅修改 `D:\云迹科技-商业化\src`，未修改汇报版。

## 已实现

- 真实注册、登录、会话恢复、退出和密码修改；严格按 API 允许字段提交。
- 服务器快照、CSRF、If-Match 版本保护、Idempotency-Key；异步成功后更新页面。网络与服务暂时失败保留原请求键；409 保留输入并提供刷新入口。
- 四模块异步 CRUD。订单已收金额只读，独立收退款与流水；商品期初库存、后续出入库登记与原因记录。
- 服务器导出备份，新格式仅向空空间恢复；删除演示重置入口。
- 动态账号/空间、密码修改、操作审计。
- AI 使用服务器授权空间数据并展示 rules/llm 模式；聊天页面内存保存，离开/退出即清理，无汇报版 localStorage 依赖。
- 独立流水按实际日期生成现金流入、现金流出（包含退款）、收支结余，保留原图表布局。

## 实际验证

- TypeScript 编译通过：`node node_modules/typescript/bin/tsc -p tsconfig.json`。
- Vite 生产构建通过，3639 modules，20.80 秒；仅存在 UI/图表包大于 500kB 的体积提示。
- 人工对照后端 schema 检查字段与 ID 格式。
- 浏览器 E2E 由 root 统一执行；不能以编译通过代替交互验收。

## 交接

- root 管 package/vite、tests、scripts、README、部署与 Git 检查点。
- 未引用的旧 `src/services/assistant.ts` 本地模拟实现已移除。真实助手由 store 调服务器。
- src 已冻结，等待 root 浏览器验证后继续修复发现的问题。

## 第二轮联调修复 · 2026-10-04

- 修复 Records 的 forceRender 隐藏表单与收退款表单共享 DOM id：所有 Form 分配独立 name。
- 浏览器实际定位：修复前收款 label 的 for=amount，有两个同 ID 元素且 control 指向不可见输入；修复后 for=order-payments_amount，只有一个且可见，精确 getByLabel 可填写 400。
- 新增 editMerge.ts。编辑只重新应用当前用户实际改动的字段；他人改动的未编辑字段保留。相同字段并发修改要求显式选择服务器值或我的修改；已删除记录不允许被旧表单重新创建。
- store 增加 sessionEpoch，旧会话响应不能覆盖新账号空间，旧 401 不能清理新会话；低于当前 revision 的旧快照忽略。
- TypeScript 与 Vite 重新通过：3640 modules，11.51 秒。纯函数不同字段合并、相同字段冲突验证通过。
- 已冻结运行代码，root 执行收退款、库存、并发编辑、会话隔离的浏览器回归；review_plan 只读复核。

## 第三轮视觉联调修复 · 2026-10-04

- 收支新增/编辑的分类选项按收入、支出分别显示；用户切换类型时，不适用分类重置为对应“其他收入/其他支出”。
- 打开编辑表单不会自动改历史记录：不在当前类别选项中的旧分类保留为“原分类”，只有主动切换类型才执行联动。
- 审计动作 receive/refund/stock-in/stock-out 显示收款/退款/入库/出库。
- 未改已验收的并发合并、会话隔离、库存和收退款保存逻辑。TypeScript 编译通过；root 重新构建并执行最终浏览器回归。

## S4 账号邮件验证与密码找回 · 2026-10-04

- 完成公开 capabilities 读取与登录页邮件能力提示；未配置 SMTP 明确显示不可邮件找回，不伪称已发送。
- 新增验证等待页、显式验证确认页、密码重置页及忘记密码弹窗；Settings 显示邮箱验证状态和重发入口。
- 公共链接为 /#/verify-email?token=... 和 /#/reset-password?token=...；authLink.ts 初始化立即清理地址栏，只在模块/页面内存短暂保存。重复初始化可读同一令牌，页面离开/成功清理；不使用浏览器持久存储和日志。
- 验证须用户点击“确认验证邮箱”才 POST，随后检查 session；不自动登录邮件对应账号。密码重置使用 12–128 字符和二次确认，成功清客户端会话并跳到登录页要求重新登录。
- 保留 sessionEpoch；公开确认/重置在更新界面身份前检查世代。session 跨账号/空间变化先清旧快照，未验证且 verificationRequired=true 时不请求业务数据。
- Session emailDelivery 支持 queued / disabled / unavailable；unavailable 明确账号已创建、邮件暂未排队。
- 稳定 testid：verification-required、verify-email-page、reset-password-page、forgot-password-dialog、login-page。控件标签已交接 root。
- 实际验证：TypeScript 通过，生产 Vite build 通过（3642 modules，33.56 秒），仅原有包体积提示；fragment helper 的首次清理、重复初始化、用途隔离、内存清理和重复参数拒绝检查通过。
- 后端确认 reset 成功清当前浏览器会话 cookie；只在数据库撤销令牌所属账号的会话。
- 运行代码已冻结。root 执行 fakeMailer 浏览器全流程与核心回归；review_plan 只读安全复核。没有真实外发邮件，不声称 SMTP 真实投递完成。

## Linux CI 无障碍名称修复 · 2026-10-04

- review_plan 真实 DOM 复现 AntD loading 离场图标仍带 aria-label=loading，导致按钮名称暂时为“loading 登记收款”。
- 仅对收退款和库存提交按钮添加明确 aria-label（登记收款/登记退款、登记库存变动）；busy、disabled 和全部业务行为保持原状。
- TypeScript 通过；root 重新构建并使用精确角色名验证 CI，不放松定位标准。


## 北京时间经营日期统一 · 2026-10-05

- today/localDate 明确使用 Asia/Shanghai；日期字符串转 UTC 日历进行前后日、周/月/年边界及趋势序列计算，避免浏览器/CI 宿主时区和夏令时影响。
- today、daysAgo、periodStart、metrics、trend 接受可选 Date 参数，默认当前时刻，便于确定性测试。
- 保留原始 YYYY-MM-DD 比较与实际收退款规则；日期有效性检查改为 UTC 日历往返，不使用宿主本地中午时间。
- Dashboard 日期、审计时间标注北京时间，帮助说明统一经营日期口径；未改收款、库存、并发或邮件页面逻辑。
- 实测 TypeScript 通过；TZ=UTC、America/Los_Angeles、Asia/Shanghai 三个独立子进程均通过跨午夜、周一、跨年、闰日和实际流水跨月筛选检查。
- root 将固定时刻用例纳入正式测试并重新构建/浏览器回归；src 再次冻结。

### 邮件恢复策略更正

早前“reset成功清当前浏览器cookie”的记录已被安全审查决策替代：后端 reset 成功不发送 Set-Cookie，避免晚到响应删除后来登录的新账号cookie；仅数据库撤销目标账号旧会话。前端仍用 epoch 防护，只清理同世代客户端内存并引导重新登录，不清理途中新增身份。

## 永久幂等键与未确认操作恢复 · 2026-10-06

- Snapshot 兼容可选 idempotency 回放元信息；保存/删除/收退款/库存/恢复成功返回该结果。过期缓存回放明确提示“该操作此前已完成，已刷新当前数据”，沿用 sessionEpoch 与 revision 防护，不当作冲突重记。
- 同页面内业务数据刷新不再清空未确认请求键；成功确认、确定性客户端错误或身份清理按现有规则处理。没有增加 localStorage、跨重载队列或离线请求持久化。
- 收退款、库存弹窗在真实网络/响应异常或 5xx 时显示“操作结果尚未确认”及“刷新并保留输入”按钮；普通表单校验失败不会触发该提示。
- 先查当前授权服务器快照中的同 intent 不可变流水，再逐一对照实际提交的全部字段：收退款含金额、日期、说明、类型、订单和原收款 ID；库存含商品、带正负号数量、日期和原因。完全相同直接确认并清表单，不再 POST；任意字段不同阻止提交并保留输入，不自动换编号重记。
- 无匹配流水仍执行原有余额/库存校验，并使用原请求键安全重试。因此全额收款、退款或出库刷新后余额归零，也能用已存在的完整流水确认先前操作。
- 经营 JSON 备份改为紧凑序列化，schema 内容保持一致，减少导出缩进导致的文件膨胀。
- 实际验证：TypeScript 检查通过；纯 helper 检查通过（收款可选原流水、退款全部字段分别变更、库存符号/全部字段、过期回放文案）；git diff --check -- src 通过。
- src 已冻结交 root 构建和浏览器回归。浏览器计划：400 收款服务端成功后模拟响应丢失并清响应缓存，不刷新直接同键重试验证 200 回放；600 全额收款丢响应后弹窗内刷新，再提交只确认既有流水，不增加 POST/流水/版本。此段不预先声称浏览器验收完成。

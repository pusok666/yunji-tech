# 云迹科技 · 商业化开发版

面向服务型个体经营者、商品零售和微型团队的经营管理平台。当前为**独立的本地真实业务试用基础版**，云端部署、真实用户试用与收费验收仍需完成。

## 两个版本完全独立

| 用途 | 本机目录 | Git 分支 | 地址 |
| --- | --- | --- | --- |
| 已有年度汇报演示 | `D:\云迹科技` | `main` | 原启动方式与端口保持不变 |
| 商业化开发 | `D:\云迹科技-商业化` | `feat/commercial-pilot` | `http://127.0.0.1:5174` |

商业版不会读写汇报版的 localStorage、数据库、启动进程或代码。商业版已禁用原同步覆盖脚本，不会自动合并到 main。

## 本机运行

在商业化目录双击 **启动商业化版.bat**，停止时双击 **停止商业化版.bat**。

首次进入点击「创建空间」，自行设置邮箱、至少 12 位密码和空间名称。**没有预设演示账号或默认密码**；新空间从空数据开始。未配置开发邀请码时，本机允许创建账号；生产启动要求邀请码。

本地未配置 SMTP 时，账号仍可注册、登录并使用业务功能，页面明确提示邮件服务未配置；不会生成或发送模拟验证邮件，也不能通过邮件找回密码。配置邮件服务后可验证邮箱和申请密码重置；生产环境必须配置 SMTP，并强制验证邮箱后才能访问经营数据。

手动启动：

```powershell
Set-Location 'D:\云迹科技-商业化'
pnpm install --frozen-lockfile
pnpm dev
```

保持终端运行，浏览器访问 `http://127.0.0.1:5174`。需要 Node.js 24 和 pnpm 11.25.0。可以用 `npm install --global pnpm@11.25.0` 安装包管理器。

## 在其他电脑继续开发

商业分支已推送，使用：

```bash
git clone --branch feat/commercial-pilot --single-branch https://github.com/pusok666/yunji-tech.git yunji-commercial
cd yunji-commercial
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev
```

每台电脑单独运行时各有自己的服务器数据库。要让不同设备共享数据，必须连接同一个部署好的服务；仅克隆代码不会同步业务记录。

## 已实现的模块

- 真实注册、登录、会话恢复、修改密码、退出；每个账号一个独立经营空间。
- 邮箱验证、重发验证邮件、忘记密码和密码重置；链接一次性使用，重置成功后目标账号旧会话失效，需重新登录。已使用内存 fakeMailer 验证流程，真实 SMTP 投递尚待配置验收。
- 客户、订单、库存、收支的新增、编辑、删除、搜索、筛选与 CSV 导出。
- 独立收款、退款和库存变动流水；有关联历史的记录受到删除保护。
- Dashboard 和统计图表，按资金实际发生日期计算现金流入、现金流出（含退款）与收支结余。
- 经营助手从服务器读取当前账号授权数据，生成规则查询与日报周报；界面明确标注规则模式，尚未调用真实模型。
- 经营数据 JSON 导出、恢复到空工作空间、操作审计。
- 数据库事务、服务端验证、版本冲突检测、请求幂等、CSRF 和来源检查。

## 业务口径

1. 新订单已收净额为 0；通过「收退款」登记实际发生日期，不能直接改已收金额。
2. 退款必须关联原收款，并且不超过可退余额；取消订单前退清余额。历史流水不会因订单编辑消失。
3. 新商品的期初库存自动留痕；以后使用「出入库」登记，禁止负库存。商品订单暂不自动扣库存。
4. 现金结余不是会计净利润；未包括应计成本、折旧或完整会计核算。
5. 其他设备写入后，点击顶部刷新。出现保存冲突时表单保留，刷新后核对再提交。
6. 经营备份不包含账号和密码，仅能恢复到空空间。服务器整库备份需按运维手册另行配置。
7. 默认经营日期、周/月/年统计边界统一按北京时间（`Asia/Shanghai`）；其他时区的电脑与服务器使用同一经营日期。

## 技术结构

```text
src/                 React + TypeScript + Ant Design + ECharts
server/              Express + 数据验证、会话、业务事务、规则助手
server/migrations/   按版本执行的数据库迁移
server/tests/        后端安全和持久化测试
tests/               指标测试、API 验收、浏览器全流程
scripts/             独立开发和 Windows 启停
.local/              本地数据库和日志（不进入 Git）
docs/                API 契约、用户待办、上线和运维说明
COMMERCIAL_PROGRESS.md  中断后首先阅读的恢复入口
```

开发默认使用 `.local/database` 中的 PGlite（嵌入式 PostgreSQL）；`DATABASE_URL` 接入 PostgreSQL。密码经加盐 scrypt 散列，会话 Cookie 为 HttpOnly；生产要求 HTTPS、安全 Cookie 和独立数据库。

## 验证命令

```bash
pnpm check
pnpm test:recovery
pnpm test:e2e
pnpm test:auth:e2e
pnpm audit
```

`pnpm check` 包含构建、前后端类型检查、业务、API、安全与账号恢复测试；`pnpm test:recovery` 可单独复查账号恢复。浏览器默认在 Windows 使用 Edge；其他系统先执行 `pnpm exec playwright install --with-deps chromium`。

测试使用独立临时数据库和浏览器上下文，不写入日常经营数据库。邮件测试只注入内存 fakeMailer，不向真实邮箱发送邮件。

| 命令 | 输出 |
| --- | --- |
| `pnpm test:recovery` | 账号验证、恢复、安全及失败场景结果输出到终端或 CI 日志 |
| `pnpm test:e2e` | 经营流程；`test-results/commercial/report.json`、截图与 `trace.zip` |
| `pnpm test:auth:e2e` | 验证/找回流程；`test-results/auth-recovery/report.json`、截图与 `trace.zip` |

可用 `TEST_DATABASE_URL` 在**专用测试库**运行 `pnpm test:api`，绝不能指向生产数据库。GitHub Actions 已配置此检查；实际结果以工作流记录为准。

2026-10-05 本地最终集成：`pnpm check` 的构建、前后端类型检查及业务 13、API 22、安全 8、账号恢复 19 项全部通过（共 62 项）；经营浏览器 16/16、邮件恢复浏览器 9/9 最终重跑通过，非预期错误列表均为空。`pnpm audit --prod` 未发现已知生产依赖漏洞。远端 CI 尚待最终提交验收，以对应工作流记录为准。

独立原生 PostgreSQL 17.10 普通 owner 账号已通过 API 22 项与恢复 19 项；官方 17.11 客户端完成 custom 备份与第二空库恢复，11 张表及非空认证令牌、限流、用户凭据/验证状态逐项一致。具体覆盖与报告位置见运维手册。云端部署、自动备份和真实 SMTP 邮件投递尚未完成。

## 邮件使用边界

- `queued` / HTTP 202 表示申请已受理，不代表邮件已经送达。注册返回 `emailDelivery: unavailable` 时账号已创建，可稍后重发；`disabled` 表示未配置邮件服务。
- 当前邮件队列保存在进程内，有容量与超时限制；服务重启或投递失败后，未完成任务不保证自动补发。等待冷却期后重新申请，使用仍有效的邮件链接。
- 打开邮件链接不会自动验证；点击确认才消费令牌。令牌读取后立即从地址栏清除，仅存当前页面内存，刷新或离开后需要重新打开完整邮件链接。
- 密码重置撤销目标账号旧会话，不自动登录目标账号；接口不发送 `Set-Cookie`，防止晚到响应影响后来登录的其他账号。前端也检查会话是否已切换。

## 继续到商业化

- [你需要准备什么](docs/USER_ACTIONS.md)
- [分阶段路线与验收](docs/COMMERCIAL_PLAN.md)
- [上线检查表](docs/RELEASE_CHECKLIST.md)
- [部署、备份、恢复与回退](docs/OPERATIONS.md)
- [接口契约](docs/API_CONTRACT.md)

邮件验证与密码找回的软件流程已实现；真实 SMTP、发信域名与实际收件仍待验收。真实云部署、成员权限、真实模型、订阅收费、支付通道和持续运维均不得在未完成验收时宣称就绪。当前快照式接口适合少量受邀用户；分页、长期流水归档与多实例限流需在扩容前补齐。

## 断点保护

每阶段记录实际完成内容、验证结果、Git 提交和下一步。额度中断后读取 `COMMERCIAL_PROGRESS.md` 与前后端 CHECKPOINT 文件，先检查 Git 状态，再继续；不重新初始化、不清理未提交改动、不修改汇报目录。凭据、数据库、备份和测试产生的临时文件不提交 Git。

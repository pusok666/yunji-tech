# 云迹科技：换电脑运行与局域网访问

## 选哪种方式

| 需求 | 方式 |
| --- | --- |
| 另一台电脑独立安装、演示、修改代码 | 一：克隆仓库后本机运行 |
| 手机或另一台电脑访问正在演示的这台电脑 | 二：同一局域网访问 |
| 不同地区通过固定网址访问 | 三：部署静态网站 |

无论采用哪种方式，当前 MVP 都使用浏览器 localStorage，**不会跨设备同步业务数据**。GitHub 保存源代码，不保存浏览器中的客户、订单与会话。迁移数据请使用页面右上角账号菜单的 JSON 导出/导入。

## 一、在另一台电脑独立运行

### 1. 安装环境

- Node.js 24 LTS（安装器通常包含 npm）：https://nodejs.org/en/download/
- Git：https://git-scm.com/downloads/

安装后重新打开终端，确认：

```bash
node -v
npm -v
git --version
```

### 2. 下载和启动

在准备存放项目的目录执行（Windows、macOS、Linux 均可）：

```bash
git clone https://github.com/pusok666/-.git yunji-platform
cd yunji-platform
npm install
npm run dev
```

这里显式指定目录名 `yunji-platform`，避免仓库默认名字 `-` 与终端 `cd -` 命令混淆。

浏览器访问：`http://127.0.0.1:5173/`。

- 点击“免登录体验演示”；或使用 `demo@yunji.tech` / `yunji2026`。
- 保持终端运行。按 `Ctrl+C` 停止服务。
- Windows 完成依赖安装后，也可双击 `启动云迹科技.bat`。
- 再次运行只需进入项目目录后执行 `npm run dev`。

### 3. 获取更新

没有本地代码修改时：

```bash
git pull --ff-only
npm install
npm run dev
```

有本地代码修改时，先保存/提交修改再拉取，勿用强制重置覆盖自己的工作。依赖安装完成后，本地演示无需调用网络 API。

## 二、其他电脑或手机访问同一台宿主机

宿主机是实际运行服务的电脑；访问设备只需浏览器，不需安装 Node.js。

### 1. 连接同一局域网

两台设备连接同一个普通 Wi-Fi 或同一局域网。访客 Wi-Fi、校园网可能启用设备隔离，导致设备之间无法访问。

### 2. 宿主机启动演示预览

宿主机也需具备上述 Node.js/npm 环境，且项目依赖已安装。

当前这台 Windows 电脑，在 PowerShell 中执行：

```powershell
Set-Location 'D:\云迹科技'
npm run build
npm run preview -- --host 0.0.0.0 --port 4173 --strictPort
```

其他宿主机将目录替换为实际项目路径。保留终端，且让宿主机保持开机、不休眠。

这里使用 **4173**，与现有仅供本机访问的 **5173** 服务互不冲突。`0.0.0.0` 是监听设置，不是访问设备应输入的地址。Vite preview 用于本地/局域网临时演示，不作为长期公网生产服务器。

### 3. 查询宿主机 IP

Windows 在另一个终端执行：

```powershell
ipconfig
```

找到正在联网的 WLAN/以太网 IPv4 地址；不要选 WSL、虚拟网卡或已断开网卡。例如宿主机地址为 `192.168.1.100`。

macOS 可在系统设置的网络详情查看，Linux 可执行 `hostname -I`，选择连接当前局域网的地址。

### 4. 访问设备打开网页

在另一台电脑或手机的浏览器输入：

```text
http://192.168.1.100:4173/
```

将示例 IP 换为宿主机当时的真实地址。重连网络后 IP 可能变化。访问设备上输入 `127.0.0.1` 或 `localhost` 会访问它自己，无法访问宿主机。

### 5. Windows 防火墙阻止时

如果弹出 Node.js 网络访问提示，在自己信任的家庭/工作局域网允许“专用网络”。若宿主机能打开 `http://127.0.0.1:4173/`，其他设备仍无法连接，可在宿主机的**管理员 PowerShell** 中为专用网络添加规则：

```powershell
New-NetFirewallRule -DisplayName 'Yunji Demo 4173' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173 -Profile Private -RemoteAddress LocalSubnet
```

该规则只针对专用网络和本地子网。网络若是公用配置，此规则不会生效；只在可信网络中使用专用配置。无需关闭整个防火墙。

不再需要共享时，按 `Ctrl+C` 停止预览。删除上面的规则：

```powershell
Remove-NetFirewallRule -DisplayName 'Yunji Demo 4173'
```

以上命令是供你按需要执行的操作说明，项目不会自动修改防火墙。

## 三、不同网络访问

`192.168.x.x` 属于局域网地址，不能让外网用户直接访问。长期分享应部署静态网站：

1. 在支持 Vite 的静态托管平台导入 GitHub 仓库。
2. 设置构建命令 `npm run build`，输出目录 `dist`，Node.js 使用 24。
3. 部署后使用平台提供的 HTTPS 地址访问。
4. GitHub 仓库地址本身不是网站地址。当前仓库尚未部署为公网网站。

可直接使用域名根目录托管。若部署在 `/项目名/` 子路径，需为 Vite 配置对应 `base` 后重新构建。公开托管仍不提供多端数据同步或真实账号认证；后续需接入后端。

## 迁移演示数据

1. 原电脑用原浏览器、原地址进入平台。
2. 右上角账号菜单 → “导出数据备份”，得到 JSON 文件。
3. 把文件传给新电脑，在新电脑平台中选择“导入数据备份”。
4. 确认替换后即可继续演示。对话历史不在业务 JSON 备份中。

不同浏览器、不同设备，以及 `127.0.0.1:5173`、`局域网IP:4173` 等不同地址，使用各自独立的数据空间。导入只影响当前浏览器当前地址。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| `node`/`npm`/`git` 找不到 | 安装相应工具并重开终端 |
| PowerShell 提示不允许运行 `npm.ps1` | 将命令中的 `npm` 改为 `npm.cmd`，无需修改全局执行策略 |
| `ENOENT ... package.json` | 先进入包含 package.json 的项目目录 |
| 5173 被占用 | 复用原服务，或 `npm run dev -- --port 5174`，然后使用新端口 |
| 4173 被占用 | 换空闲端口并同步修改访问地址及防火墙规则 |
| `npm ci` 提示没有 package-lock | 本仓库提交的是 pnpm-lock.yaml，使用 `npm install`；不要直接 npm ci |
| 打开网页但看不到原数据 | 核对浏览器与地址，必要时导入 JSON 备份 |
| 局域网打不开 | 先确认宿主机 4173 可访问，再核对 IP、同网、终端存活、防火墙和设备隔离 |

## 技术参考

- Vite CLI：https://vite.dev/guide/cli
- Vite 预览和静态部署：https://vite.dev/guide/static-deploy.html
- Windows 防火墙规则：https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure-with-command-line
- 普通 HTTP 环境的 AI 消息 ID 已提供兼容实现，避免依赖仅安全上下文可用的 crypto.randomUUID。

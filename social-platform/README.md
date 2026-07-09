# 🎬 一起看 · 多人观影社交平台

基于 **Node.js（Express + Socket.IO）** 的轻量社交平台：支持创建房间、进入房间、房间内**连麦（语音）**、**聊天**、**用户资料**，以及核心功能——**多人观影**。

适合 **HTTPS 公网给朋友用**：内置 Session 鉴权、房间所有者/主持人分离、可选房间密码、大厅可见性、踢人、限流与 TURN 配置入口。

## 核心理念：视频不在服务端传输

每个人在**自己的电脑上、用自己的网络**播放视频，服务端**只同步播放进度与控制指令**：

- 服务端不存储、不中转视频流（B 站场景除外会走本机媒体代理），带宽成本可控；
- 同步的内容只有：`播放 / 暂停 / 跳转(进度) / 周期性纠偏`；
- 新成员加入时，服务端下发当前视频状态，做到「进来就能跟上进度」。

## 功能清单

| 功能 | 说明 |
| --- | --- |
| 创建房间 | 6 位房间号；创建者为**所有者**（可删房） |
| 加入房间 | 房间号或邀请链接；支持可选房间密码 |
| 可见性 | 默认 **仅链接**（unlisted）；可勾选公开到大厅 |
| 播控权限 | 默认仅主持人；可开「全员可控」 |
| 多人观影 | 视频直链 / 本地文件 / B 站 / HLS / 部分 iframe 站 |
| 进度同步 | 播放/暂停/拖动广播；主持人周期纠偏 |
| 实时聊天 | 房间内 E2E 加密公屏（密文存库） |
| 连麦 | WebRTC mesh；公网需配置 TURN（`ICE_SERVERS`） |
| 踢人 | 所有者/主持人可踢人（短时禁止再进） |
| 用户资料 | 昵称、头像、可选账号密码；Session Token 鉴权 |
| 房间永久保留 | 房间与片源写入 SQLite，重启后仍可进 |

## 运行方式

```bash
cd social-platform
npm install
npm start
# 打开 http://localhost:3000
```

多人测试：不同浏览器打开同一地址，一人创建房间，其他人加入。

> 跨设备访问请用 **HTTPS**。`http://IP` 下麦克风、原生 WebCrypto 等会受限。局域网可 `npm run start:https`；Ubuntu 公网见 [deploy/README-ubuntu-https.md](deploy/README-ubuntu-https.md)。

默认数据库：`social-platform/data/watchparty.sqlite`（已 gitignore）。生产建议：

```bash
HOST=127.0.0.1 PORT=3000 TRUST_PROXY=1 DATA_DIR=/var/lib/watchparty node server.js
```

## 公网相关环境变量

| 变量 | 说明 |
| --- | --- |
| `HOST` / `PORT` | 监听地址，生产建议 `127.0.0.1` |
| `TRUST_PROXY` | `1` 时信任反代 `X-Forwarded-*` |
| `DATA_DIR` / `DB_PATH` | SQLite 路径 |
| `CORS_ORIGIN` | 如 `https://watch.example.com`，默认 `*` |
| `SESSION_TTL_DAYS` | 会话有效天数，默认 30 |
| `ICE_SERVERS` | JSON 数组，STUN/TURN 配置 |
| `BILI_PROXY_ENABLED` | `0` 关闭 B 站媒体代理 |
| `BILI_PROXY_MAX_MB_PER_IP_HOUR` | 每 IP 每小时代理流量上限（MB） |
| `KICK_BAN_MS` | 被踢后禁止再进时长，默认 10 分钟 |

示例 TURN：

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
```

## 目录结构

```
social-platform/
├── package.json
├── server.js           # 鉴权 / 房间 / 同步 / 信令 / 限流
├── deploy/             # Nginx + systemd 示例
└── public/
    ├── index.html
    ├── style.css
    ├── client.js
    └── vendor/crypto-polyfill.js
```

## 安全说明（公网必读）

- 敏感操作（删房、改密、改名、历史消息）依赖 **Session Token**，不再只信客户端自报的 `userId`。
- 昵称召回接口返回短时 `reclaimToken`，**不暴露真实 userId**。
- 房间 **所有者** 与临时 **主持人** 分离：所有者离线不会丢掉删房权。
- 仍为轻量模型：无强实名登录；建议朋友设账号密码 + 房间密码，默认不公开到大厅。
- Mesh 连麦约适合 ≤6 人；跨运营商务必配 TURN。

## 观影片源说明

- **视频直链 URL**：所有人可直接加载。
- **本地文件**：每人需在本机选择相同文件。
- **B 站**：服务端解析 + 可选媒体代理（流量走你的 VPS）。

## 连麦原理

- `getUserMedia` + `RTCPeerConnection`（完美协商 mesh）。
- 服务端只转发 SDP/ICE；音频 P2P。
- 默认 Google STUN；公网请用 `ICE_SERVERS` 配 TURN。

## 已知限制

- 连麦 mesh，大规模需 SFU。
- 进度同步弱网下可能有亚秒级偏差。
- sql.js 单机内存库，适合朋友小站，不适合多实例水平扩展。
- E2E 聊天：晚进房/换主持人可能解不开历史密文。

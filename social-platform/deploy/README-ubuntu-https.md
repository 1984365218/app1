# Ubuntu 服务器 HTTPS 部署

这个项目不建议用 `http://公网IP:3000` 作为正式入口。浏览器把公网 HTTP 视为非安全上下文，会影响：

- 连麦：`getUserMedia` 只能在 `https://` 或 `http://localhost` 下使用。
- 剪贴板：`navigator.clipboard` 在 HTTP 下常被禁用。
- 端到端加密：项目内置了 `crypto.subtle` 垫片，但生产环境仍应使用浏览器原生安全上下文。
- Socket.IO：反代必须正确保留 WebSocket Upgrade 头，否则实时聊天/同步会不稳定。

你的服务器使用 Nginx 时，推荐部署结构：

```text
浏览器 https://your-domain.com
        |
   Nginx：证书、HTTPS、WebSocket 反代
        |
 Node.js：127.0.0.1:3000
```

## 1. 准备项目

以下路径只是示例，可以换成你服务器上的实际目录。

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin watchparty
sudo mkdir -p /opt/watchparty
sudo chown -R watchparty:watchparty /opt/watchparty
sudo mkdir -p /var/lib/watchparty
sudo chown -R watchparty:watchparty /var/lib/watchparty

# 把本仓库的 social-platform 目录上传到：
# /opt/watchparty/social-platform

cd /opt/watchparty/social-platform
npm ci --omit=dev
```

先确认 Node 服务能在本机启动：

```bash
HOST=127.0.0.1 PORT=3000 TRUST_PROXY=1 DATA_DIR=/var/lib/watchparty node server.js
curl http://127.0.0.1:3000/health
```

SQLite 数据库默认是 `data/watchparty.sqlite`。VPS 推荐像上面这样把 `DATA_DIR` 指到 `/var/lib/watchparty`，让房间、片源状态、用户昵称和头像脱离 Git 工作目录。仓库里的 `social-platform/data/` 已经加入 `.gitignore`，但生产环境使用 `/var/lib/watchparty` 更稳，后续 `git pull` 不会碰到运行中数据。

## 2. systemd 常驻运行

把示例服务复制到 systemd：

```bash
sudo cp deploy/watchparty.service.example /etc/systemd/system/watchparty.service
sudo systemctl daemon-reload
sudo systemctl enable --now watchparty
sudo systemctl status watchparty
```

服务里默认：

- `HOST=127.0.0.1`：Node 不直接暴露公网。
- `PORT=3000`：反代访问的本机端口。
- `TRUST_PROXY=1`：信任 Nginx 的 `X-Forwarded-*` 头。
- `DATA_DIR=/var/lib/watchparty`：SQLite 数据和头像等运行时数据放在仓库外。

以后在 VPS 更新代码时，建议先备份数据库再拉取：

```bash
cd /opt/watchparty/social-platform
sudo -u watchparty mkdir -p /var/lib/watchparty
sudo -u watchparty cp /var/lib/watchparty/watchparty.sqlite "/var/lib/watchparty/watchparty.sqlite.$(date +%F-%H%M%S).bak" 2>/dev/null || true
git pull
npm ci --omit=dev
sudo systemctl restart watchparty
curl http://127.0.0.1:3000/health
```

## 3. Nginx + Certbot

安装：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

确认域名 A 记录已经指向这台服务器。如果这是新域名，先用 HTTP 引导配置让 Nginx 有一个可用站点：

```bash
sudo cp deploy/nginx-watchparty-http-bootstrap.conf.example /etc/nginx/sites-available/watchparty
sudo sed -i 's/example.com/your-domain.com/g' /etc/nginx/sites-available/watchparty
sudo ln -s /etc/nginx/sites-available/watchparty /etc/nginx/sites-enabled/watchparty
sudo nginx -t
sudo systemctl reload nginx
```

然后让 Certbot 生成证书并启用 HTTPS 重定向：

```bash
sudo certbot --nginx -d your-domain.com --redirect
```

如果你想使用仓库里的完整 HTTPS 配置，可以在证书生成后再覆盖站点配置，替换里面的 `example.com`：

```bash
sudo cp deploy/nginx-watchparty.conf.example /etc/nginx/sites-available/watchparty
sudo sed -i 's/example.com/your-domain.com/g' /etc/nginx/sites-available/watchparty
sudo nginx -t
sudo systemctl reload nginx
```

如果服务器开了防火墙：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

不要对公网开放 `3000/tcp`；它只给本机反代使用。

Nginx 配置里最关键的是这几行，缺少时 Socket.IO 可能会退化或断连：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 3600s;
proxy_buffering off;
```

## 4. 验证

浏览器打开：

```text
https://your-domain.com
```

在浏览器控制台确认：

```js
window.isSecureContext
navigator.mediaDevices && navigator.mediaDevices.getUserMedia
```

都应返回可用状态。再创建房间、加入房间、发送聊天、进入观影模式、测试连麦。

## 5. 没有域名时

没有域名就无法拿到正常受信任的公网 HTTPS 证书。临时测试可以用项目自带自签名证书：

```bash
npm run start:https
```

然后访问：

```text
https://服务器IP:3000
```

首次访问需要在浏览器里手动信任证书。这个方案适合临时测试，不适合给普通用户长期使用。

## 6. 公网安全、鉴权与 TURN

应用已内置：

- **Session Token** 鉴权（删房/改密/历史消息等不再只信客户端 userId）
- 房间 **所有者 / 主持人** 分离、可选房间密码、默认大厅不公开
- 进程内限流、B 站代理流量上限
- 前端启动时请求 `GET /api/runtime-config` 拉取 ICE 服务器

### 推荐环境变量（systemd）

见 `watchparty.service.example`。生产至少设置：

```bash
HOST=127.0.0.1
TRUST_PROXY=1
DATA_DIR=/var/lib/watchparty
CORS_ORIGIN=https://你的域名
# 可选：关闭 B 站代理以省流量
# BILI_PROXY_ENABLED=0
```

### TURN（公网连麦必备）

HTTPS 解决浏览器权限，但跨 NAT/运营商语音常需 TURN（如 coturn）。配置后写入环境变量即可，**不必再改 client.js**：

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
```

coturn 最小思路（示例，按发行版文档细化防火墙与 TLS）：

```text
listening-port=3478
fingerprint
lt-cred-mech
user=u:p
realm=turn.example.com
# 公网 IP 与中继网段按机器填写
# external-ip=YOUR_PUBLIC_IP
```

改完后：

```bash
sudo systemctl restart watchparty
curl -s http://127.0.0.1:3000/api/runtime-config
curl -s http://127.0.0.1:3000/health
```

### 使用建议（给朋友）

1. 创建房间默认 **仅邀请链接**，需要时再勾选「公开到大厅」。
2. 可设房间密码；账号建议设密码（≥6 位）。
3. 删房间只有 **所有者** 能做；临时主持人只负责播控/踢人。
4. 升级代码前备份 `DATA_DIR` 下 sqlite。

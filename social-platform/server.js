/**
 * 一起看 · 多人观影社交平台 —— 服务端
 *
 * 核心思想：
 *  - 视频不在服务端传输，每个人在本地用自己的网络/文件播放；
 *  - 服务端仅负责房间管理、聊天转发、播放进度同步、以及 WebRTC 连麦的信令中转。
 *
 * 技术栈：Express(静态资源) + Socket.IO(实时通信)
 */

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { Server } = require('socket.io');

// 是否启用 HTTPS：端到端加密(crypto.subtle)与连麦(getUserMedia)都要求「安全上下文」，
// 即 https:// 或 http://localhost。局域网用 http://<IP> 访问时 crypto.subtle 为 undefined，
// 因此提供自签名证书方案，让局域网也能走安全上下文。
const USE_HTTPS = process.argv.includes('--https') || process.env.HTTPS === '1' || process.env.HTTPS === 'true';

const app = express();
app.disable('x-powered-by');

// 生产环境建议让 Node 只监听 127.0.0.1，再由 Nginx/Caddy 负责公网 HTTPS。
// TRUST_PROXY=1 时，Express 会信任反代传来的 X-Forwarded-* 头，便于后续按 HTTPS/来源做判断。
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
if (TRUST_PROXY) app.set('trust proxy', 1);

let server;
if (USE_HTTPS) {
  try {
    const { key, cert } = loadOrCreateCert();
    server = https.createServer({ key, cert }, app);
  } catch (e) {
    console.error('[https] 生成/加载证书失败，回退为 HTTP：', e.message);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ===================================================================
//  B 站链接解析（服务端只解析地址，不传输视频；各客户端自行从 B 站 CDN 拉流）
// ===================================================================
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 清晰度档位（qn 值与 B 站一致）。默认尽量高，解析时把全部档位都拿到，前端可选
const BILI_QN = {
  '360P': 16,
  '480P': 32,
  '720P': 64,
  '1080P': 80,
  '1080P+': 112,
  '4K': 120,
};

const biliCache = new Map(); // bvid -> { ts, data }

async function biliGet(url) {
  const r = await fetch(url, { headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com' } });
  return r.json();
}

function biliMixinKey(img, sub) {
  const table = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  const s = img + sub;
  let mk = '';
  for (const i of table) mk += s[i];
  return mk.slice(0, 32);
}

function biliSignWbi(params, mixin) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const sorted = Object.keys(p).sort().reduce((o, k) => { o[k] = p[k]; return o; }, {});
  const query = new URLSearchParams(sorted).toString();
  const wbi = crypto.createHash('md5').update(query + mixin).digest('hex');
  sorted.wbi_sign = wbi;
  return sorted;
}

function biliNorm(track) {
  const sb = track.SegmentBase || {};
  const init = sb.Initialization;
  const idx = sb.indexRange;
  return {
    baseUrl: track.baseUrl,
    codecs: track.codecs,
    bandwidth: track.bandwidth,
    mimeType: track.mimeType || 'video/mp4',
    initRange: typeof init === 'string' ? init : (init && init.range) || null,
    indexRange: typeof idx === 'string' ? idx : (idx && idx.range) || null,
  };
}

function biliPickBest(list) {
  return list.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

// 按清晰度名从 dash.video 列表里挑一条
function biliPickByQn(list, qnLabel) {
  const qn = BILI_QN[qnLabel] || BILI_QN['720P'];
  // dash.video 里每条带 id（即 qn），优先精确匹配；否则按带宽降序找最接近且小于等于的
  const exact = list.find(t => t.id === qn);
  if (exact) return exact;
  // B 站可能没返回该档位（如非大会员无 1080P+）——取小于等于请求档位里最高的一条
  const lower = list.filter(t => (t.id || 0) <= qn).sort((a, b) => (b.id || 0) - (a.id || 0));
  return lower[0] || biliPickBest(list);
}

async function resolveBili(bvid, qnLabel = '720P') {
  const cacheKey = `${bvid}@${qnLabel}`;
  const cached = biliCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.data;

  const view = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (view.code !== 0 || !view.data) throw new Error(view.message || '获取视频信息失败');
  const cid = view.data.cid;

  let play = null;
  // 先尝试 wbi 签名（部分视频必须）；失败则退回无签名
  try {
    const keys = await biliGet('https://api.bilibili.com/x/client/wbi/keys');
    const kd = keys.data || {};
    const img = kd.img_key || (kd.wbi_img ? kd.wbi_img.img_url.split('/').pop().replace('.png', '') : '');
    const sub = kd.sub_key || (kd.wbi_img ? kd.wbi_img.sub_url.split('/').pop().replace('.png', '') : '');
    const mixin = biliMixinKey(img, sub);
    // fnval=16 取 dash；fourk=1 允许 4K/1080P+ 档位
    const sp = biliSignWbi({ bvid, cid, qn: BILI_QN[qnLabel] || 80, fnval: 16, fourk: 1 }, mixin);
    play = await biliGet(`https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(sp).toString()}`);
  } catch (e) {
    play = await biliGet(`https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}&cid=${cid}&qn=${BILI_QN[qnLabel] || 80}&fnval=16&fourk=1`);
  }

  if (!play || play.code !== 0 || !play.data || !play.data.dash) {
    throw new Error((play && play.message) || '解析播放地址失败');
  }
  const dash = play.data.dash;
  const video = biliPickByQn(dash.video, qnLabel);
  const audio = biliPickBest(dash.audio);
  // 用 B 站返回的 accept_quality / accept_description 构造清晰度下拉（这是该视频真实可用的档位）
  const acceptQ = play.data.accept_quality || [];
  const acceptD = play.data.accept_description || [];
  const qualities = acceptQ.map((q, i) => ({
    label: (acceptD[i] || `${q}P`).replace('高清 ', '').replace('清晰 ', '').replace('流畅 ', '') || `${q}P`,
    qn: q,
    bandwidth: 0,
  })).sort((a, b) => b.qn - a.qn);
  // 实际选中的档位（biliPickByQn 命中的 id 对应回 label）
  const pickedLabel = (() => {
    const hit = qualities.find((q) => q.qn === video.id);
    return hit ? hit.label : qnLabel;
  })();
  const data = {
    title: view.data.title,
    duration: view.data.duration,
    video: biliNorm(video),
    audio: biliNorm(audio),
    quality: pickedLabel,
    qualities,
  };
  biliCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

app.get('/api/resolve-bili', async (req, res) => {
  const url = (req.query.url || '').toString();
  const qn = (req.query.qn || '720P').toString();
  const m = url.match(/BV[0-9A-Za-z]+/);
  if (!m) return res.status(400).json({ error: '无效的 B 站链接，需包含 BV 号' });
  try {
    const data = await resolveBili(m[0], qn);
    res.json({ bvid: m[0], ...data });
  } catch (e) {
    res.status(502).json({ error: e.message || '解析失败' });
  }
});

// 媒体代理：绕过 B 站 m4s 防盗链（浏览器直连不会带 Referer），并透传 Range 支持拖动进度
// B 站 CDN 域名较多（bilivideo / mcdn / akamaized 等），白名单需覆盖全部
const BILI_MEDIA_HOST = /(^|\.)(bilibili\.com|hdslb\.com|bilivideo\.com|bilivideo\.cn|akamaized\.net)$/i;
app.get('/api/bili-media', async (req, res) => {
  const url = (req.query.url || '').toString();
  const kind = (req.query.kind || 'video').toString();
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: '无效的媒体地址' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).json({ error: '协议不支持' });
  if (!BILI_MEDIA_HOST.test(parsed.hostname)) return res.status(403).json({ error: '仅允许 B 站媒体地址' });

  const fwd = {
    'User-Agent': BILI_UA,
    'Referer': 'https://www.bilibili.com',
    'Origin': 'https://www.bilibili.com',
  };
  if (req.headers.range) fwd['Range'] = req.headers.range;
  try {
    const r = await fetch(url, { headers: fwd, redirect: 'follow' });
    res.status(r.status);
    const pass = ['content-range', 'content-length', 'accept-ranges', 'content-encoding'];
    pass.forEach((h) => { const v = r.headers.get(h); if (v) res.setHeader(h, v); });
    // B 站返回的 m4s 多为 application/octet-stream，浏览器不会当视频/音频解码，强制修正 MIME
    if (kind === 'audio') res.setHeader('content-type', 'audio/mp4');
    else res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'public, max-age=300');
    if (!r.body) return res.end();
    const nodeStream = Readable.fromWeb(r.body);
    nodeStream.on('error', () => { try { res.destroy(); } catch (e) {} });
    nodeStream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: '媒体代理失败：' + e.message });
    else try { res.destroy(); } catch (e2) {}
  }
});

// ===================================================================
//  房间 / Socket 通信
// ===================================================================
const rooms = new Map(); // id -> { id, name, users: Map, video, createdAt }

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', ({ roomName, userName }, cb) => {
    const id = genRoomId();
    const room = { id, name: roomName || '观影房', users: new Map(), video: { url: '', fileName: '', bili: '', playing: false, currentTime: 0, lastControllerId: '', lastController: '' }, createdAt: Date.now() };
    rooms.set(id, room);
    socket.join(id);
    currentRoom = id;
    const user = { id: socket.id, name: userName || '匿名', isHost: true, audio: false };
    room.users.set(socket.id, user);
    if (typeof cb === 'function') cb({ roomId: id });
    io.to(id).emit('room:users', [...room.users.values()]);
  });

  socket.on('room:join', ({ roomId, userName }, cb) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return cb && cb({ error: '房间不存在' });
    socket.join(roomId.toUpperCase());
    currentRoom = roomId.toUpperCase();
    const user = { id: socket.id, name: userName || '匿名', isHost: false, audio: false };
    room.users.set(socket.id, user);
    socket.to(roomId.toUpperCase()).emit('user:join', { user });
    socket.emit('room:state', { room: { id: room.id, name: room.name }, users: [...room.users.values()], video: room.video });
    io.to(currentRoom).emit('room:users', [...room.users.values()]);
    cb && cb({ ok: true });
  });

  socket.on('user:rename', ({ name }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (u && name) {
      u.name = name.toString().slice(0, 20);
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    }
  });

  function leaveRoom() {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(currentRoom).emit('user:leave', { id: socket.id });
    closePeerAll();
    if (room.users.size === 0) {
      rooms.delete(currentRoom);
    } else {
      // 房主离开，推选新房主
      const host = [...room.users.values()].find((u) => u.isHost);
      if (!host) { const first = [...room.users.values()][0]; if (first) first.isHost = true; }
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    }
    socket.leave(currentRoom);
    currentRoom = null;
  }
  socket.on('disconnect', leaveRoom);
  socket.on('room:leave', leaveRoom);

  // ---------- 密钥协商中转（服务端只转发公钥/加密信封，不接触群密钥明文） ----------
  socket.on('crypto:pubkey', ({ pubKey }) => {
    const room = rooms.get(currentRoom);
    if (!room || !pubKey) return;
    // 转发给房间内其他人；持有群密钥者（房主）会回应
    socket.to(currentRoom).emit('crypto:pubkey', { fromId: socket.id, pubKey });
  });
  socket.on('crypto:groupkey', ({ toId, pubKey, env }) => {
    const room = rooms.get(currentRoom);
    if (!room || !toId || !env) return;
    io.to(toId).emit('crypto:groupkey', { fromId: socket.id, pubKey, env });
  });

  // ---------- 聊天（服务端只转发密文，不解析明文） ----------
  socket.on('chat:send', (payload, cb) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    // 仅接受加密字段 { cipher }；服务端不接触明文
    if (!payload || typeof payload.cipher !== 'string') return;
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      user: u ? u.name : '匿名',
      ts: Date.now(),
      cipher: payload.cipher.slice(0, 8 * 1024 * 1024), // 安全上限
    };
    // 转发给房间内其他人：self=false（左侧）
    socket.to(currentRoom).emit('chat:message', { ...message, self: false });
    // 回传给发送者本人：self=true（右侧对齐 + 本地解密渲染）
    socket.emit('chat:message', { ...message, self: true });
    if (typeof cb === 'function') cb({ ok: true });
  });

  // ---------- 视频：加载 ----------
  socket.on('video:set', ({ url, fileName, bili }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.video = {
      url: (url || '').toString(),
      fileName: (fileName || '').toString(),
      bili: (bili || '').toString(),
      playing: false,
      currentTime: 0,
      updatedAt: Date.now(),
      lastControllerId: '',
      lastController: '',
    };
    io.to(currentRoom).emit('video:state', { ...room.video, action: 'load' });
  });

  // ---------- 视频：播放控制（核心同步）----------
  socket.on('video:action', ({ action, time }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    room.video.playing = action === 'play';
    if (typeof time === 'number' && isFinite(time)) room.video.currentTime = time;
    room.video.updatedAt = Date.now();
    room.video.lastControllerId = socket.id;
    room.video.lastController = u ? u.name : '';
    socket.to(currentRoom).emit('video:action', { action, time, by: u ? u.name : '', byId: socket.id, serverTime: Date.now() });
  });

  // 周期纠偏
  socket.on('video:sync', ({ time }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    socket.to(currentRoom).emit('video:sync', { time, byId: socket.id });
  });

  // ---------- 连麦：WebRTC 信令中转 ----------
  socket.on('user:audio', ({ enabled }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (u) u.audio = !!enabled;
    io.to(currentRoom).emit('room:users', [...room.users.values()]);
  });

  socket.on('rtc:signal', ({ to, data }) => {
    io.to(to).emit('rtc:signal', { from: socket.id, data });
  });

  function closePeerAll() {
    socket.to(currentRoom).emit('user:audio', { id: socket.id, enabled: false });
  }
});

// ===================================================================
//  HTTPS 自签名证书（含局域网 IP，便于浏览器信任后走安全上下文）
// ===================================================================
function localIPs() {
  const set = new Set(['localhost', '127.0.0.1']);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) set.add(ni.address);
    }
  }
  return [...set];
}

function loadOrCreateCert() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'server.key');
  const certPath = path.join(dir, 'server.cert');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  // 首次运行：用 selfsigned 生成自签名证书，SAN 包含本机所有局域网 IP
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const altNames = localIPs().map((ip) => (ip.includes('.') ? { type: 'ip', ip } : { type: 'dns', value: ip }));
  const pems = selfsigned.generate(attrs, { days: 3650, keySize: 2048, algorithm: 'sha256', altNames });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('[https] 已生成自签名证书，SAN:', altNames.map((a) => a.ip || a.value).join(', '));
  return { key: pems.private, cert: pems.cert };
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '';
const proto = USE_HTTPS && server instanceof https.Server ? 'https' : 'http';
const listenTarget = HOST ? `${HOST}:${PORT}` : `0.0.0.0:${PORT}`;
const onListen = () => {
  console.log(`一起看 已启动: ${proto}://${listenTarget}`);
  if (HOST && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`本机访问: ${proto}://localhost:${PORT}`);
  }
  if (TRUST_PROXY) {
    console.log('已启用 trust proxy，适合部署在 Nginx/Caddy HTTPS 反代后面。');
  }
  if (proto === 'https') {
    const lan = localIPs().find((i) => i !== 'localhost' && i !== '127.0.0.1');
    console.log(`局域网访问（首次需在浏览器点击「高级 → 继续访问」信任自签名证书）:`);
    console.log(`  ${proto}://${lan || '<本机局域网IP>'}:${PORT}`);
  }
};

if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);

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
const initSqlJs = require('sql.js');

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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================================
//  SQLite persistence (sql.js, no native build required)
// ===================================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'watchparty.sqlite');
let SQL = null;
let db = null;
let persistTimer = null;

const DEFAULT_VIDEO = {
  url: '',
  fileName: '',
  bili: '',
  kind: '',         // direct | bili | hls | iframe | file
  iframeUrl: '',
  label: '',
  iframeProvider: '',
  playing: false,
  currentTime: 0,
  lastControllerId: '',
  lastController: '',
};

const dbReady = initPersistence();

async function initPersistence() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
  });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      avatar_color TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_user_id TEXT NOT NULL DEFAULT '',
      video_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_updated_at ON rooms(updated_at);

    -- 端到端加密聊天历史的存档：服务端只存密文，做"序号 + 分页 + 长度"索引；解密发生在客户端
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      cipher TEXT NOT NULL,
      seq INTEGER NOT NULL,
      length INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);

    -- 房间成员关系：记录谁进过哪个房、最后在线时间、是否房主
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      is_host INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
  `);
  persistDbNow();
  console.log(`[db] SQLite ready: ${DB_PATH}`);
}

function persistDbNow() {
  if (!db) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_PATH);
}

function schedulePersist(delay = 250) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { persistDbNow(); } catch (e) { console.error('[db] persist failed:', e); }
  }, delay);
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return null;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

function dbInsert(sql, params = []) {
  // 用于 INSERT 并取回 last_insert_rowid
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
    return db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  } finally {
    stmt.free();
  }
}

// 房间内聊天 seq 单调计数：缓存到内存 Map + 落 messages 表
function roomNextSeq(roomId) {
  if (!roomId) return 1;
  // 当前 room 已有的最大 seq
  const last = dbGet('SELECT MAX(seq) AS max_seq FROM messages WHERE room_id = ?', [roomId]);
  const next = (last && typeof last.max_seq === 'number' && last.max_seq > 0) ? (last.max_seq + 1) : 1;
  return next;
}

function saveMessage({ roomId, userId, userName, cipher, seq, createdAt }) {
  const len = String(cipher || '').length;
  dbRun(
    'INSERT INTO messages (room_id, user_id, user_name, cipher, seq, length, created_at) VALUES (?,?,?,?,?,?,?)',
    [roomId, String(userId || ''), String(userName || ''), String(cipher || ''), seq, len, createdAt]
  );
  schedulePersist(800);
}

function upsertRoomMember({ roomId, userId, displayName, isHost }) {
  if (!roomId || !userId) return;
  dbRun(
    `INSERT INTO room_members (room_id, user_id, display_name, is_host, last_seen_at) VALUES (?,?,?,?,?)
     ON CONFLICT(room_id, user_id) DO UPDATE SET display_name=excluded.display_name, is_host=MAX(room_members.is_host, excluded.is_host), last_seen_at=excluded.last_seen_at`,
    [roomId, userId, displayName || '', isHost ? 1 : 0, Date.now()]
  );
  schedulePersist(1200);
}

function normalizeId(value, fallback = '') {
  const s = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(s) ? s : fallback;
}

function normalizeRoomId(roomId) {
  return String(roomId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function cleanText(value, fallback, max = 40) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, max);
}

function cleanAvatar(value) {
  const avatar = String(value || '').trim();
  if (!avatar) return '';
  if (avatar.length > 512 * 1024) return '';
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(avatar)) return '';
  return avatar;
}

function avatarColor(seed) {
  const colors = ['#6366f1', '#14b8a6', '#f43f5e', '#f59e0b', '#22c55e', '#0ea5e9', '#a855f7'];
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length];
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar || '',
    avatarColor: row.avatar_color || avatarColor(row.id || row.name),
  };
}

function upsertUser({ id, name, avatar }) {
  const now = Date.now();
  const userId = normalizeId(id) || crypto.randomUUID();
  const safeName = cleanText(name, `用户${userId.slice(0, 4)}`, 20);
  const safeAvatar = cleanAvatar(avatar);
  const existing = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  const finalAvatar = safeAvatar || (existing && existing.avatar) || '';
  const finalColor = (existing && existing.avatar_color) || avatarColor(userId);
  dbRun(`
    INSERT INTO users (id, name, avatar, avatar_color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      avatar = excluded.avatar,
      avatar_color = excluded.avatar_color,
      updated_at = excluded.updated_at
  `, [userId, safeName, finalAvatar, finalColor, existing ? existing.created_at : now, now]);
  schedulePersist();
  return publicUser(dbGet('SELECT * FROM users WHERE id = ?', [userId]));
}

function defaultRoomVideo(video = {}) {
  return { ...DEFAULT_VIDEO, ...(video || {}) };
}

function roomFromRow(row) {
  if (!row) return null;
  let video = {};
  try { video = JSON.parse(row.video_json || '{}'); } catch (e) { video = {}; }
  return {
    id: row.id,
    name: row.name,
    hostUserId: row.host_user_id || '',
    users: new Map(),
    video: defaultRoomVideo(video),
    createdAt: row.created_at || Date.now(),
    updatedAt: row.updated_at || Date.now(),
  };
}

function saveRoom(room, { flushDelay = 250 } = {}) {
  if (!room) return;
  const now = Date.now();
  const createdAt = room.createdAt || now;
  room.updatedAt = now;
  dbRun(`
    INSERT INTO rooms (id, name, host_user_id, video_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      host_user_id = excluded.host_user_id,
      video_json = excluded.video_json,
      updated_at = excluded.updated_at
  `, [room.id, cleanText(room.name, '观影房', 40), room.hostUserId || '', JSON.stringify(defaultRoomVideo(room.video)), createdAt, now]);
  schedulePersist(flushDelay);
}

function loadRoom(roomId) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  if (rooms.has(id)) return rooms.get(id);
  const row = dbGet('SELECT * FROM rooms WHERE id = ?', [id]);
  const room = roomFromRow(row);
  if (room) rooms.set(id, room);
  return room;
}

function roomExists(roomId) {
  const id = normalizeRoomId(roomId);
  return !!id && (!!rooms.get(id) || !!dbGet('SELECT id FROM rooms WHERE id = ?', [id]));
}

function makeRoomUser(socketId, profile, room) {
  const firstActiveUser = room.users.size === 0;
  return {
    id: socketId,
    userId: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    avatarColor: profile.avatarColor,
    isHost: firstActiveUser || room.hostUserId === profile.id,
    audio: false,
    level: 0,
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

app.post('/api/users/bootstrap', async (req, res) => {
  try {
    await dbReady;
    const body = req.body || {};
    res.json(upsertUser({ id: body.userId || body.id, name: body.name, avatar: body.avatar }));
  } catch (e) {
    console.error('[api] user bootstrap failed:', e);
    res.status(500).json({ error: '用户初始化失败' });
  }
});

app.patch('/api/users/:id', async (req, res) => {
  try {
    await dbReady;
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效用户 ID' });
    res.json(upsertUser({ ...(req.body || {}), id }));
  } catch (e) {
    console.error('[api] user update failed:', e);
    res.status(500).json({ error: '用户资料保存失败' });
  }
});

app.get('/r/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', async (req, res) => {
  try {
    await dbReady;
    res.json({ ok: true, rooms: rooms.size, db: 'ok' });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error' });
  }
});

// 最近活跃房间列表（按更新时间倒序），含在线人数与当前视频 label。
// 在线人数来自内存 rooms Map（在线 socketId count），其它字段来自 SQLite。
app.get('/api/rooms', async (req, res) => {
  try {
    await dbReady;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const rows = dbAll(
      `SELECT id, name, host_user_id, video_json, created_at, updated_at FROM rooms ORDER BY updated_at DESC LIMIT ?`,
      [limit]
    );
    const out = rows.map((r) => {
      let vj = {};
      try { vj = JSON.parse(r.video_json || '{}'); } catch (e) {}
      const online = (function () {
        const room = rooms.get(r.id);
        if (!room) return 0;
        return room.users.size;
      })();
      const label = vj.label || vj.fileName || vj.bili || vj.url || (vj.kind === 'iframe' && vj.iframeUrl) || '';
      return {
        id: r.id,
        name: r.name,
        hostUserId: r.host_user_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        online,
        video: {
          kind: vj.kind || '',
          title: vj.label || '',
          bili: vj.bili || '',
          url: vj.url || '',
          label,
        },
      };
    });
    res.json({ rooms: out });
  } catch (e) {
    res.status(500).json({ error: 'room list failed' });
  }
});

// 拉某个房间的历史密文，按 seq 倒序取分页（即往前拉更早的消息）
// 用法：fromSeq=最新已收到的 seq；limit=20 → 返回 seq < fromSeq 的最近 20 条（升序）
app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    await dbReady;
    const rid = normalizeRoomId(req.params.id);
    if (!rid) return res.status(400).json({ error: '无效房间号' });
    const room = loadRoom(rid);
    if (!room && !roomExists(rid)) return res.status(404).json({ error: '房间不存在' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const fromSeq = parseInt(req.query.fromSeq, 10);
    let rows;
    if (Number.isFinite(fromSeq) && fromSeq > 0) {
      rows = dbAll(
        'SELECT seq, user_name, cipher, created_at FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
        [rid, fromSeq, limit]
      );
    } else {
      rows = dbAll(
        'SELECT seq, user_name, cipher, created_at FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?',
        [rid, limit]
      );
    }
    rows.reverse();
    const out = rows.map((r) => ({ seq: r.seq, user: r.user_name || '匿名', ts: r.created_at, cipher: r.cipher }));
    res.json({ messages: out });
  } catch (e) {
    res.status(500).json({ error: 'history fetch failed' });
  }
});

// 某用户最近去过哪几个房间（基于 room_members.last_seen_at 倒序）
app.get('/api/users/:id/rooms', async (req, res) => {
  try {
    await dbReady;
    const userId = normalizeId(req.params.id);
    if (!userId) return res.status(400).json({ error: '无效用户 ID' });
    const rows = dbAll(
      `SELECT rm.room_id AS id, rm.display_name, rm.is_host, rm.last_seen_at, r.name, r.updated_at
       FROM room_members rm LEFT JOIN rooms r ON r.id = rm.room_id
       WHERE rm.user_id = ? ORDER BY rm.last_seen_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ rooms: rows.map((r) => ({ id: r.id, name: r.name || '', displayName: r.display_name || '', isHost: !!r.is_host, lastSeenAt: r.last_seen_at, updatedAt: r.updated_at })) });
  } catch (e) {
    res.status(500).json({ error: 'user rooms failed' });
  }
});

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
const ROOM_EMPTY_TTL_MS = Number(process.env.ROOM_EMPTY_TTL_MS) || 5 * 60 * 1000;

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

async function resolveBili(bvid, qnLabel = '720P', { force = false } = {}) {
  const cacheKey = `${bvid}@${qnLabel}`;
  if (force) biliCache.delete(cacheKey);
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
  const force = String(req.query.force || '') === '1' || String(req.query.force || '').toLowerCase() === 'true';
  const m = url.match(/BV[0-9A-Za-z]+/);
  if (!m) return res.status(400).json({ error: '无效的 B 站链接，需包含 BV 号' });
  try {
    const data = await resolveBili(m[0], qn, { force });
    res.json({ bvid: m[0], ...data });
  } catch (e) {
    res.status(502).json({ error: e.message || '解析失败' });
  }
});

// 媒体代理：绕过 B 站 m4s 防盗链（浏览器直连不会带 Referer），并透传 Range 支持拖动进度
// B 站 CDN 域名较多（bilivideo.com / bilivideo.cn / mcdn.bilivideo.cn / *.hdslb.com / akamaized 系列），白名单需覆盖全部
function isBiliMediaHost(host) {
  const h = String(host || '').toLowerCase();
  const trusted = ['bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'hdslb.com', 'hdslb.net', 'akamaized.net', 'mcdn.bilivideo.cn'];
  return trusted.some((t) => h === t || h.endsWith('.' + t));
}
app.get('/api/bili-media', async (req, res) => {
  const url = (req.query.url || '').toString();
  const kind = (req.query.kind || 'video').toString();
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: '无效的媒体地址' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).json({ error: '协议不支持' });
  if (!isBiliMediaHost(parsed.hostname)) return res.status(403).json({ error: '仅允许 B 站媒体地址' });

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
const rooms = new Map(); // id -> { id, name, hostUserId, users: Map, video, createdAt }

function keepRoom(room) {
  if (room && room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    if (!roomExists(s)) return s;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', async ({ roomName, userName, userId, avatar }, cb) => {
    try {
      await dbReady;
      const profile = upsertUser({ id: userId, name: userName, avatar });
      const id = genRoomId();
      const now = Date.now();
      const room = {
        id,
        name: cleanText(roomName, '观影房', 40),
        hostUserId: profile.id,
        users: new Map(),
        video: defaultRoomVideo(),
        createdAt: now,
        updatedAt: now,
      };
      rooms.set(id, room);
      keepRoom(room);
      socket.join(id);
      currentRoom = id;
      const user = makeRoomUser(socket.id, profile, room);
      user.isHost = true;
      room.users.set(socket.id, user);
      saveRoom(room, { flushDelay: 0 });
      upsertRoomMember({ roomId: id, userId: profile.id, displayName: profile.name || '', isHost: true });
      // 房主新建房间，自身就已经"在房"：补发一份 room:state（含空历史），与 room:join 行为保持一致
      socket.emit('room:state', {
        room: publicRoom(room),
        users: [...room.users.values()],
        video: room.video,
        recentMessages: [],
        maxSeq: 0,
      });
      if (typeof cb === 'function') cb({ roomId: id, user: profile });
      io.to(id).emit('room:users', [...room.users.values()]);
    } catch (e) {
      console.error('[room:create] failed:', e);
      if (typeof cb === 'function') cb({ error: '创建房间失败' });
    }
  });

  socket.on('room:join', async ({ roomId, userName, userId, avatar }, cb) => {
    try {
      await dbReady;
      const rid = normalizeRoomId(roomId);
      const room = loadRoom(rid);
      if (!room) return cb && cb({ error: '房间不存在' });
      keepRoom(room);
      const profile = upsertUser({ id: userId, name: userName, avatar });
      socket.join(rid);
      currentRoom = rid;
      const user = makeRoomUser(socket.id, profile, room);
      if (user.isHost && !room.hostUserId) {
        room.hostUserId = profile.id;
        saveRoom(room);
      }
      room.users.set(socket.id, user);
      // 房间成员表落库：用于"谁进过这个房"/"用户最近房间"等扩展
      upsertRoomMember({ roomId: rid, userId: profile.id, displayName: profile.name || '', isHost: user.isHost });
      socket.to(rid).emit('user:join', { user });
      // 拉取最近 50 条聊天密文交给客户端；解不出密文则按占位渲染（E2E 限制新成员看不到旧明文）
      const recent = dbAll(
        'SELECT seq, user_name, cipher, created_at FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 50',
        [rid]
      ).reverse().map((r) => ({ seq: r.seq, user: r.user_name || '匿名', ts: r.created_at, cipher: r.cipher }));
      socket.emit('room:state', {
        room: publicRoom(room),
        users: [...room.users.values()],
        video: room.video,
        recentMessages: recent,
        maxSeq: recent.length ? recent[recent.length - 1].seq : 0,
      });
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
      cb && cb({ ok: true, user: profile });
    } catch (e) {
      console.error('[room:join] failed:', e);
      cb && cb({ error: '加入房间失败' });
    }
  });

  socket.on('user:rename', ({ name }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (u && name) {
      u.name = cleanText(name, u.name || '匿名', 20);
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    }
  });

  socket.on('user:profile', async ({ userId, name, avatar }) => {
    try {
      await dbReady;
      const room = rooms.get(currentRoom);
      if (!room) return;
      const u = room.users.get(socket.id);
      if (!u || (userId && u.userId !== userId)) return;
      const profile = upsertUser({ id: u.userId, name, avatar });
      u.name = profile.name;
      u.avatar = profile.avatar;
      u.avatarColor = profile.avatarColor;
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    } catch (e) {
      console.error('[user:profile] failed:', e);
    }
  });

  function leaveRoom() {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(currentRoom).emit('user:leave', { id: socket.id });
    closePeerAll();
    if (room.users.size === 0) {
      const roomId = currentRoom;
      room.emptyTimer = setTimeout(() => {
        const latest = rooms.get(roomId);
        if (latest && latest.users.size === 0) rooms.delete(roomId);
      }, ROOM_EMPTY_TTL_MS);
    } else {
      // 房主离开，推选新房主
      const host = [...room.users.values()].find((u) => u.isHost);
      if (!host) {
        const first = [...room.users.values()][0];
        if (first) {
          first.isHost = true;
          room.hostUserId = first.userId || room.hostUserId;
          saveRoom(room);
        }
      }
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
    const cipher = payload.cipher.slice(0, 8 * 1024 * 1024); // 安全上限
    const seq = roomNextSeq(currentRoom);
    const ts = Date.now();
    saveMessage({
      roomId: currentRoom,
      userId: u ? u.userId : '',
      userName: u ? u.name : '匿名',
      cipher, seq, createdAt: ts,
    });
    const message = {
      id: `${ts}-${Math.random().toString(36).slice(2, 6)}`,
      user: u ? u.name : '匿名',
      ts,
      cipher,
      seq,
    };
    // 转发给房间内其他人：self=false（左侧）
    socket.to(currentRoom).emit('chat:message', { ...message, self: false });
    // 回传给发送者本人：self=true（右侧对齐 + 本地解密渲染）
    socket.emit('chat:message', { ...message, self: true });
    if (typeof cb === 'function') cb({ ok: true, seq });
  });

  // ---------- 视频：加载 ----------
  socket.on('video:set', (payload) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const str = (v) => (v == null ? '' : String(v));
    // 默认可由旧字段推断 kind，保持向后兼容
    const kind = str(payload.kind || (payload.bili ? 'bili' : payload.iframeUrl ? 'iframe' : payload.url ? (payload.url.includes('.m3u8') ? 'hls' : 'direct') : payload.fileName ? 'file' : ''));
    room.video = {
      url: str(payload.url),
      fileName: str(payload.fileName),
      bili: str(payload.bili),
      kind,
      iframeUrl: str(payload.iframeUrl),
      label: str(payload.label),
      iframeProvider: str(payload.iframeProvider),
      playing: false,
      currentTime: 0,
      updatedAt: Date.now(),
      lastControllerId: '',
      lastController: '',
    };
    saveRoom(room);
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
    saveRoom(room, { flushDelay: 1200 });
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
    const isEnabled = !!enabled;
    if (u) {
      u.audio = isEnabled;
      if (!u.audio) u.level = 0;
    }
    io.to(currentRoom).emit('room:users', [...room.users.values()]);
    io.to(currentRoom).emit('user:audio', { id: socket.id, enabled: isEnabled });
  });

  socket.on('user:speaking', ({ level }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (!u || !u.audio) return;
    const nextLevel = Math.max(0, Math.min(1, Number(level) || 0));
    u.level = nextLevel;
    socket.to(currentRoom).emit('user:speaking', { id: socket.id, level: nextLevel });
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

function shutdown() {
  try {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistDbNow();
  } catch (e) {
    console.error('[db] shutdown persist failed:', e);
  }
}
process.once('SIGINT', () => { shutdown(); process.exit(0); });
process.once('SIGTERM', () => { shutdown(); process.exit(0); });

dbReady.then(() => {
  if (HOST) server.listen(PORT, HOST, onListen);
  else server.listen(PORT, onListen);
}).catch((e) => {
  console.error('[db] failed to initialize SQLite:', e);
  process.exit(1);
});

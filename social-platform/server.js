/**
 * 一起看 · 多人观影社交平台 —— 服务端
 *
 * 核心思想：
 *  - 视频不在服务端传输，每个人在本地用自己的网络/文件播放；
 *  - 服务端仅负责房间管理、聊天转发、播放进度同步、以及 WebRTC 连麦的信令中转。
 *  - 公网部署：Session Token 鉴权、房间 owner/activeHost 分离、限流、可选房间密码。
 *
 * 技术栈：Express(静态资源) + Socket.IO(实时通信) + sql.js
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

const USE_HTTPS = process.argv.includes('--https') || process.env.HTTPS === '1' || process.env.HTTPS === 'true';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const SESSION_TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30);
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const ROOM_EMPTY_TTL_MS = Number(process.env.ROOM_EMPTY_TTL_MS) || 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 12000;
const KICK_BAN_MS = Math.max(0, Number(process.env.KICK_BAN_MS) || 10 * 60 * 1000);
const BILI_PROXY_ENABLED = !(process.env.BILI_PROXY_ENABLED === '0' || process.env.BILI_PROXY_ENABLED === 'false');
const BILI_PROXY_MAX_MB_PER_IP_HOUR = Math.max(50, Number(process.env.BILI_PROXY_MAX_MB_PER_IP_HOUR) || 2048);
const CHAT_CIPHER_MAX = 512 * 1024;
const AVATAR_MAX = 200 * 1024;

let PKG_VERSION = '1.0.0';
try { PKG_VERSION = require('./package.json').version || PKG_VERSION; } catch (e) { /* ignore */ }

function parseCorsOrigin() {
  const raw = (process.env.CORS_ORIGIN || '').trim();
  if (!raw || raw === '*') return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return '*';
  if (list.length === 1) return list[0];
  return list;
}
const CORS_ORIGIN = parseCorsOrigin();

function parseIceServers() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  const raw = (process.env.ICE_SERVERS || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (e) {
    console.error('[ice] ICE_SERVERS JSON 解析失败，使用默认 STUN');
  }
  return fallback;
}
const ICE_SERVERS = parseIceServers();

const app = express();
app.disable('x-powered-by');
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

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

app.use(express.json({ limit: '1mb' }));

// ===================================================================
//  Rate limiting (in-process sliding window)
// ===================================================================
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now >= e.reset) {
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.count += 1;
    if (hits.size > 20000) {
      for (const [k, v] of hits) {
        if (now >= v.reset) hits.delete(k);
      }
    }
    return e.count <= max;
  };
}

const rateHttpGlobal = makeRateLimiter({ windowMs: 60_000, max: 120 });
const rateLookup = makeRateLimiter({ windowMs: 60_000, max: 10 });
const rateReclaim = makeRateLimiter({ windowMs: 60_000, max: 10 });
const ratePassword = makeRateLimiter({ windowMs: 60_000, max: 10 });
const rateResolveBili = makeRateLimiter({ windowMs: 60_000, max: 20 });
const rateBiliMedia = makeRateLimiter({ windowMs: 60_000, max: 60 });
const rateChat = makeRateLimiter({ windowMs: 60_000, max: 20 });
const rateCreateRoom = makeRateLimiter({ windowMs: 60_000, max: 5 });
const rateSpeaking = makeRateLimiter({ windowMs: 1000, max: 8 });

const biliMediaConcurrent = new Map(); // ip -> count
const biliMediaBytes = new Map(); // ip -> { bytes, reset }

function clientIp(reqOrSocket) {
  if (reqOrSocket && reqOrSocket.headers) {
    const xf = reqOrSocket.headers['x-forwarded-for'];
    if (TRUST_PROXY && xf) return String(xf).split(',')[0].trim();
    return reqOrSocket.ip || reqOrSocket.socket?.remoteAddress || 'unknown';
  }
  if (reqOrSocket && reqOrSocket.handshake) {
    const xf = reqOrSocket.handshake.headers['x-forwarded-for'];
    if (TRUST_PROXY && xf) return String(xf).split(',')[0].trim();
    return reqOrSocket.handshake.address || 'unknown';
  }
  return 'unknown';
}

app.use((req, res, next) => {
  const ip = clientIp(req);
  if (!rateHttpGlobal(ip)) {
    console.warn('[rate] http global', ip, req.path);
    return res.status(429).json({ error: '请求过快，请稍后再试' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ===================================================================
//  SQLite persistence (sql.js)
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
  kind: '',
  iframeUrl: '',
  label: '',
  iframeProvider: '',
  playing: false,
  currentTime: 0,
  lastControllerId: '',
  lastController: '',
};

const rooms = new Map();
const reclaimTokens = new Map(); // token -> { userId, expiresAt }
const kickBans = new Map(); // `${roomId}:${userId}` -> untilMs

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
    CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  const userCols = dbAll(`PRAGMA table_info(users)`).map((r) => r.name);
  if (!userCols.includes('password')) {
    try { db.run(`ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT ''`); } catch (e) { /* ignore */ }
  }
  if (!userCols.includes('password_salt')) {
    try { db.run(`ALTER TABLE users ADD COLUMN password_salt TEXT NOT NULL DEFAULT ''`); } catch (e) { /* ignore */ }
  }

  const roomCols = dbAll(`PRAGMA table_info(rooms)`).map((r) => r.name);
  if (!roomCols.includes('owner_user_id')) {
    try { db.run(`ALTER TABLE rooms ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''`); } catch (e) { /* ignore */ }
    try {
      db.run(`UPDATE rooms SET owner_user_id = host_user_id WHERE owner_user_id = '' OR owner_user_id IS NULL`);
    } catch (e) { /* ignore */ }
  }
  if (!roomCols.includes('password_hash')) {
    try { db.run(`ALTER TABLE rooms ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''`); } catch (e) { /* ignore */ }
  }
  if (!roomCols.includes('visibility')) {
    try { db.run(`ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unlisted'`); } catch (e) { /* ignore */ }
  }
  if (!roomCols.includes('control_mode')) {
    try { db.run(`ALTER TABLE rooms ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'host'`); } catch (e) { /* ignore */ }
  }

  // 清理过期 session
  try { dbRun('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]); } catch (e) { /* ignore */ }

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
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
    return db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  } finally {
    stmt.free();
  }
}

function roomNextSeq(roomId) {
  if (!roomId) return 1;
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
  if (avatar.length > AVATAR_MAX) return '';
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
    hasPassword: !!(row.password && String(row.password).length > 0),
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

function normalizeVisibility(v) {
  return String(v || '').toLowerCase() === 'public' ? 'public' : 'unlisted';
}

function normalizeControlMode(v) {
  return String(v || '').toLowerCase() === 'anyone' ? 'anyone' : 'host';
}

function roomFromRow(row) {
  if (!row) return null;
  let video = {};
  try { video = JSON.parse(row.video_json || '{}'); } catch (e) { video = {}; }
  const owner = row.owner_user_id || row.host_user_id || '';
  return {
    id: row.id,
    name: row.name,
    ownerUserId: owner,
    hostUserId: row.host_user_id || owner,
    passwordHash: row.password_hash || '',
    visibility: normalizeVisibility(row.visibility || 'unlisted'),
    controlMode: normalizeControlMode(row.control_mode || 'host'),
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
  room.visibility = normalizeVisibility(room.visibility);
  room.controlMode = normalizeControlMode(room.controlMode);
  dbRun(`
    INSERT INTO rooms (id, name, host_user_id, owner_user_id, password_hash, visibility, control_mode, video_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      host_user_id = excluded.host_user_id,
      owner_user_id = excluded.owner_user_id,
      password_hash = excluded.password_hash,
      visibility = excluded.visibility,
      control_mode = excluded.control_mode,
      video_json = excluded.video_json,
      updated_at = excluded.updated_at
  `, [
    room.id,
    cleanText(room.name, '观影房', 40),
    room.hostUserId || '',
    room.ownerUserId || '',
    room.passwordHash || '',
    room.visibility,
    room.controlMode,
    JSON.stringify(defaultRoomVideo(room.video)),
    createdAt,
    now,
  ]);
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
  const isOwner = profile.id === room.ownerUserId;
  let isHost = false;
  if (isOwner) {
    isHost = true;
    room.hostUserId = profile.id;
  } else if (room.users.size === 0) {
    isHost = true;
    room.hostUserId = profile.id;
  } else if (room.hostUserId === profile.id) {
    isHost = true;
  }
  return {
    id: socketId,
    userId: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    avatarColor: profile.avatarColor,
    isHost,
    isOwner,
    audio: false,
    level: 0,
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    ownerUserId: room.ownerUserId || '',
    hostUserId: room.hostUserId || '',
    visibility: room.visibility || 'unlisted',
    controlMode: room.controlMode || 'host',
    hasPassword: !!(room.passwordHash && String(room.passwordHash).length > 0),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function canControlVideo(room, user) {
  if (!room || !user) return false;
  if (room.controlMode === 'anyone') return true;
  return !!(user.isHost || user.isOwner || user.userId === room.ownerUserId || user.userId === room.hostUserId);
}

function isKickBanned(roomId, userId) {
  if (!roomId || !userId || !KICK_BAN_MS) return false;
  const key = `${roomId}:${userId}`;
  const until = kickBans.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    kickBans.delete(key);
    return false;
  }
  return true;
}

// ===================================================================
//  Password (scrypt + legacy sha256)
// ===================================================================
function hashUserPassword(userId, plain) {
  const p = String(plain || '');
  if (!p) return '';
  const saltHex = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(p, `${userId}:${saltHex}`, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:${saltHex}:${hash.toString('hex')}`;
}

function hashRoomPassword(plain) {
  const p = String(plain || '');
  if (!p) return '';
  const saltHex = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(p, `room:${saltHex}`, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:${saltHex}:${hash.toString('hex')}`;
}

function verifyScryptStored(stored, plain, saltPrefix) {
  const parts = String(stored).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  try {
    const hash = crypto.scryptSync(String(plain || ''), `${saltPrefix}${saltHex}`, 32, { N: 16384, r: 8, p: 1 });
    const a = Buffer.from(hashHex, 'hex');
    if (a.length !== hash.length) return false;
    return crypto.timingSafeEqual(a, hash);
  } catch (e) {
    return false;
  }
}

function verifyUserPassword(row, plain) {
  const stored = String((row && row.password) || '');
  if (!stored) return true;
  if (stored.startsWith('scrypt:')) {
    return verifyScryptStored(stored, plain, `${row.id}:`);
  }
  // legacy: SHA-256(salt :: userId :: plain)
  const salt = String((row && row.password_salt) || '');
  const hash = crypto.createHash('sha256').update(`${salt}::${row.id}::${String(plain || '')}`).digest('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(stored, 'hex');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

function maybeUpgradeUserPassword(row, plain) {
  if (!row || !row.password || String(row.password).startsWith('scrypt:')) return;
  if (!verifyUserPassword(row, plain)) return;
  const next = hashUserPassword(row.id, plain);
  dbRun('UPDATE users SET password = ?, password_salt = ?, updated_at = ? WHERE id = ?', [next, '', Date.now(), row.id]);
  schedulePersist();
}

function verifyRoomPassword(room, plain) {
  const stored = room && room.passwordHash ? String(room.passwordHash) : '';
  if (!stored) return true;
  return verifyScryptStored(stored, plain, 'room:');
}

// ===================================================================
//  Sessions
// ===================================================================
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  dbRun(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)',
    [token, userId, now, now + SESSION_TTL_MS, now]
  );
  schedulePersist(400);
  return token;
}

function revokeUserSessions(userId, { keepToken } = {}) {
  if (!userId) return;
  if (keepToken) {
    dbRun('DELETE FROM sessions WHERE user_id = ? AND token != ?', [userId, keepToken]);
  } else {
    dbRun('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
  schedulePersist(400);
}

function getSessionRow(token) {
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const row = dbGet('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    try { dbRun('DELETE FROM sessions WHERE token = ?', [token]); schedulePersist(800); } catch (e) { /* ignore */ }
    return null;
  }
  // 节流刷新 last_seen
  if (Date.now() - (row.last_seen_at || 0) > 60_000) {
    try {
      dbRun('UPDATE sessions SET last_seen_at = ? WHERE token = ?', [Date.now(), token]);
      schedulePersist(2000);
    } catch (e) { /* ignore */ }
  }
  return row;
}

function extractTokenFromReq(req) {
  const h = String(req.headers.authorization || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const x = req.headers['x-session-token'];
  if (x) return String(x).trim();
  return '';
}

function getSessionUser(req) {
  const token = extractTokenFromReq(req);
  const sess = getSessionRow(token);
  if (!sess) return null;
  const user = dbGet('SELECT * FROM users WHERE id = ?', [sess.user_id]);
  if (!user) return null;
  return { token, session: sess, user, userId: user.id };
}

function requireUser(req, res) {
  const ctx = getSessionUser(req);
  if (!ctx) {
    res.status(401).json({ error: '未登录或会话已过期', code: 'AUTH_REQUIRED' });
    return null;
  }
  return ctx;
}

function issueSessionResponse(userRow, { rotate = false, oldToken } = {}) {
  const pub = publicUser(userRow);
  if (rotate && userRow.id) {
    revokeUserSessions(userRow.id, { keepToken: oldToken || '' });
  }
  const sessionToken = createSession(userRow.id);
  return { ...pub, sessionToken };
}

function mintReclaimToken(userId) {
  const token = crypto.randomBytes(18).toString('hex');
  reclaimTokens.set(token, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
  if (reclaimTokens.size > 5000) {
    const now = Date.now();
    for (const [k, v] of reclaimTokens) {
      if (v.expiresAt < now) reclaimTokens.delete(k);
    }
  }
  return token;
}

function consumeReclaimToken(token) {
  const t = String(token || '');
  const entry = reclaimTokens.get(t);
  if (!entry) return null;
  reclaimTokens.delete(t);
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

// ===================================================================
//  HTTP APIs
// ===================================================================
app.get('/api/runtime-config', async (req, res) => {
  try {
    await dbReady;
    res.json({
      iceServers: ICE_SERVERS,
      biliProxyEnabled: BILI_PROXY_ENABLED,
      version: PKG_VERSION,
    });
  } catch (e) {
    res.status(500).json({ error: 'config failed' });
  }
});

app.post('/api/users/bootstrap', async (req, res) => {
  try {
    await dbReady;
    const body = req.body || {};
    const requestedId = normalizeId(body.userId || body.id);
    const existingSession = getSessionUser(req);

    // 有 session：只能改自己的资料
    if (existingSession) {
      if (requestedId && requestedId !== existingSession.userId) {
        return res.status(403).json({ error: '会话与用户不匹配，请先召回账号', code: 'SESSION_MISMATCH' });
      }
      const profile = upsertUser({
        id: existingSession.userId,
        name: body.name,
        avatar: body.avatar,
      });
      // 续期：不强制轮换 token
      return res.json({ ...profile, sessionToken: existingSession.token });
    }

    // 无 session：若客户端带了已有 userId，仅当该用户不存在时创建；存在则要求 reclaim
    if (requestedId) {
      const row = dbGet('SELECT * FROM users WHERE id = ?', [requestedId]);
      if (row) {
        // 信任本机持有的 id：签发 session（弱绑定；密码用户建议走 reclaim）
        // 为降低冒充：若账号已设密码，必须先 reclaim
        if (row.password && String(row.password).length > 0) {
          return res.status(403).json({
            error: '该账号已设密码，请先通过昵称召回',
            code: 'PASSWORD_REQUIRED',
            hasPassword: true,
          });
        }
        const profile = upsertUser({ id: requestedId, name: body.name || row.name, avatar: body.avatar });
        const full = dbGet('SELECT * FROM users WHERE id = ?', [profile.id]);
        return res.json(issueSessionResponse(full));
      }
    }

    const profile = upsertUser({ id: requestedId, name: body.name, avatar: body.avatar });
    const full = dbGet('SELECT * FROM users WHERE id = ?', [profile.id]);
    res.json(issueSessionResponse(full));
  } catch (e) {
    console.error('[api] user bootstrap failed:', e);
    res.status(500).json({ error: '用户初始化失败' });
  }
});

app.get('/api/users/lookup', async (req, res) => {
  try {
    await dbReady;
    const ip = clientIp(req);
    if (!rateLookup(ip)) return res.status(429).json({ error: '查询过快' });
    const name = cleanText(req.query.name, '', 40);
    if (!name) return res.json({ candidates: [] });
    const rows = dbAll(
      `SELECT id, name, avatar_color, password, updated_at FROM users WHERE name = ? ORDER BY updated_at DESC LIMIT 12`,
      [name]
    );
    const candidates = rows.map((r) => ({
      reclaimToken: mintReclaimToken(r.id),
      name: r.name,
      avatarColor: r.avatar_color || avatarColor(r.id || r.name),
      hasAvatar: false,
      hasPassword: !!(r.password && String(r.password).length > 0),
      updatedAt: r.updated_at,
    }));
    res.json({ candidates });
  } catch (e) {
    console.error('[api] user lookup failed:', e);
    res.status(500).json({ error: '查询失败' });
  }
});

app.post('/api/users/reclaim', async (req, res) => {
  try {
    await dbReady;
    const ip = clientIp(req);
    if (!rateReclaim(ip)) return res.status(429).json({ error: '请求过快' });
    const body = req.body || {};
    let userId = consumeReclaimToken(body.reclaimToken);
    // 兼容过渡：仍接受 userId，但不推荐
    if (!userId && body.userId) userId = normalizeId(body.userId);
    if (!userId) return res.status(400).json({ error: '无效或过期的召回凭证' });
    const row = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return res.status(404).json({ error: '账号不存在' });
    if (!verifyUserPassword(row, String(body.password || ''))) {
      return res.status(403).json({ error: '密码不正确', passwordRequired: true });
    }
    maybeUpgradeUserPassword(row, String(body.password || ''));
    dbRun('UPDATE users SET updated_at = ? WHERE id = ?', [Date.now(), userId]);
    schedulePersist();
    // 轮换：作废该用户旧 session
    revokeUserSessions(userId);
    const full = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    res.json(issueSessionResponse(full));
  } catch (e) {
    console.error('[api] user reclaim failed:', e);
    res.status(500).json({ error: '召回失败' });
  }
});

app.post('/api/users/:id/password', async (req, res) => {
  try {
    await dbReady;
    const ip = clientIp(req);
    if (!ratePassword(ip)) return res.status(429).json({ error: '请求过快' });
    const ctx = requireUser(req, res);
    if (!ctx) return;
    const id = normalizeId(req.params.id);
    if (!id || id !== ctx.userId) return res.status(403).json({ error: '只能为自己的账号设置密码' });
    const row = dbGet('SELECT id, password, password_salt FROM users WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: '账号不存在' });
    const body = req.body || {};
    const plain = String(body.password || '').slice(0, 128);
    if (row.password && !verifyUserPassword(row, String(body.oldPassword || ''))) {
      return res.status(403).json({ error: '原密码不正确' });
    }
    if (plain && plain.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (!plain) {
      dbRun('UPDATE users SET password = ?, password_salt = ?, updated_at = ? WHERE id = ?', ['', '', Date.now(), id]);
      schedulePersist();
      return res.json({ ok: true, hasPassword: false });
    }
    const hash = hashUserPassword(id, plain);
    dbRun('UPDATE users SET password = ?, password_salt = ?, updated_at = ? WHERE id = ?', [hash, '', Date.now(), id]);
    schedulePersist();
    res.json({ ok: true, hasPassword: true });
  } catch (e) {
    console.error('[api] password set failed:', e);
    res.status(500).json({ error: '设置密码失败' });
  }
});

app.get('/r/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get(['/home', '/login'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', async (req, res) => {
  try {
    await dbReady;
    res.json({ ok: true, rooms: rooms.size, db: 'ok', version: PKG_VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    await dbReady;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    // 仅 public 房间出现在大厅；登录用户还可看自己拥有的房间（含 unlisted）
    const ctx = getSessionUser(req);
    let rows;
    if (ctx) {
      rows = dbAll(
        `SELECT id, name, host_user_id, owner_user_id, video_json, created_at, updated_at, visibility, control_mode, password_hash
         FROM rooms
         WHERE visibility = 'public' OR owner_user_id = ?
         ORDER BY updated_at DESC LIMIT ?`,
        [ctx.userId, limit]
      );
    } else {
      rows = dbAll(
        `SELECT id, name, host_user_id, owner_user_id, video_json, created_at, updated_at, visibility, control_mode, password_hash
         FROM rooms WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT ?`,
        [limit]
      );
    }
    const out = rows.map((r) => {
      let vj = {};
      try { vj = JSON.parse(r.video_json || '{}'); } catch (e) {}
      const online = (() => {
        const room = rooms.get(r.id);
        if (!room) return 0;
        return room.users.size;
      })();
      const label = vj.label || vj.fileName || vj.bili || vj.url || (vj.kind === 'iframe' && vj.iframeUrl) || '';
      return {
        id: r.id,
        name: r.name,
        hostUserId: r.host_user_id,
        ownerUserId: r.owner_user_id || r.host_user_id || '',
        visibility: normalizeVisibility(r.visibility),
        controlMode: normalizeControlMode(r.control_mode),
        hasPassword: !!(r.password_hash && String(r.password_hash).length > 0),
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

function destroyRoomById(rid, { by = 'http' } = {}) {
  const liveRoom = rooms.get(rid);
  if (liveRoom) {
    if (liveRoom.emptyTimer) { clearTimeout(liveRoom.emptyTimer); liveRoom.emptyTimer = null; }
    io.to(rid).emit('room:destroyed', { roomId: rid, by });
    for (const sid of [...liveRoom.users.keys()]) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(rid);
    }
    liveRoom.users.clear();
    rooms.delete(rid);
  }
  try {
    dbRun('DELETE FROM rooms WHERE id = ?', [rid]);
    dbRun('DELETE FROM messages WHERE room_id = ?', [rid]);
    dbRun('DELETE FROM room_members WHERE room_id = ?', [rid]);
    schedulePersist();
  } catch (e) {
    console.error('[api] room delete db cleanup failed:', e);
  }
}

app.delete('/api/rooms/:id', async (req, res) => {
  try {
    await dbReady;
    const ctx = requireUser(req, res);
    if (!ctx) return;
    const rid = normalizeRoomId(req.params.id);
    if (!rid) return res.status(400).json({ error: '无效房间号' });
    const row = dbGet('SELECT id, name, host_user_id, owner_user_id FROM rooms WHERE id = ?', [rid]);
    if (!row) return res.status(404).json({ error: '房间不存在' });
    const ownerId = row.owner_user_id || row.host_user_id;
    if (ctx.userId !== ownerId) {
      console.warn('[auth] room delete denied', ctx.userId, rid);
      return res.status(403).json({ error: '只有房间所有者才能删除房间' });
    }
    destroyRoomById(rid, { by: 'http' });
    console.log('[room] deleted', rid, 'by', ctx.userId);
    res.json({ ok: true, name: row.name });
  } catch (e) {
    console.error('[api] room delete failed:', e);
    res.status(500).json({ error: '删除房间失败' });
  }
});

app.patch('/api/rooms/:id/name', async (req, res) => {
  try {
    await dbReady;
    const ctx = requireUser(req, res);
    if (!ctx) return;
    const rid = normalizeRoomId(req.params.id);
    if (!rid) return res.status(400).json({ error: '无效房间号' });
    const row = dbGet('SELECT id, host_user_id, owner_user_id FROM rooms WHERE id = ?', [rid]);
    if (!row) return res.status(404).json({ error: '房间不存在' });
    const ownerId = row.owner_user_id || row.host_user_id;
    if (ctx.userId !== ownerId && ctx.userId !== row.host_user_id) {
      return res.status(403).json({ error: '只有所有者或主持人才能改名' });
    }
    const name = cleanText((req.body && req.body.name) || '', '观影房', 40);
    dbRun('UPDATE rooms SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), rid]);
    schedulePersist();
    const liveRoom = rooms.get(rid);
    if (liveRoom) {
      liveRoom.name = name;
      liveRoom.updatedAt = Date.now();
      io.to(rid).emit('room:renamed', { name });
    }
    res.json({ ok: true, name });
  } catch (e) {
    console.error('[api] room rename failed:', e);
    res.status(500).json({ error: '改名失败' });
  }
});

app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    await dbReady;
    const ctx = requireUser(req, res);
    if (!ctx) return;
    const rid = normalizeRoomId(req.params.id);
    if (!rid) return res.status(400).json({ error: '无效房间号' });
    if (!roomExists(rid)) return res.status(404).json({ error: '房间不存在' });
    const member = dbGet('SELECT user_id FROM room_members WHERE room_id = ? AND user_id = ?', [rid, ctx.userId]);
    const live = rooms.get(rid);
    const inLive = live && [...live.users.values()].some((u) => u.userId === ctx.userId);
    if (!member && !inLive) return res.status(403).json({ error: '无权查看该房间消息' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const fromSeq = parseInt(req.query.fromSeq, 10);
    let rows;
    if (Number.isFinite(fromSeq) && fromSeq > 0) {
      rows = dbAll(
        'SELECT seq, user_id, user_name, cipher, created_at FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
        [rid, fromSeq, limit]
      );
    } else {
      rows = dbAll(
        'SELECT seq, user_id, user_name, cipher, created_at FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?',
        [rid, limit]
      );
    }
    rows.reverse();
    const out = rows.map((r) => ({
      seq: r.seq,
      userId: r.user_id || '',
      user: r.user_name || '匿名',
      ts: r.created_at,
      cipher: r.cipher,
    }));
    res.json({ messages: out });
  } catch (e) {
    res.status(500).json({ error: 'history fetch failed' });
  }
});

app.get('/api/users/:id/rooms', async (req, res) => {
  try {
    await dbReady;
    const ctx = requireUser(req, res);
    if (!ctx) return;
    const userId = normalizeId(req.params.id);
    if (!userId || userId !== ctx.userId) return res.status(403).json({ error: '只能查看自己的房间' });
    const rows = dbAll(
      `SELECT rm.room_id AS id, rm.display_name, rm.is_host, rm.last_seen_at, r.name, r.updated_at, r.owner_user_id, r.visibility
       FROM room_members rm LEFT JOIN rooms r ON r.id = rm.room_id
       WHERE rm.user_id = ? ORDER BY rm.last_seen_at DESC LIMIT 50`,
      [userId]
    );
    res.json({
      rooms: rows.map((r) => ({
        id: r.id,
        name: r.name || '',
        displayName: r.display_name || '',
        isHost: !!r.is_host,
        isOwner: r.owner_user_id === userId,
        visibility: normalizeVisibility(r.visibility),
        lastSeenAt: r.last_seen_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'user rooms failed' });
  }
});

// ===================================================================
//  Bilibili resolve + media proxy
// ===================================================================
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const BILI_QN = {
  '360P': 16, '480P': 32, '720P': 64, '1080P': 80, '1080P+': 112, '4K': 120,
};
const biliCache = new Map();

async function fetchWithTimeout(url, opts = {}, timeout = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function biliGet(url) {
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com' } });
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

function biliPickByQn(list, qnLabel) {
  const qn = BILI_QN[qnLabel] || BILI_QN['720P'];
  const exact = list.find((t) => t.id === qn);
  if (exact) return exact;
  const lower = list.filter((t) => (t.id || 0) <= qn).sort((a, b) => (b.id || 0) - (a.id || 0));
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
  try {
    const keys = await biliGet('https://api.bilibili.com/x/client/wbi/keys');
    const kd = keys.data || {};
    const img = kd.img_key || (kd.wbi_img ? kd.wbi_img.img_url.split('/').pop().replace('.png', '') : '');
    const sub = kd.sub_key || (kd.wbi_img ? kd.wbi_img.sub_url.split('/').pop().replace('.png', '') : '');
    const mixin = biliMixinKey(img, sub);
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
  const acceptQ = play.data.accept_quality || [];
  const acceptD = play.data.accept_description || [];
  const qualities = acceptQ.map((q, i) => ({
    label: (acceptD[i] || `${q}P`).replace('高清 ', '').replace('清晰 ', '').replace('流畅 ', '') || `${q}P`,
    qn: q,
    bandwidth: 0,
  })).sort((a, b) => b.qn - a.qn);
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
  const ip = clientIp(req);
  if (!rateResolveBili(ip)) return res.status(429).json({ error: '解析请求过快' });
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

function isBiliMediaHost(host) {
  const h = String(host || '').toLowerCase();
  const trusted = ['bilivideo.com', 'bilivideo.cn', 'bilibili.com', 'hdslb.com', 'hdslb.net', 'akamaized.net', 'mcdn.bilivideo.cn'];
  return trusted.some((t) => h === t || h.endsWith('.' + t));
}

function trackBiliBytes(ip, n) {
  const now = Date.now();
  let e = biliMediaBytes.get(ip);
  if (!e || now >= e.reset) {
    e = { bytes: 0, reset: now + 3600_000 };
    biliMediaBytes.set(ip, e);
  }
  e.bytes += n;
  const maxBytes = BILI_PROXY_MAX_MB_PER_IP_HOUR * 1024 * 1024;
  return e.bytes <= maxBytes;
}

app.get('/api/bili-media', async (req, res) => {
  if (!BILI_PROXY_ENABLED) return res.status(503).json({ error: 'B 站媒体代理已关闭' });
  const ip = clientIp(req);
  if (!rateBiliMedia(ip)) return res.status(429).json({ error: '媒体请求过快' });
  const conc = biliMediaConcurrent.get(ip) || 0;
  if (conc >= 2) return res.status(429).json({ error: '并发连接过多' });
  if (!trackBiliBytes(ip, 0)) return res.status(429).json({ error: '本小时代理流量已达上限' });

  const url = (req.query.url || '').toString();
  const kind = (req.query.kind || 'video').toString();
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: '无效的媒体地址' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).json({ error: '协议不支持' });
  if (!isBiliMediaHost(parsed.hostname)) return res.status(403).json({ error: '仅允许 B 站媒体地址' });

  const fwd = {
    'User-Agent': BILI_UA,
    Referer: 'https://www.bilibili.com',
    Origin: 'https://www.bilibili.com',
  };
  if (req.headers.range) fwd.Range = req.headers.range;
  biliMediaConcurrent.set(ip, conc + 1);
  try {
    const r = await fetchWithTimeout(url, { headers: fwd, redirect: 'follow' });
    res.status(r.status);
    const pass = ['content-range', 'content-length', 'accept-ranges'];
    pass.forEach((h) => { const v = r.headers.get(h); if (v) res.setHeader(h, v); });
    if (kind === 'audio') res.setHeader('content-type', 'audio/mp4');
    else res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'public, max-age=300');
    const cl = parseInt(r.headers.get('content-length') || '0', 10);
    if (cl > 0 && !trackBiliBytes(ip, cl)) {
      return res.status(429).json({ error: '本小时代理流量已达上限' });
    }
    if (!r.body) return res.end();
    const nodeStream = Readable.fromWeb(r.body);
    nodeStream.on('error', () => { try { res.destroy(); } catch (e) {} });
    nodeStream.on('end', () => {});
    nodeStream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: '媒体代理失败：' + e.message });
    else try { res.destroy(); } catch (e2) {}
  } finally {
    const c = biliMediaConcurrent.get(ip) || 1;
    if (c <= 1) biliMediaConcurrent.delete(ip);
    else biliMediaConcurrent.set(ip, c - 1);
  }
});

// ===================================================================
//  Socket.IO
// ===================================================================
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

function socketAuthUser(socket) {
  return socket.data && socket.data.userId
    ? { userId: socket.data.userId, token: socket.data.token }
    : null;
}

function requireSocketUser(socket, cb) {
  const auth = socketAuthUser(socket);
  if (!auth) {
    if (typeof cb === 'function') cb({ error: '未登录或会话已过期', code: 'AUTH_REQUIRED' });
    return null;
  }
  return auth;
}

io.use(async (socket, next) => {
  try {
    await dbReady;
    const token = (socket.handshake.auth && socket.handshake.auth.token)
      || socket.handshake.headers['x-session-token']
      || '';
    const sess = getSessionRow(String(token || '').trim());
    if (sess) {
      socket.data.userId = sess.user_id;
      socket.data.token = sess.token;
    } else {
      socket.data.userId = null;
      socket.data.token = null;
    }
    next();
  } catch (e) {
    next(e);
  }
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('session:bind', async ({ token }, cb) => {
    try {
      await dbReady;
      const sess = getSessionRow(String(token || '').trim());
      if (!sess) {
        socket.data.userId = null;
        socket.data.token = null;
        if (typeof cb === 'function') cb({ error: '无效会话' });
        return;
      }
      socket.data.userId = sess.user_id;
      socket.data.token = sess.token;
      if (typeof cb === 'function') cb({ ok: true, userId: sess.user_id });
    } catch (e) {
      if (typeof cb === 'function') cb({ error: '绑定失败' });
    }
  });

  socket.on('room:create', async ({ roomName, userName, avatar, password, visibility, controlMode }, cb) => {
    try {
      await dbReady;
      const auth = requireSocketUser(socket, cb);
      if (!auth) return;
      if (!rateCreateRoom(auth.userId)) {
        if (typeof cb === 'function') cb({ error: '创建过快，请稍后再试' });
        return;
      }
      const profile = upsertUser({ id: auth.userId, name: userName, avatar });
      const id = genRoomId();
      const now = Date.now();
      const pwd = String(password || '').slice(0, 32);
      if (pwd && pwd.length < 4) {
        if (typeof cb === 'function') cb({ error: '房间密码至少 4 位' });
        return;
      }
      const room = {
        id,
        name: cleanText(roomName, '观影房', 40),
        ownerUserId: profile.id,
        hostUserId: profile.id,
        passwordHash: pwd ? hashRoomPassword(pwd) : '',
        visibility: normalizeVisibility(visibility),
        controlMode: normalizeControlMode(controlMode),
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
      user.isOwner = true;
      room.users.set(socket.id, user);
      saveRoom(room, { flushDelay: 0 });
      upsertRoomMember({ roomId: id, userId: profile.id, displayName: profile.name || '', isHost: true });
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

  socket.on('room:join', async ({ roomId, userName, avatar, password }, cb) => {
    try {
      await dbReady;
      const auth = requireSocketUser(socket, cb);
      if (!auth) return;
      const rid = normalizeRoomId(roomId);
      const room = loadRoom(rid);
      if (!room) return cb && cb({ error: '房间不存在' });
      if (isKickBanned(rid, auth.userId)) {
        return cb && cb({ error: '你已被移出该房间，请稍后再试' });
      }
      if (!verifyRoomPassword(room, password)) {
        return cb && cb({ error: '房间密码不正确', passwordRequired: true });
      }
      keepRoom(room);
      const profile = upsertUser({ id: auth.userId, name: userName, avatar });
      socket.join(rid);
      currentRoom = rid;
      const user = makeRoomUser(socket.id, profile, room);
      if (user.isHost) saveRoom(room);
      room.users.set(socket.id, user);
      upsertRoomMember({ roomId: rid, userId: profile.id, displayName: profile.name || '', isHost: user.isHost || user.isOwner });
      socket.to(rid).emit('user:join', { user });
      const recent = dbAll(
        'SELECT seq, user_id, user_name, cipher, created_at FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 50',
        [rid]
      ).reverse().map((r) => ({
        seq: r.seq,
        userId: r.user_id || '',
        user: r.user_name || '匿名',
        ts: r.created_at,
        cipher: r.cipher,
      }));
      socket.emit('room:state', {
        room: publicRoom(room),
        users: [...room.users.values()],
        video: room.video,
        recentMessages: recent,
        maxSeq: recent.length ? recent[recent.length - 1].seq : 0,
      });
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
      cb && cb({ ok: true, user: profile, room: publicRoom(room) });
    } catch (e) {
      console.error('[room:join] failed:', e);
      cb && cb({ error: '加入房间失败' });
    }
  });

  socket.on('user:rename', ({ name }) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (u && name) {
      u.name = cleanText(name, u.name || '匿名', 20);
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    }
  });

  socket.on('user:profile', async ({ name, avatar }) => {
    try {
      await dbReady;
      const auth = socketAuthUser(socket);
      if (!auth) return;
      const room = rooms.get(currentRoom);
      if (!room) return;
      const u = room.users.get(socket.id);
      if (!u || u.userId !== auth.userId) return;
      const profile = upsertUser({ id: auth.userId, name, avatar });
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
    const leaving = room.users.get(socket.id);
    room.users.delete(socket.id);
    socket.to(currentRoom).emit('user:leave', { id: socket.id });
    closePeerAll();
    if (room.users.size === 0) {
      const roomId = currentRoom;
      // 空房：active host 回到 owner，不改 owner
      room.hostUserId = room.ownerUserId || room.hostUserId;
      saveRoom(room, { flushDelay: 800 });
      room.emptyTimer = setTimeout(() => {
        const latest = rooms.get(roomId);
        if (latest && latest.users.size === 0) rooms.delete(roomId);
      }, ROOM_EMPTY_TTL_MS);
    } else if (leaving && leaving.isHost) {
      // 优先推选 owner 在线者，否则第一个人；永不改写 ownerUserId
      const ownerOnline = [...room.users.values()].find((u) => u.userId === room.ownerUserId);
      const first = ownerOnline || [...room.users.values()][0];
      for (const u of room.users.values()) u.isHost = false;
      if (first) {
        first.isHost = true;
        room.hostUserId = first.userId || room.hostUserId;
        saveRoom(room);
      }
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    } else {
      io.to(currentRoom).emit('room:users', [...room.users.values()]);
    }
    socket.leave(currentRoom);
    currentRoom = null;
  }
  socket.on('disconnect', leaveRoom);
  socket.on('room:leave', leaveRoom);

  socket.on('room:destroy', (cb) => {
    const auth = requireSocketUser(socket, cb);
    if (!auth) return;
    const room = rooms.get(currentRoom);
    if (!room) { if (typeof cb === 'function') cb({ error: '不在房间内' }); return; }
    const u = room.users.get(socket.id);
    if (!u || u.userId !== room.ownerUserId) {
      if (typeof cb === 'function') cb({ error: '只有房间所有者才能删除房间' });
      return;
    }
    const rid = currentRoom;
    destroyRoomById(rid, { by: socket.id });
    currentRoom = null;
    console.log('[room] destroyed', rid, 'by', auth.userId);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('room:rename', ({ name }, cb) => {
    const auth = requireSocketUser(socket, cb);
    if (!auth) return;
    const room = rooms.get(currentRoom);
    if (!room) { if (typeof cb === 'function') cb({ error: '不在房间内' }); return; }
    const u = room.users.get(socket.id);
    if (!u || (!u.isOwner && !u.isHost && u.userId !== room.ownerUserId)) {
      if (typeof cb === 'function') cb({ error: '只有所有者或主持人才能改名' });
      return;
    }
    room.name = cleanText(name, room.name, 40);
    room.updatedAt = Date.now();
    saveRoom(room);
    io.to(currentRoom).emit('room:renamed', { name: room.name });
    if (typeof cb === 'function') cb({ ok: true, name: room.name });
  });

  socket.on('room:set-options', ({ visibility, controlMode, password, clearPassword }, cb) => {
    const auth = requireSocketUser(socket, cb);
    if (!auth) return;
    const room = rooms.get(currentRoom);
    if (!room) { if (typeof cb === 'function') cb({ error: '不在房间内' }); return; }
    if (auth.userId !== room.ownerUserId) {
      if (typeof cb === 'function') cb({ error: '只有所有者能改房间设置' });
      return;
    }
    if (visibility != null) room.visibility = normalizeVisibility(visibility);
    if (controlMode != null) room.controlMode = normalizeControlMode(controlMode);
    if (clearPassword) room.passwordHash = '';
    else if (password != null && String(password).length) {
      const pwd = String(password).slice(0, 32);
      if (pwd.length < 4) {
        if (typeof cb === 'function') cb({ error: '房间密码至少 4 位' });
        return;
      }
      room.passwordHash = hashRoomPassword(pwd);
    }
    saveRoom(room);
    io.to(currentRoom).emit('room:options', {
      visibility: room.visibility,
      controlMode: room.controlMode,
      hasPassword: !!room.passwordHash,
    });
    if (typeof cb === 'function') cb({ ok: true, room: publicRoom(room) });
  });

  socket.on('room:kick', ({ targetSocketId, targetUserId }, cb) => {
    const auth = requireSocketUser(socket, cb);
    if (!auth) return;
    const room = rooms.get(currentRoom);
    if (!room) { if (typeof cb === 'function') cb({ error: '不在房间内' }); return; }
    const me = room.users.get(socket.id);
    if (!me || (!me.isHost && !me.isOwner && me.userId !== room.ownerUserId)) {
      if (typeof cb === 'function') cb({ error: '没有踢人权限' });
      return;
    }
    let target = null;
    if (targetSocketId) target = room.users.get(targetSocketId);
    else if (targetUserId) target = [...room.users.values()].find((u) => u.userId === targetUserId);
    if (!target) { if (typeof cb === 'function') cb({ error: '目标不在房间' }); return; }
    if (target.userId === room.ownerUserId) {
      if (typeof cb === 'function') cb({ error: '不能踢出房间所有者' });
      return;
    }
    if (target.id === socket.id) {
      if (typeof cb === 'function') cb({ error: '不能踢自己' });
      return;
    }
    if (KICK_BAN_MS > 0) {
      kickBans.set(`${currentRoom}:${target.userId}`, Date.now() + KICK_BAN_MS);
    }
    const targetSocket = io.sockets.sockets.get(target.id);
    room.users.delete(target.id);
    if (targetSocket) {
      targetSocket.emit('user:kicked', { roomId: currentRoom, by: me.name });
      targetSocket.leave(currentRoom);
    }
    io.to(currentRoom).emit('user:leave', { id: target.id });
    io.to(currentRoom).emit('room:users', [...room.users.values()]);
    console.log('[room] kick', target.userId, 'from', currentRoom, 'by', auth.userId);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('room:transfer-host', ({ targetSocketId }, cb) => {
    const auth = requireSocketUser(socket, cb);
    if (!auth) return;
    const room = rooms.get(currentRoom);
    if (!room) { if (typeof cb === 'function') cb({ error: '不在房间内' }); return; }
    const me = room.users.get(socket.id);
    if (!me || (!me.isHost && me.userId !== room.ownerUserId)) {
      if (typeof cb === 'function') cb({ error: '没有转让权限' });
      return;
    }
    const target = room.users.get(targetSocketId);
    if (!target) { if (typeof cb === 'function') cb({ error: '目标不在房间' }); return; }
    for (const u of room.users.values()) u.isHost = false;
    target.isHost = true;
    room.hostUserId = target.userId;
    saveRoom(room);
    io.to(currentRoom).emit('room:users', [...room.users.values()]);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('crypto:pubkey', ({ pubKey }) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room || typeof pubKey !== 'string' || pubKey.length > 2048) return;
    socket.to(currentRoom).emit('crypto:pubkey', { fromId: socket.id, pubKey });
  });
  socket.on('crypto:groupkey', ({ toId, pubKey, env }) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room || !toId || !env || typeof env !== 'object') return;
    if (typeof env.iv !== 'string' || env.iv.length > 256 || typeof env.ct !== 'string' || env.ct.length > 8192) return;
    io.to(toId).emit('crypto:groupkey', { fromId: socket.id, pubKey, env });
  });
  socket.on('crypto:rekey', () => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    socket.to(currentRoom).emit('crypto:rekey', { fromId: socket.id });
  });

  socket.on('chat:send', (payload, cb) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (!rateChat(socket.id)) {
      if (typeof cb === 'function') cb({ error: '发送过快' });
      return;
    }
    const u = room.users.get(socket.id);
    if (!payload || typeof payload.cipher !== 'string') return;
    const cipher = payload.cipher.slice(0, CHAT_CIPHER_MAX);
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
      userId: u ? u.userId : '',
      ts,
      cipher,
      seq,
    };
    socket.to(currentRoom).emit('chat:message', { ...message, self: false });
    socket.emit('chat:message', { ...message, self: true });
    if (typeof cb === 'function') cb({ ok: true, seq });
  });

  socket.on('video:set', (payload) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (!canControlVideo(room, u)) return;
    const str = (v) => (v == null ? '' : String(v));
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

  socket.on('video:action', ({ action, time }) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (!canControlVideo(room, u)) return;
    room.video.playing = action === 'play';
    if (typeof time === 'number' && isFinite(time)) room.video.currentTime = time;
    room.video.updatedAt = Date.now();
    room.video.lastControllerId = socket.id;
    room.video.lastController = u ? u.name : '';
    saveRoom(room, { flushDelay: 1200 });
    socket.to(currentRoom).emit('video:action', { action, time, by: u ? u.name : '', byId: socket.id, serverTime: Date.now() });
  });

  socket.on('video:sync', ({ time }) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    // 仅主持人周期纠偏，避免全员互抢
    if (room.controlMode === 'host' && u && !u.isHost && u.userId !== room.ownerUserId) return;
    socket.to(currentRoom).emit('video:sync', { time, byId: socket.id });
  });

  socket.on('user:audio', ({ enabled }) => {
    if (!socketAuthUser(socket)) return;
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
    if (!socketAuthUser(socket)) return;
    if (!rateSpeaking(socket.id)) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const u = room.users.get(socket.id);
    if (!u || !u.audio) return;
    const nextLevel = Math.max(0, Math.min(1, Number(level) || 0));
    u.level = nextLevel;
    socket.to(currentRoom).emit('user:speaking', { id: socket.id, level: nextLevel });
  });

  socket.on('rtc:signal', ({ to, data }) => {
    if (!socketAuthUser(socket)) return;
    const room = rooms.get(currentRoom);
    if (!room || !to) return;
    const target = io.sockets.sockets.get(to);
    if (!target || !target.rooms.has(currentRoom)) return;
    io.to(to).emit('rtc:signal', { from: socket.id, data });
  });

  function closePeerAll() {
    socket.to(currentRoom).emit('user:audio', { id: socket.id, enabled: false });
    socket.to(currentRoom).emit('rtc:close', { id: socket.id });
  }
});

// ===================================================================
//  HTTPS 自签名证书
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
  if (CORS_ORIGIN !== '*') {
    console.log('CORS origin:', Array.isArray(CORS_ORIGIN) ? CORS_ORIGIN.join(', ') : CORS_ORIGIN);
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

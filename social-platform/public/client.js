/* global io */
/**
 * 一起看 · 前端逻辑
 *  - 房间：创建 / 加入 / 离开
 *  - 双界面：聊天主页（气泡） + 观影模式（弹幕）
 *  - 聊天：主功能，支持文字 + 图片（图片以 base64 经服务端转发，端到端加密）
 *  - 共享视频：独立观影界面，本地播放，服务端仅同步 播放/暂停/跳转/进度
 *  - 连麦：WebRTC P2P 语音（完美协商 mesh）
 */

const socket = io();
let myPubKey = null; // 自己的 ECDH 公钥（base64），进入房间后广播

// ---------- 全局状态 ----------
let myId = null;
let myName = '';
let currentRoomId = null;
let roomUsers = [];
let isHost = false;
let currentBiliQn = '720P'; // 当前选中的 B 站清晰度

let videoState = { url: '', fileName: '', bili: '', playing: false, currentTime: 0, lastControllerId: '', lastController: '' };
let controllerId = '';
let lastVideoTitle = ''; // 观影模式标题

let watchModeOn = false; // 是否处于观影模式（弹幕）
let danmakuOn = true;    // 弹幕开关

let applyingRemote = false; // 正在应用远端指令，避免事件回环
let dashPlayer = null;      // dash.js 播放器实例（仅 B 站等 DASH 流使用，已弃用，保留占位）

// ---------- WebRTC ----------
let localStream = null;
let micOn = false;
const peers = new Map();
const remoteAudios = new Map();
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---------- DOM 助手 ----------
const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const room = $('room');

// ---------- 安全上下文检查（端到端加密依赖 crypto.subtle，仅 HTTPS/localhost 可用） ----------
if (!window.crypto || !crypto.subtle) {
  window.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#b91c1c;color:#fff;padding:10px 16px;font-size:14px;text-align:center;line-height:1.5';
    b.textContent = '端到端加密需要安全上下文：请通过 https:// 或 http://localhost 访问（当前 crypto.subtle 不可用，加密与连麦将无法使用）。服务端加 --https 可启用自签名 HTTPS。';
    document.body.appendChild(b);
  });
}

// ===================================================================
//  端到端加密（ECDH P-256 + AES-GCM 群密钥）
// ===================================================================
const cqCrypto = (() => {
  let ecdhPriv = null;
  let groupKey = null;
  const privCache = new Map();

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64d(s) {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function initLocal() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    ecdhPriv = pair.privateKey;
    const pubRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
    return b64(pubRaw);
  }
  async function createGroupKey() {
    groupKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function deriveShared(pubB64) {
    const pubKey = await crypto.subtle.importKey('raw', b64d(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: pubKey },
      ecdhPriv,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function wrapGroupKey(peerPubB64) {
    const shared = await deriveShared(peerPubB64);
    const rawGroup = await crypto.subtle.exportKey('raw', groupKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shared, rawGroup);
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function unwrapGroupKey(peerPubB64, env) {
    const shared = await deriveShared(peerPubB64);
    const iv = b64d(env.iv);
    const ct = b64d(env.ct);
    const rawGroup = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, shared, ct);
    groupKey = await crypto.subtle.importKey('raw', rawGroup, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(text) {
    if (!groupKey) throw new Error('群密钥未就绪');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, groupKey, enc.encode(text));
    return b64(iv) + ':' + b64(ct);
  }
  async function decrypt(payload) {
    if (!groupKey) return '[等待密钥…]';
    const [ivB64, ctB64] = payload.split(':');
    if (!ivB64 || !ctB64) return payload;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) }, groupKey, b64d(ctB64));
    return dec.decode(pt);
  }

  return {
    initLocal, createGroupKey, wrapGroupKey, unwrapGroupKey,
    encrypt, decrypt,
    hasKey: () => !!groupKey,
  };
})();

// ---------- 头像颜色池 ----------
const AVATAR_COLORS = [
  '#6366f1','#8b5cf6','#a855f7','#d946ef','#ec4899',
  '#f43f5e','#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#06b6d4','#0ea5e9','#3b82f6','#64748b',
];
function avatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash) + seed.charCodeAt(i);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function avatarText(name) {
  const c = (name || '?').trim().charAt(0).toUpperCase();
  return c === '?' ? '?' : c;
}

// ===================================================================
//  大厅
// ===================================================================
$('btnCreate').addEventListener('click', async () => {
  myName = $('userName').value.trim() || `用户${Math.random().toString(36).slice(2, 6)}`;
  myPubKey = await cqCrypto.initLocal();
  await cqCrypto.createGroupKey();
  socket.emit('room:create', { roomName: '', userName: myName }, (res) => {
    if (res && res.roomId) enterRoom(res.roomId);
  });
});
$('btnJoin').addEventListener('click', async () => {
  const rid = $('joinRoomId').value.trim();
  if (!rid) return alert('请输入房间号');
  myName = $('userName').value.trim() || `用户${Math.random().toString(36).slice(2, 6)}`;
  myPubKey = await cqCrypto.initLocal();
  socket.emit('room:join', { roomId: rid, userName: myName }, (res) => {
    if (res && res.error) return alert(res.error);
    enterRoom(rid);
  });
});

function enterRoom(roomId) {
  currentRoomId = roomId;
  lobby.classList.add('hidden');
  room.classList.remove('hidden');
  $('roomIdLabel').textContent = roomId;
  socket.emit('crypto:pubkey', { pubKey: myPubKey });
  appendSystem(`🔒 聊天已端到端加密（ECDH + AES-GCM）`);
  appendSystem(`🎉 欢迎来到房间「${roomId}」——在这里聊天、分享视频、一起看`);
}

// ---------- 加密密钥协商 ----------
socket.on('crypto:pubkey', async ({ fromId, pubKey }) => {
  if (!fromId || !pubKey) return;
  if (!cqCrypto.hasKey()) return;
  try {
    const env = await cqCrypto.wrapGroupKey(pubKey);
    socket.emit('crypto:groupkey', { toId: fromId, pubKey: myPubKey, env });
  } catch (e) { console.error('wrap group key failed', e); }
});
socket.on('crypto:groupkey', async ({ fromId, pubKey, env }) => {
  if (!env) return;
  try {
    await cqCrypto.unwrapGroupKey(pubKey || myPubKey, env);
    appendSystem('🔑 加密通道已建立');
  } catch (e) { console.error('unwrap group key failed', e); }
});

// ===================================================================
//  房间状态 & 用户列表
// ===================================================================
socket.on('room:state', ({ room, users, video }) => {
  $('roomName').textContent = room.name;
  roomUsers = users;
  isHost = !!users.find((u) => u.id === socket.id && u.isHost);
  myId = socket.id;
  renderUsers();

  videoState = { ...videoState, ...video };
  controllerId = video.lastControllerId || '';
  applyVideoState(video, true);
  updateWatchCta();
});
socket.on('room:users', (users) => {
  roomUsers = users;
  isHost = !!users.find((u) => u.id === socket.id && u.isHost);
  renderUsers();
});
socket.on('user:join', ({ user }) => {
  roomUsers.push(user);
  renderUsers();
  if (micOn && myId < user.id) createPeer(user.id);
  appendSystem(`「${user.name}」进入了房间`);
});
socket.on('user:leave', ({ id }) => {
  const u = roomUsers.find((x) => x.id === id);
  roomUsers = roomUsers.filter((x) => x.id !== id);
  renderUsers();
  closePeer(id);
  if (u) appendSystem(`「${u.name}」离开了房间`);
});

// 成员列表（仅成员抽屉使用）
function renderUsers() {
  const ul = $('userListWatch');
  if (!ul) return;
  ul.innerHTML = '';
  roomUsers.forEach((u) => {
    const li = document.createElement('li');
    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    avatar.style.background = `linear-gradient(135deg, ${avatarColor(u.id || u.name)}, ${avatarColor(u.name + '2')})`;
    avatar.textContent = avatarText(u.name);
    li.appendChild(avatar);
    const dot = document.createElement('span');
    dot.className = u.audio ? 'dot-online' : 'dot-offline';
    li.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = u.name;
    if (u.id === myId) { name.innerHTML += '<span class="member-me">（我）</span>'; }
    li.appendChild(name);
    if (u.isHost) {
      const t = document.createElement('span');
      t.className = 'tag-host';
      t.textContent = '👑 房主';
      li.appendChild(t);
    }
    if (u.audio) {
      const m = document.createElement('span');
      m.className = 'tag-mic';
      m.textContent = '🎙️';
      li.appendChild(m);
    }
    ul.appendChild(li);
  });
}

// ===================================================================
//  聊天（主功能：文字 + 图片，端到端加密）
// ===================================================================
$('btnSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

let pendingImages = [];
function addPendingImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 3 * 1024 * 1024) return alert('图片过大（建议 ≤ 3MB），可压缩后再发');
  const reader = new FileReader();
  reader.onload = () => {
    pendingImages.push({ name: file.name, dataUrl: reader.result });
    renderPending();
  };
  reader.readAsDataURL(file);
}
function renderPending() {
  const box = $('pendingAttach');
  box.innerHTML = '';
  if (!pendingImages.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  pendingImages.forEach((img, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'pending-thumb';
    const im = document.createElement('img');
    im.src = img.dataUrl; im.alt = img.name;
    const rm = document.createElement('button');
    rm.className = 'pending-remove'; rm.textContent = '×'; rm.title = '移除';
    rm.addEventListener('click', () => { pendingImages.splice(i, 1); renderPending(); });
    thumb.appendChild(im); thumb.appendChild(rm);
    box.appendChild(thumb);
  });
  const tip = document.createElement('div');
  tip.className = 'pending-tip';
  tip.textContent = pendingImages.length + ' 张图片待发送 · 可输入文字后点发送';
  box.appendChild(tip);
}
$('chatImage').addEventListener('change', (e) => {
  [...e.target.files].forEach(addPendingImage);
  e.target.value = '';
});

// 拖拽图片 → 暂存到输入框
const chatDropZone = $('chatMessages');
let dragCounter = 0;
['dragenter', 'dragover'].forEach((ev) =>
  chatDropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dragCounter++;
    $('dropOverlay').classList.remove('hidden');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  chatDropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; $('dropOverlay').classList.add('hidden'); }
  })
);
chatDropZone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) { alert('仅支持拖入图片'); return; }
  files.forEach(addPendingImage);
});

// 粘贴图片 → 暂存到输入框
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const imgs = [...items].filter((it) => it.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  imgs.forEach((it) => { const f = it.getAsFile(); if (f) addPendingImage(f); });
});

async function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text && pendingImages.length === 0) return;
  if (!cqCrypto.hasKey()) { alert('加密通道尚未建立，请稍候…'); return; }
  try {
    for (const img of pendingImages) {
      const payload = JSON.stringify({ image: img.dataUrl, name: img.name, text: text || '' });
      const cipher = await cqCrypto.encrypt(payload);
      socket.emit('chat:send', { cipher });
    }
    if (pendingImages.length === 0 && text) {
      const cipher = await cqCrypto.encrypt(JSON.stringify({ text }));
      socket.emit('chat:send', { cipher });
    }
  } catch (e) {
    console.error('加密失败', e);
    alert('消息加密失败，未发送');
    return;
  }
  $('chatInput').value = '';
  pendingImages = [];
  renderPending();
}

socket.on('chat:message', async (m) => {
  const box = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'msg' + (m.self ? ' self' : '');
  const t = new Date(m.ts);

  if (!m.self) {
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.style.background = `linear-gradient(135deg, ${avatarColor(m.user || '')}, ${avatarColor(m.user + '_')})`;
    av.textContent = avatarText(m.user);
    el.appendChild(av);
  }

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<span class="who"></span><span class="time">${pad(t.getHours())}:${pad(t.getMinutes())}</span>`;
  head.querySelector('.who').textContent = m.user;

  const body = document.createElement('div');
  body.className = 'msg-body';
  const loading = document.createElement('span');
  loading.className = 'txt';
  loading.textContent = '🔓 解密中…';
  body.appendChild(loading);
  el.appendChild(head);
  el.appendChild(body);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;

  let plain;
  try { plain = await cqCrypto.decrypt(m.cipher); }
  catch (e) { loading.textContent = '⚠️ 解密失败'; return; }
  let data;
  try { data = JSON.parse(plain); } catch (e) { data = { text: plain }; }
  loading.remove();
  if (data.image) {
    const img = document.createElement('img');
    img.src = data.image; img.className = 'msg-img'; img.alt = data.name || '图片';
    body.appendChild(img);
    img.addEventListener('click', () => openLightbox(img.src));
  }
  if (data.text) {
    const txt = document.createElement('span');
    txt.className = 'txt'; txt.textContent = data.text;
    body.appendChild(txt);
  }
  box.scrollTop = box.scrollHeight;

  // 观影模式：以弹幕形式飘出
  if (watchModeOn) {
    const dm = data.image && !data.text ? '[图片]' : (data.text || (data.image ? '[图片]' : ''));
    if (dm) spawnDanmaku(dm);
  }
});

function openLightbox(src) {
  const overlay = $('lightboxOverlay');
  const img = $('lightboxImg');
  img.src = src;
  overlay.classList.remove('hidden');
  overlay.onclick = () => overlay.classList.add('hidden');
}

function appendSystem(text) {
  const box = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'msg system';
  const sp = document.createElement('span');
  sp.textContent = text;
  el.appendChild(sp);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// ===================================================================
//  观影模式（弹幕）
// ===================================================================
const watchMode = $('watchMode');
const watchEmpty = $('watchEmpty');
const watchStage = $('watchStage');
const wcSeek = $('wcSeek');
const wcTime = $('wcTime');
const watchBigPlay = $('watchBigPlay');

function updateWatchCta() {
  const has = !!(videoState.bili || videoState.url || videoState.fileName);
  const cta = $('watchCta');
  if (has) {
    cta.classList.remove('hidden');
    $('watchCtaTitle').textContent = videoState.fileName || (videoState.bili ? (lastVideoTitle || 'B 站视频') : '共享视频');
    $('watchCtaSub').textContent = '点这里进入观影模式，聊天会以弹幕飘过屏幕';
  } else {
    cta.classList.add('hidden');
  }
}

function enterWatch() {
  watchModeOn = true;
  watchMode.classList.remove('hidden');
  if (videoState.bili || videoState.url || videoState.fileName) watchEmpty.classList.add('hidden');
  else watchEmpty.classList.remove('hidden');
  $('watchTitle').textContent = lastVideoTitle || (videoState.fileName ? videoState.fileName : '共享视频');
  syncWatchUI();
  // 进入即播放（进入观影是用户主动点击，允许自动播放带声音）
  if (videoState.bili || videoState.url || videoState.fileName) video.play().catch(() => {});
}
function exitWatch() {
  watchModeOn = false;
  watchMode.classList.add('hidden');
  try { video.pause(); videoAudio.pause(); } catch (e) {} // 本地暂停，避免后台幽灵声音（不影响他人）
}
function syncWatchUI() { updatePlayUI(); }

$('btnWatch').addEventListener('click', enterWatch);
$('watchCtaBtn').addEventListener('click', enterWatch);
$('watchExit').addEventListener('click', exitWatch);

// 加载面板
$('watchLoad').addEventListener('click', () => $('watchLoadPanel').classList.toggle('hidden'));
$('watchLoadClose').addEventListener('click', () => $('watchLoadPanel').classList.add('hidden'));

// 成员抽屉
$('btnMembers').addEventListener('click', () => $('membersDrawer').classList.remove('hidden'));
$('watchMembers').addEventListener('click', () => $('membersDrawer').classList.remove('hidden'));
$('membersClose').addEventListener('click', () => $('membersDrawer').classList.add('hidden'));

// 观影模式里发弹幕
function sendWatch() {
  const text = $('watchInput').value.trim();
  if (!text) return;
  $('chatInput').value = text;
  $('watchInput').value = '';
  sendChat();
}
$('watchSend').addEventListener('click', sendWatch);
$('watchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWatch(); });

// ---------- 弹幕引擎 ----------
const danmakuLayer = $('danmakuLayer');
let danmakuLanes = [];
function danmakuLaneCount() {
  const h = danmakuLayer.clientHeight || 480;
  return Math.max(4, Math.floor((h - 16) / 30));
}
function pickLane() {
  const n = danmakuLaneCount();
  if (danmakuLanes.length !== n) danmakuLanes = new Array(n).fill(0);
  const now = performance.now();
  let best = 0, bestT = Infinity;
  for (let i = 0; i < n; i++) {
    if (danmakuLanes[i] <= now) return i;
    if (danmakuLanes[i] < bestT) { bestT = danmakuLanes[i]; best = i; }
  }
  return best;
}
function spawnDanmaku(textRaw) {
  if (!danmakuOn) return;
  const text = String(textRaw || '').replace(/\s+/g, ' ').slice(0, 50);
  if (!text) return;
  const span = document.createElement('div');
  span.className = 'danmaku';
  span.textContent = text;
  danmakuLayer.appendChild(span);
  const layerW = danmakuLayer.clientWidth || 800;
  const tw = span.offsetWidth;
  const lane = pickLane();
  span.style.top = (10 + lane * 30) + 'px';
  const speed = 130; // px/s
  const dur = Math.max(5000, ((layerW + tw) / speed) * 1000);
  const anim = span.animate(
    [{ transform: `translateX(${layerW}px)` }, { transform: `translateX(${-tw}px)` }],
    { duration: dur, easing: 'linear' }
  );
  danmakuLanes[lane] = performance.now() + ((tw + 40) / speed) * 1000;
  anim.onfinish = () => span.remove();
}

// ---------- 自定义播放控制条 ----------
function updatePlayUI() {
  const playing = !video.paused;
  const playIcon = $('wcPlay').querySelector('.ic-play');
  const pauseIcon = $('wcPlay').querySelector('.ic-pause');
  if (playIcon) playIcon.classList.toggle('hidden', playing);
  if (pauseIcon) pauseIcon.classList.toggle('hidden', !playing);
  watchBigPlay.classList.toggle('hidden', playing);
  const c = document.querySelector('.watch-controls');
  if (c) c.classList.toggle('show', !playing);
}
function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
$('wcPlay').addEventListener('click', togglePlay);
watchBigPlay.addEventListener('click', togglePlay);
wcSeek.addEventListener('input', () => {
  if (video.duration) wcTime.textContent = `${fmt((wcSeek.value / 100) * video.duration)} / ${fmt(video.duration)}`;
});
wcSeek.addEventListener('change', () => {
  if (!video.duration) return;
  const t = (wcSeek.value / 100) * video.duration;
  applyingRemote = true;
  video.currentTime = t;
  if (biliSyncOn) { try { videoAudio.currentTime = t; } catch (e) {} }
  setTimeout(() => { applyingRemote = false; }, 200);
  emitAction('seek');
});
$('wcVolume').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  video.volume = v; videoAudio.volume = v;
  video.muted = v === 0; videoAudio.muted = v === 0;
});
$('wcFull').addEventListener('click', () => {
  if (!document.fullscreenElement) { if (watchStage.requestFullscreen) watchStage.requestFullscreen(); }
  else { if (document.exitFullscreen) document.exitFullscreen(); }
});
$('wcDanmaku').addEventListener('click', () => {
  danmakuOn = !danmakuOn;
  $('wcDanmaku').classList.toggle('active', danmakuOn);
});
// 控制条自动显隐
let ctrlTimer = null;
watchStage.addEventListener('mousemove', () => {
  const c = document.querySelector('.watch-controls');
  if (c) c.classList.add('show');
  clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => { if (!video.paused && c) c.classList.remove('show'); }, 2600);
});

// ===================================================================
//  视频：加载 & 同步
// ===================================================================
const video = $('video');
const videoAudio = $('videoAudio');

$('btnLoadUrl').addEventListener('click', () => {
  const url = $('videoUrl').value.trim();
  if (!url) return;
  stopDash();
  socket.emit('video:set', { url, fileName: '', bili: '' });
  $('watchLoadPanel').classList.add('hidden');
});
$('videoFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopDash();
  socket.emit('video:set', { url: '', fileName: file.name, bili: '' });
  $('watchLoadPanel').classList.add('hidden');
});
$('btnLoadBili').addEventListener('click', async () => {
  const url = $('biliUrl').value.trim();
  if (!url) return;
  const m = url.match(/BV[0-9A-Za-z]+/);
  if (!m) return alert('请粘贴包含 BV 号的 B 站视频链接');
  socket.emit('video:set', { url: '', fileName: '', bili: m[0] });
  $('watchLoadPanel').classList.add('hidden');
});

$('biliQuality').addEventListener('change', (e) => {
  currentBiliQn = e.target.value;
  if (videoState.bili) loadBili(videoState.bili, video.currentTime);
});

socket.on('video:state', (v) => {
  videoState = { ...videoState, ...v };
  controllerId = v.lastControllerId || '';
  if (v.url || v.fileName || v.bili) watchEmpty.classList.add('hidden');
  else watchEmpty.classList.remove('hidden');
  $('watchLoadPanel').classList.add('hidden');
  updateWatchCta();
  applyVideoState(v, false);
});

function applyVideoState(v, isInitial) {
  if (v.bili) {
    loadBili(v.bili, parseStartAt(v._rawUrl));
    return;
  }
  if (v.url) {
    stopDash();
    watchEmpty.classList.add('hidden');
    if (video.src !== v.url) video.src = v.url;
    $('videoHint').textContent = '已加载视频链接，点击播放即可（所有人进度同步）。';
  } else if (v.fileName) {
    stopDash();
    watchEmpty.classList.add('hidden');
    if (isInitial) $('videoHint').textContent = `房主/成员加载了本地文件「${v.fileName}」，请在本机选择相同文件以保证进度一致。`;
    else $('videoHint').textContent = `有人加载了本地文件「${v.fileName}」，请在本机选择相同文件后点击播放。`;
  }
  if (typeof v.currentTime === 'number') {
    if (Math.abs(video.currentTime - v.currentTime) > 0.5) video.currentTime = v.currentTime;
  }
  if (v.action === 'load') video.pause();
}

function parseStartAt(rawUrl) {
  if (!rawUrl) return 0;
  const m = rawUrl.match(/[?&]t=([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function stopDash() {
  stopBiliSync();
  if (dashPlayer) {
    try { dashPlayer.reset(); } catch (e) {}
    dashPlayer = null;
  }
  try { videoAudio.removeAttribute('src'); videoAudio.load(); } catch (e) {}
}

async function loadBili(bvid, startAt = 0) {
  $('videoHint').textContent = `正在解析 B 站视频（${currentBiliQn}）…`;
  let data;
  try {
    const res = await fetch(`/api/resolve-bili?url=${encodeURIComponent(bvid)}&qn=${encodeURIComponent(currentBiliQn)}`);
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (e) {
    $('videoHint').textContent = 'B 站解析失败：' + e.message;
    return;
  }

  const sel = $('biliQuality');
  sel.hidden = false; sel.innerHTML = '';
  (data.qualities || []).forEach((q) => {
    const opt = document.createElement('option');
    opt.value = q.label; opt.textContent = q.label;
    if (q.label === (data.quality || currentBiliQn)) opt.selected = true;
    sel.appendChild(opt);
  });
  currentBiliQn = data.quality || currentBiliQn;
  lastVideoTitle = data.title || '';

  watchEmpty.classList.add('hidden');
  stopBiliSync();

  // 视频轨 / 音频轨：经服务端代理绕过 B 站防盗链
  video.src = '/api/bili-media?kind=video&url=' + encodeURIComponent(data.video.baseUrl);
  if (data.audio && data.audio.baseUrl) {
    videoAudio.src = '/api/bili-media?kind=audio&url=' + encodeURIComponent(data.audio.baseUrl);
    startBiliSync();
  }

  const onMeta = () => {
    if (startAt > 0) {
      applyingRemote = true;
      try { video.currentTime = startAt; } catch (e) {}
      setTimeout(() => { applyingRemote = false; }, 300);
    }
    video.removeEventListener('loadedmetadata', onMeta);
  };
  video.addEventListener('loadedmetadata', onMeta);

  $('videoHint').textContent = `B 站：${data.title}（${data.quality}，各自从 B 站 CDN 拉流，进度同步）`;
  $('watchTitle').textContent = data.title || 'B 站视频';
  updateWatchCta();
  video.play().catch(() => {});
}

// 视频/音频双轨同步
let biliSyncOn = false;
function startBiliSync() { biliSyncOn = true; }
function stopBiliSync() { biliSyncOn = false; }
video.addEventListener('play', () => { if (biliSyncOn) videoAudio.play().catch(() => {}); });
video.addEventListener('pause', () => { if (biliSyncOn) videoAudio.pause(); });
video.addEventListener('seeked', () => { if (biliSyncOn) { try { videoAudio.currentTime = video.currentTime; } catch (e) {} } });
video.addEventListener('timeupdate', () => {
  if (!biliSyncOn) return;
  const drift = videoAudio.currentTime - video.currentTime;
  if (Math.abs(drift) > 0.3) { try { videoAudio.currentTime = video.currentTime; } catch (e) {} }
});

// 播放状态 → UI + 对外广播
video.addEventListener('play', () => { updatePlayUI(); if (!applyingRemote) emitAction('play'); });
video.addEventListener('pause', () => { updatePlayUI(); if (!applyingRemote) emitAction('pause'); });
video.addEventListener('seeked', () => { if (!applyingRemote) emitAction('seek'); });
video.addEventListener('timeupdate', () => {
  if (video.duration) {
    wcSeek.value = (video.currentTime / video.duration) * 100;
    wcTime.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }
});

function emitAction(action) {
  socket.emit('video:action', { action, time: video.currentTime });
}

socket.on('video:action', ({ action, time, by, byId, serverTime }) => {
  controllerId = byId;
  videoState.playing = action === 'play';
  updateControllerTag(by);
  applyingRemote = true;
  if (typeof time === 'number' && Math.abs(video.currentTime - time) > 0.3) {
    video.currentTime = time + (serverTime ? (Date.now() - serverTime) / 1000 : 0);
    if (biliSyncOn) { try { videoAudio.currentTime = video.currentTime; } catch (e) {} }
  }
  if (action === 'play') video.play().catch(() => {});
  else if (action === 'pause') video.pause();
  setTimeout(() => { applyingRemote = false; }, 350);
});

function updateControllerTag(by) {
  const tag = $('controllerTag');
  if (by) { tag.textContent = `🎮 ${by} 控制中`; tag.classList.remove('hidden'); }
  else tag.classList.add('hidden');
}

// 周期纠偏：仅控制者发起
setInterval(() => {
  if (controllerId === myId && !video.paused && videoState.playing) {
    socket.emit('video:sync', { time: video.currentTime });
  }
}, 5000);
socket.on('video:sync', ({ time, byId }) => {
  if (byId === myId) return;
  if (videoState.playing && Math.abs(video.currentTime - time) > 1.0) {
    applyingRemote = true;
    video.currentTime = time;
    if (biliSyncOn) { try { videoAudio.currentTime = time; } catch (e) {} }
    setTimeout(() => { applyingRemote = false; }, 200);
  }
});

// ===================================================================
//  连麦：WebRTC（完美协商 mesh）
// ===================================================================
$('btnMic').addEventListener('click', toggleMic);
$('watchMic').addEventListener('click', toggleMic);

async function toggleMic() {
  if (!micOn) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err) { alert('无法获取麦克风：' + err.message); return; }
    micOn = true;
    $('btnMic').innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg><span>闭麦</span>';
    $('watchMic').classList.add('active');
    socket.emit('user:audio', { enabled: true });
    roomUsers.forEach((u) => {
      if (u.id === myId) return;
      const entry = peers.get(u.id);
      if (entry) entry.pc.addTrack(localStream.getTracks()[0], localStream);
      else createPeer(u.id);
    });
  } else {
    micOn = false;
    $('btnMic').innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg><span>开麦</span>';
    $('watchMic').classList.remove('active');
    socket.emit('user:audio', { enabled: false });
    peers.forEach((_, id) => closePeer(id));
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  }
}

function createPeer(targetId) {
  if (peers.has(targetId)) return peers.get(targetId);
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = { pc, polite: myId < targetId, makingOffer: false, ignoreOffer: false };
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('rtc:signal', { to: targetId, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => attachRemote(e.streams[0] || new MediaStream([e.track]), targetId);
  pc.onnegotiationneeded = async () => {
    try { entry.makingOffer = true; await pc.setLocalDescription(); socket.emit('rtc:signal', { to: targetId, data: pc.localDescription }); }
    catch (err) { console.error(err); }
    finally { entry.makingOffer = false; }
  };
  peers.set(targetId, entry);
  return entry;
}

async function handleSignal(from, desc) {
  const entry = createPeer(from);
  const { pc, polite } = entry;
  const offerCollision = desc.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
  entry.ignoreOffer = !polite && offerCollision;
  if (entry.ignoreOffer) return;
  try {
    await pc.setRemoteDescription(desc);
    if (desc.type === 'offer') { await pc.setLocalDescription(); socket.emit('rtc:signal', { to: from, data: pc.localDescription }); }
  } catch (err) { console.error(err); }
}

socket.on('rtc:signal', async ({ from, data }) => {
  if (data.candidate) {
    const entry = peers.get(from);
    if (entry) { try { await entry.pc.addIceCandidate(data.candidate); } catch (e) { console.error(e); } }
    return;
  }
  await handleSignal(from, data);
});
socket.on('user:audio', ({ id, enabled }) => { if (!enabled) closePeer(id); });

function attachRemote(stream, id) {
  let a = remoteAudios.get(id);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true; a.id = 'audio-' + id;
    document.body.appendChild(a);
    remoteAudios.set(id, a);
  }
  a.srcObject = stream;
}
function closePeer(id) {
  const entry = peers.get(id);
  if (entry) { try { entry.pc.close(); } catch (e) {} peers.delete(id); }
  const a = remoteAudios.get(id);
  if (a) { a.srcObject = null; a.remove(); remoteAudios.delete(id); }
}

// ===================================================================
//  离开
// ===================================================================
$('btnLeave').addEventListener('click', leave);
$('btnCopy').addEventListener('click', () => {
  navigator.clipboard.writeText(currentRoomId).then(() => alert('房间号已复制：' + currentRoomId));
});
function leave() {
  if (!confirm('确定离开房间？')) return;
  peers.forEach((_, id) => closePeer(id));
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  location.reload();
}

// ===================================================================
//  工具函数
// ===================================================================
function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${pad(m)}:${pad(sec)}`;
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

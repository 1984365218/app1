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
const STORAGE_KEY = 'watchparty:settings:v1';
const THEME_OPTIONS = [
  { value: 'midnight', label: '午夜' },
  { value: 'daylight', label: '日光' },
  { value: 'mist', label: '薄雾' },
  { value: 'sakura', label: '初樱' },
  { value: 'cream', label: '奶油' },
  { value: 'ocean', label: '海盐' },
  { value: 'forest', label: '松林' },
  { value: 'cinema', label: '影院' },
];
const DEFAULT_THEME = 'midnight';
// 头像颜色池：提前声明，避免 profileColor / avatarColor 在初始化阶段引用时触发 TDZ
const AVATAR_COLORS = [
  '#6366f1','#8b5cf6','#a855f7','#d946ef','#ec4899',
  '#f43f5e','#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#06b6d4','#0ea5e9','#3b82f6','#64748b',
];
const savedSettings = loadSettings();
const initialInviteRoom = parseInviteRoomFromUrl();

// ---------- 全局状态 ----------
let myId = null;
let myName = savedSettings.userName || '';
let userProfile = {
  id: savedSettings.userId || createLocalUserId(),
  name: savedSettings.userName || '',
  avatar: savedSettings.avatar || '',
  avatarColor: savedSettings.avatarColor || '',
};
let currentRoomId = null;
let roomUsers = [];
let isHost = false;
let currentBiliQn = savedSettings.biliQn || '720P'; // 当前选中的 B 站清晰度

let videoState = { url: '', fileName: '', bili: '', kind: '', iframeUrl: '', playing: false, currentTime: 0, lastControllerId: '', lastController: '' };
let controllerId = '';
let lastVideoTitle = ''; // 观影模式标题
let localFileName = '';
let localFileUrl = '';

let watchModeOn = false; // 是否处于观影模式（弹幕）
let danmakuOn = savedSettings.danmakuOn !== false;    // 弹幕开关

let applyingRemote = false; // 正在应用远端指令，避免事件回环

// ---------- WebRTC ----------
let localStream = null;
let micOn = false;
let selectedMicDeviceId = savedSettings.micDeviceId || '';
let micTestStream = null;
let micTesting = false; // 是否正在试音（独立于 micTestStream：开麦时复用 localStream 也要靠它判别状态）
let audioContext = null;
let localAudioSource = null;
let localAnalyser = null;
let localLevelRaf = 0;
let lastSpeakingEmit = 0;
const userAudioLevels = new Map();
const remoteAudioPrefs = new Map(Object.entries(savedSettings.remoteAudioPrefs || {}));
const peers = new Map();
const remoteAudios = new Map();
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---------- DOM 助手 ----------
const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const room = $('room');

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveSetting(key, value) {
  savedSettings[key] = value;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSettings)); } catch (e) {}
}

function createLocalUserId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function persistProfile(profile = userProfile) {
  userProfile = { ...userProfile, ...profile };
  saveSetting('userId', userProfile.id);
  saveSetting('userName', userProfile.name || '');
  saveSetting('avatar', userProfile.avatar || '');
  saveSetting('avatarColor', userProfile.avatarColor || '');
}

function avatarInitial(name) {
  const c = (name || '?').trim().charAt(0).toUpperCase();
  return c || '?';
}

function profileColor(seed) {
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
  // 与成员列表头像共用 AVATAR_COLORS 色池，保证同一个人头像颜色在资料面板和房间列表里一致
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function renderProfileUi() {
  const name = userProfile.name || myName || '';
  // 仅接受经服务端校验过的 data:image/... 头像，防止任意字符串注入 CSS url()
  const safeAvatar = typeof userProfile.avatar === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(userProfile.avatar) ? userProfile.avatar : '';
  const avatarEls = [$('profileAvatar'), $('profileAvatarLarge')].filter(Boolean);
  avatarEls.forEach((el) => {
    el.textContent = safeAvatar ? '' : avatarInitial(name);
    el.style.background = safeAvatar
      ? `center / cover no-repeat url("${safeAvatar}")`
      : `linear-gradient(135deg, ${userProfile.avatarColor || profileColor(userProfile.id || name)}, ${profileColor((userProfile.id || name) + '2')})`;
  });
  if ($('profileNamePreview')) $('profileNamePreview').textContent = name || '未设置昵称';
  if ($('profileNameInput')) $('profileNameInput').value = name;
  if ($('userName') && document.activeElement !== $('userName')) $('userName').value = name;
}

async function syncUserProfile({ silent = true } = {}) {
  const nameFromInput = $('userName') ? $('userName').value.trim() : '';
  const nextName = nameFromInput || userProfile.name || `用户${Math.random().toString(36).slice(2, 6)}`;
  persistProfile({ ...userProfile, name: nextName });
  myName = nextName;
  renderProfileUi();
  try {
    const res = await fetch('/api/users/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userProfile.id, name: userProfile.name, avatar: userProfile.avatar }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'profile failed');
    persistProfile(data);
    userProfile.hasPassword = !!data.hasPassword;
    try { renderProfileAccountBox(); } catch (e) {}
    myName = data.name;
    renderProfileUi();
    return data;
  } catch (e) {
    if (!silent) alert('资料保存失败：' + (e.message || e));
    return userProfile;
  }
}

async function saveProfileFromPanel() {
  const name = $('profileNameInput').value.trim() || userProfile.name || myName;
  persistProfile({ name });
  myName = name;
  renderProfileUi();
  const data = await syncUserProfile({ silent: false });
  if (currentRoomId) socket.emit('user:profile', { userId: data.id, name: data.name, avatar: data.avatar });
  $('profilePanel').classList.add('hidden');
}

function readAvatarFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 512 * 1024) {
    alert('头像请控制在 512KB 以内');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    persistProfile({ avatar: reader.result });
    renderProfileUi();
    syncUserProfile({ silent: true }).then((data) => {
      if (currentRoomId) socket.emit('user:profile', { userId: data.id, name: data.name, avatar: data.avatar });
    });
  };
  reader.readAsDataURL(file);
}

function isKnownTheme(theme) {
  return THEME_OPTIONS.some((item) => item.value === theme);
}

function normalizeTheme(theme) {
  return isKnownTheme(theme) ? theme : DEFAULT_THEME;
}

function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = nextTheme;
  if (persist) saveSetting('theme', nextTheme);
  document.querySelectorAll('[data-theme-select="true"]').forEach((select) => {
    if (select.value !== nextTheme) select.value = nextTheme;
  });
}

function initThemeControls() {
  const selects = ['themeSelectLobby', 'themeSelectRoom', 'themeSelectWatch']
    .map((id) => $(id))
    .filter(Boolean);

  selects.forEach((select) => {
    select.innerHTML = '';
    THEME_OPTIONS.forEach((theme) => {
      const option = document.createElement('option');
      option.value = theme.value;
      option.textContent = theme.label;
      select.appendChild(option);
    });
    select.dataset.themeSelect = 'true';
    select.addEventListener('change', () => applyTheme(select.value));
  });

  applyTheme(savedSettings.theme, { persist: false });
}

function normalizeRoomId(roomId) {
  return String(roomId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseInviteRoomFromUrl() {
  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]+)/);
  if (match) return normalizeRoomId(match[1]);
  const param = new URLSearchParams(location.search).get('room');
  return param ? normalizeRoomId(param) : '';
}

function inviteLink(roomId) {
  return `${location.origin}/r/${normalizeRoomId(roomId)}`;
}

initThemeControls();
persistProfile(userProfile);
renderProfileUi();
syncUserProfile({ silent: true });

// 大厅首发：若本机已有保存昵称，就主动 lookup 一次，让旧账号提示自然浮现
// （已自动入房的情况就不打扰——届时 setTimeout(joinRoom) 已经接管）
if (myName && !initialInviteRoom) {
  setTimeout(() => { try { maybeLookupReclaim(); } catch (e) {} }, 0);
}

$('avatarPick').addEventListener('click', () => $('avatarInput').click());
$('profileAvatarPick').addEventListener('click', () => $('profileAvatarInput').click());
$('avatarInput').addEventListener('change', (e) => { readAvatarFile(e.target.files[0]); e.target.value = ''; });
$('profileAvatarInput').addEventListener('change', (e) => { readAvatarFile(e.target.files[0]); e.target.value = ''; });
$('openProfileLobby').addEventListener('click', () => { renderProfileUi(); $('profilePanel').classList.remove('hidden'); });
$('btnProfile').addEventListener('click', () => { renderProfileUi(); $('profilePanel').classList.remove('hidden'); });
$('profileClose').addEventListener('click', () => $('profilePanel').classList.add('hidden'));
$('profileSave').addEventListener('click', saveProfileFromPanel);

// ---------- 账号召回（大厅主昵称框就近提示）----------
// 设计理念：不管新账号旧账号都用同一个 `#userName` 框。
// 失焦/回车时按当前昵称自动 lookup：
//   - 0 候选 → 视为新昵称，将创建新账号。
//   - 1 候选且无密码 → 立即自动召回，切换为旧账号并提示。
//   - 1 候选且设密码 → 在提示区显示密码框，回填后召回。
//   - 多候选 → 显示候选列表（头像色 + 最后活跃）让用户选。
// 召回未完成时创建/加入按钮被禁用，直到用户完成召回或选择"改用新账号"。
let reclaimCandidate = null;      // 当前选中的候选账号对象
let reclaimNeedPassword = false;   // 仍需用户填密码
let reclaimResolved = false;      // 已可进入房间（已召回旧账号、或确认新建账号）
let reclaimHasMultiple = false;    // 多候选但用户还没选
let lookupInFlight = false;        // lookup 请求正在进行
let lastLookupName = '';           // 上次 lookup 用的昵称，避免重复查询
let reclaimInitialTriggered = false; // 启动时已对已保存昵称跑过一次 lookup

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 带超时的 fetch（JSON）。避免网络异常时 lookupInFlight 永久卡 true 而阻塞"创建/加入"按钮。
async function fetchJsonWithTimeout(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function currentNameInput() {
  return ($('userName') ? $('userName').value : '').trim();
}

function showAccountHint(html) {
  const hint = $('accountHint');
  if (!hint) return;
  if (!html) { hint.innerHTML = ''; hint.classList.add('hidden'); return; }
  hint.innerHTML = html;
  hint.classList.remove('hidden');
}

function clearAccountHint() { showAccountHint(''); }

function setCreateJoinEnabled(enabled) {
  if ($('btnCreate')) $('btnCreate').disabled = !enabled;
  if ($('btnJoin')) $('btnJoin').disabled = !enabled;
}

function resetReclaimState() {
  reclaimCandidate = null;
  reclaimNeedPassword = false;
  reclaimResolved = false;
  reclaimHasMultiple = false;
}

function hintForNewName(name) {
  return `<span class="ah-tip ah-new">✨ 没有叫「${escHtml(name)}」的旧账号，将以新账号进入。</span>`;
}

// 在主昵称框失焦/变化/创建前调用：去服务端 lookup 一次并按候选数走流程
async function maybeLookupReclaim() {
  const name = currentNameInput();
  // 输入发生（清空、变化）时，重置召回状态
  if (name !== lastLookupName) {
    resetReclaimState();
    lastLookupName = name;
  }
  clearAccountHint();
  if (!name) { setCreateJoinEnabled(true); return; }
  if (lookupInFlight) return;
  lookupInFlight = true;
  const queryName = name;
  try {
    const data = await fetchJsonWithTimeout(`/api/users/lookup?name=${encodeURIComponent(name)}`);
    // 昵称一致性：fetch 期间用户可能继续改了昵称，旧请求结果作废，避免按旧昵称错误召回/提示
    if (currentNameInput() !== queryName) { maybeLookupReclaim(); return; }
    const candidates = (data && data.candidates) || [];
    if (!candidates.length) {
      reclaimResolved = true;               // 新昵称走新建流程
      setCreateJoinEnabled(true);
      showAccountHint(hintForNewName(name));
      return;
    }
    if (candidates.length === 1) {
      reclaimCandidate = candidates[0];
      await proceedReclaimForSingle();
    } else {
      renderReclaimCandidatesList(candidates);
    }
  } catch (e) {
    // 网络等异常：放行走新建，不阻塞用户使用
    reclaimResolved = true;
    setCreateJoinEnabled(true);
    showAccountHint(`<span class="ah-tip ah-err">未能查询旧账号（${escHtml((e && e.message) || '网络错误')}），将以新账号进入。</span>`);
  } finally {
    lookupInFlight = false;
  }
}

// 单候选：若无需密码立即自动召回；否则显示密码行让用户确认
async function proceedReclaimForSingle() {
  const c = reclaimCandidate;
  if (!c) return;
  if (c.hasPassword) {
    reclaimNeedPassword = true;
    reclaimResolved = false;
    setCreateJoinEnabled(false);
    showAccountHint(`
      <span class="ah-tip ah-pwd">检测到同名账号已设密码，请输入密码以召回此账号：</span>
      <div class="ah-pwd-row">
        <input id="ahPwd" type="password" placeholder="账号密码" autocomplete="off" />
        <button id="ahPwdOk" class="ah-pwd-ok" type="button">召回</button>
        <button id="ahNewAcct" class="ah-new-acct" type="button">改用新账号</button>
      </div>
      <span id="ahMsg" class="ah-msg"></span>
    `);
    const pwdEl = $('ahPwd');
    if (pwdEl) {
      pwdEl.focus();
      pwdEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runReclaimWithPassword(); });
    }
    if ($('ahPwdOk')) $('ahPwdOk').addEventListener('click', runReclaimWithPassword);
    if ($('ahNewAcct')) $('ahNewAcct').addEventListener('click', () => {
      resetReclaimState();
      reclaimResolved = true;
      setCreateJoinEnabled(true);
      showAccountHint(hintForNewName(currentNameInput()));
    });
  } else {
    await runReclaimForNoPassword();
  }
}

function renderReclaimCandidatesList(list) {
  reclaimHasMultiple = true;
  reclaimResolved = false;
  setCreateJoinEnabled(false);
  let html = `<span class="ah-tip ah-multi">找到 ${list.length} 个同名账号，请挑一个：</span><div class="ah-list">`;
  list.forEach((c, i) => {
    html += `<button type="button" class="reclaim-candidate" data-i="${i}">`
      + `<span class="rc-dot" style="background:${escHtml(c.avatarColor || 'transparent')}"></span>`
      + `<span class="rc-meta">${escHtml(c.name || '')}${c.hasPassword ? ' · 🔒 已设密码' : ''} · ${new Date(c.updatedAt).toLocaleString()}</span>`
      + `</button>`;
  });
  html += `</div><button id="ahNewAcct" class="ah-new-acct" type="button">改用新账号</button>`;
  showAccountHint(html);
  list.forEach((c, i) => {
    const btn = document.querySelector(`#accountHint .reclaim-candidate[data-i="${i}"]`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      reclaimCandidate = c;
      reclaimHasMultiple = false;
      await proceedReclaimForSingle();
    });
  });
  if ($('ahNewAcct')) $('ahNewAcct').addEventListener('click', () => {
    resetReclaimState();
    reclaimResolved = true;
    setCreateJoinEnabled(true);
    showAccountHint(hintForNewName(currentNameInput()));
  });
}

async function runReclaimForNoPassword() {
  const c = reclaimCandidate;
  if (!c) return;
  try {
    const res = await fetch('/api/users/reclaim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: c.id, password: '' }),
      signal: (() => { const a = new AbortController(); setTimeout(() => a.abort(), 8000); return a.signal; })(),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      showAccountHint(`<span class="ah-tip ah-err">召回失败：${escHtml(data.error || '未知错误')}</span><button id="ahNewAcct" class="ah-new-acct" type="button">改用新账号</button>`);
      bindNewAccountBtn();
      setCreateJoinEnabled(false);
      return;
    }
    applyReclaimResult(data);
    showAccountHint(`<span class="ah-tip ah-ok">✅ 已召回旧账号「${escHtml(data.name || '')}」，本次将使用它进入房间。</span>`);
  } catch (e) {
    showAccountHint(`<span class="ah-tip ah-err">召回失败：${escHtml((e && e.message) || '网络错误')}</span><button id="ahNewAcct" class="ah-new-acct" type="button">改用新账号</button>`);
    bindNewAccountBtn();
    setCreateJoinEnabled(false);
  }
}

async function runReclaimWithPassword() {
  const c = reclaimCandidate;
  if (!c) return;
  const pwdEl = $('ahPwd');
  const msgEl = $('ahMsg');
  const pw = pwdEl ? pwdEl.value : '';
  try {
    const res = await fetch('/api/users/reclaim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: c.id, password: pw }),
      signal: (() => { const a = new AbortController(); setTimeout(() => a.abort(), 8000); return a.signal; })(),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (msgEl) msgEl.textContent = data.error || '密码错误或召回失败';
      setCreateJoinEnabled(false);
      return;
    }
    applyReclaimResult(data);
    showAccountHint(`<span class="ah-tip ah-ok">✅ 密码正确，已召回账号「${escHtml(data.name || '')}」。</span>`);
    setCreateJoinEnabled(true);
  } catch (e) {
    if (msgEl) msgEl.textContent = '召回失败：' + ((e && e.message) || e);
  }
}

function bindNewAccountBtn() {
  const b = $('ahNewAcct');
  if (b) b.addEventListener('click', () => {
    resetReclaimState();
    reclaimResolved = true;
    setCreateJoinEnabled(true);
    showAccountHint(hintForNewName(currentNameInput()));
  });
}

function applyReclaimResult(data) {
  // 把本机当前账号完整替换为召回到的旧账号
  persistProfile({
    id: data.id,
    name: data.name || '',
    avatar: data.avatar || '',
    avatarColor: data.avatarColor || '',
  });
  userProfile = {
    id: data.id,
    name: data.name,
    avatar: data.avatar || '',
    avatarColor: data.avatarColor || '',
    hasPassword: !!(data && data.hasPassword),
  };
  myName = data.name || myName;
  if ($('userName')) $('userName').value = userProfile.name; // 召回后昵称以服务端为准
  reclaimNeedPassword = false;
  reclaimHasMultiple = false;
  reclaimResolved = true;
  setCreateJoinEnabled(true);
  renderProfileUi();
  try { renderProfileAccountBox(); } catch (e) {}
}

// 在创建/加入房间前确保召回已闭环（用户已召回，或确认新建）
async function ensureReclaimResolved() {
  const name = currentNameInput();
  if (!name) return true; // 上层 prepareIdentity 会兜底随机昵称
  // lookup 尚未触发或正在跑，触发/等待
  if (lastLookupName !== name) {
    await maybeLookupReclaim();
  }
  // 等待进行中的请求
  let waited = 0;
  while (lookupInFlight && waited < 4000) { await new Promise((r) => setTimeout(r, 60)); waited += 60; }
  if (lookupInFlight) return true; // 超时放行，避免卡死
  if (!reclaimResolved) {
    if (reclaimHasMultiple) {
      alert('找到多个同名账号，请先在大厅提示框中选一个，或点「改用新账号」。');
      const hint = $('accountHint'); if (hint) hint.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    if (reclaimNeedPassword) {
      alert('同名账号已设密码，请先在大厅提示框中输入密码完成召回，或点「改用新账号」。');
      const pwdEl = $('ahPwd'); if (pwdEl) pwdEl.focus();
      return false;
    }
  }
  return true;
}

// ---------- 房间内「账号中心」增强 ----------
function renderProfileAccountBox() {
  if ($('profileAccountId')) $('profileAccountId').textContent = userProfile.id ? userProfile.id.slice(0, 8) + '…' : '(无)';
  const set = !!userProfile.hasPassword;
  if ($('passwordStatus')) {
    $('passwordStatus').textContent = set
      ? '已设密码：换设备召回此账号时需要输入密码。'
      : '未设密码时，任何人都可凭你的昵称召回此账号——建议起个不太重的昵称，或设个简单密码。';
    if ($('profilePasswordInput')) $('profilePasswordInput').placeholder = set ? '新密码（留空保存=清空密码）' : '未设置则留空';
  }
  // 已设密码时显示「原密码」输入行（修改/清空需 re-auth），未设密码时隐藏
  const oldRow = $('oldPasswordRow');
  if (oldRow) oldRow.classList.toggle('hidden', !set);
}

async function saveAccountPassword() {
  const pwd = $('profilePasswordInput') ? $('profilePasswordInput').value : '';
  // 已设密码时，修改/清空需先验证原密码（服务端 re-auth）
  const oldPwd = (userProfile.hasPassword && $('profileOldPasswordInput')) ? $('profileOldPasswordInput').value : '';
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userProfile.id)}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentUserId: userProfile.id, password: pwd, oldPassword: oldPwd }),
    });
    const data = await res.json();
    if (!res.ok || data.error) { alert(data.error || '密码保存失败'); return; }
    userProfile.hasPassword = !!data.hasPassword;
    persistProfile(userProfile);
    $('profilePasswordInput').value = '';
    const oldInput = $('profileOldPasswordInput'); if (oldInput) oldInput.value = '';
    renderProfileAccountBox();
  } catch (e) {
    alert('密码保存失败：' + (e && e.message ? e.message : e));
  }
}

async function loadMyRooms() {
  const list = $('myRoomsList');
  if (!list) return;
  list.innerHTML = '<li class="my-rooms-loading">加载中…</li>';
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userProfile.id)}/rooms`);
    const data = await res.json();
    const rooms = (data && data.rooms) || [];
    if (!rooms.length) { list.innerHTML = '<li class="my-rooms-empty">还没有去过房间。创建或加入一个房间后，会在这里出现。</li>'; return; }
    list.innerHTML = '';
    rooms.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'my-room-row' + (r.id === currentRoomId ? ' current' : '');
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'my-room-go';
      head.innerHTML = `<span class="mr-name"></span><span class="mr-id"></span><span class="mr-tag"></span>`;
      head.querySelector('.mr-name').textContent = r.name || '未命名观影房';
      head.querySelector('.mr-id').textContent = r.id;
      head.querySelector('.mr-tag').textContent = r.isHost ? '房主' : (r.id === currentRoomId ? '当前' : '成员');
      head.addEventListener('click', () => {
        $('profilePanel').classList.add('hidden');
        if (r.id === currentRoomId) { return; }
        // 走标准加入流程：填房间号并触发加入
        if ($('joinRoomId')) $('joinRoomId').value = r.id;
        if ($('btnJoin')) $('btnJoin').click();
      });
      li.appendChild(head);
      const meta = document.createElement('span');
      meta.className = 'mr-time';
      meta.textContent = r.lastSeenAt ? `上次在线：${new Date(r.lastSeenAt).toLocaleString()}` : '';
      li.appendChild(meta);
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = '<li class="my-rooms-empty">加载失败：' + (e && e.message ? e.message : e) + '</li>';
  }
}

function logoutLocalAccount() {
  if (!confirm('退出当前账号将清掉本机保存的昵称/头像/账号 ID。下次回来需要重新召回或新建账号。确认退出吗？')) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {}
  // 重新初始化本地身份
  userProfile = {
    id: createLocalUserId(),
    name: '',
    avatar: '',
    avatarColor: '',
  };
  myName = '';
  savedSettings.userId = userProfile.id;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSettings)); } catch (e) {}
  renderProfileUi();
  if ($('profilePanel')) $('profilePanel').classList.add('hidden');
  // 回大厅
  if (lobby && lobby.classList.contains('hidden')) {
    try { socket.disconnect(); } catch (e) {}
    location.reload();
  } else {
    if ($('userName')) $('userName').value = '';
    renderProfileUi();
  }
}

if ($('btnCopyAccountId')) $('btnCopyAccountId').addEventListener('click', () => {
  try { navigator.clipboard.writeText(userProfile.id).then(() => { $('btnCopyAccountId').textContent = '已复制'; setTimeout(() => { $('btnCopyAccountId').textContent = '复制'; }, 1200); }); } catch (e) {}
});
if ($('btnSavePassword')) $('btnSavePassword').addEventListener('click', saveAccountPassword);
if ($('btnRefreshMyRooms')) $('btnRefreshMyRooms').addEventListener('click', loadMyRooms);
if ($('btnLogoutAccount')) $('btnLogoutAccount').addEventListener('click', logoutLocalAccount);

// 打开账号中心时刷新账号信息与房间列表
$('btnProfile').addEventListener('click', () => {
  renderProfileUi();
  renderProfileAccountBox();
  loadMyRooms();
  $('profilePanel').classList.remove('hidden');
});
function setMobileRoomPanel(panel = 'source') {
  const next = panel === 'audio' ? 'audio' : 'source';
  const side = $('roomSide');
  if (!side) return;
  side.classList.toggle('mobile-panel-source', next === 'source');
  side.classList.toggle('mobile-panel-audio', next === 'audio');
  document.querySelectorAll('[data-mobile-room-panel]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mobileRoomPanel === next);
  });
  saveSetting('mobileRoomPanel', next);
}
document.querySelectorAll('[data-mobile-room-panel]').forEach((button) => {
  button.addEventListener('click', () => setMobileRoomPanel(button.dataset.mobileRoomPanel));
});
setMobileRoomPanel(savedSettings.mobileRoomPanel || 'source');
if (myName) $('userName').value = myName;
if (initialInviteRoom) {
  $('joinRoomId').value = initialInviteRoom;
  $('btnJoin').textContent = '加入邀请';
  $('inviteRoomLabel').textContent = initialInviteRoom;
  $('inviteNotice').classList.remove('hidden');
}

// ---------- 加密可用性兜底（正常情况 crypto-polyfill.js 已注入 crypto.subtle） ----------
// 若 polyfill 也未加载成功（crypto.subtle 仍缺失），给出提示而非直接崩溃。
if (!window.crypto || !crypto.subtle) {
  window.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#b91c1c;color:#fff;padding:10px 16px;font-size:14px;text-align:center;line-height:1.5';
    b.textContent = '当前浏览器无法启用加密聊天。请使用 HTTPS 地址访问，或刷新后重试。';
    document.body.appendChild(b);
  });
}

function buildEnvStatus() {
  const secure = !!window.isSecureContext;
  const cryptoOk = !!(window.crypto && crypto.subtle);
  const micOk = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const realtimeOk = socket.connected;
  const items = [
    { label: '安全访问', status: secure ? 'ok' : 'warn' },
    { label: '加密聊天', status: cryptoOk ? 'ok' : 'bad' },
    { label: '连麦权限', status: micOk ? 'ok' : 'warn' },
    { label: '实时同步', status: realtimeOk ? 'ok' : 'warn' },
  ];
  const notes = [];
  if (!secure) notes.push('当前不是 HTTPS，浏览器会限制麦克风和部分原生能力。公网服务器请通过 Nginx HTTPS 地址访问。');
  if (!cryptoOk) notes.push('加密能力不可用，聊天无法正常发送。请刷新页面或换用现代浏览器。');
  if (!realtimeOk) notes.push('正在连接实时同步服务，若长时间未恢复请检查 Nginx WebSocket 反代配置。');
  return { items, notes };
}

function renderEnvStatus() {
  const { items, notes } = buildEnvStatus();
  const hasBad = items.some((i) => i.status === 'bad');
  const hasWarn = items.some((i) => i.status === 'warn');
  const summary = hasBad ? '需要处理' : (hasWarn ? '部分受限' : '全部可用');

  $('envSummary').textContent = summary;
  const checks = $('envChecks');
  checks.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = `env-item env-${item.status}`;
    row.innerHTML = '<span class="env-dot"></span><span></span>';
    row.querySelector('span:last-child').textContent = item.label;
    checks.appendChild(row);
  });
  const note = document.createElement('div');
  note.className = 'env-note';
  note.textContent = notes[0] || '当前环境可以正常使用观影、聊天和连麦。';
  checks.appendChild(note);

  const chip = $('roomEnvChip');
  chip.className = `env-chip ${hasBad ? 'bad' : (hasWarn ? 'warn' : 'ok')}`;
  chip.textContent = summary;

  const roomNotice = $('roomEnvNotice');
  roomNotice.textContent = notes.join(' ');
  roomNotice.classList.toggle('hidden', notes.length === 0);
}

socket.on('connect', () => {
  myId = socket.id;
  renderEnvStatus();
  // 断线重连：若此前已在房间内（房间视图未隐藏），自动重新加入并恢复房间状态，
  // 避免停在"幽灵房间"（UI 显示房内但服务端无此会话）。
  if (currentRoomId && room && !room.classList.contains('hidden')) {
    socket.emit('room:join', { roomId: currentRoomId, userName: myName, userId: userProfile.id, avatar: userProfile.avatar }, (res) => {
      if (res && res.user) { persistProfile(res.user); renderProfileUi(); }
      // room:state 事件会重建成员列表与视频状态；失败（房间已不存在）时由回调提示
      if (res && res.error) { alert(res.error); }
    });
  }
});
socket.on('disconnect', () => { renderEnvStatus(); });
socket.on('connect_error', renderEnvStatus);
$('roomEnvChip').addEventListener('click', () => {
  const notice = $('roomEnvNotice');
  if (!notice.textContent) {
    notice.textContent = '当前环境可以正常使用观影、聊天和连麦。';
  }
  notice.classList.toggle('hidden');
});
renderEnvStatus();

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
$('btnCreate').addEventListener('click', createRoom);
$('btnJoin').addEventListener('click', () => joinRoom($('joinRoomId').value));
$('joinRoomId').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('joinRoomId').value); });
// 主昵称框失焦时自动触发召回 lookup：让"新账号"和"旧账号"在同一个框里完成
$('userName').addEventListener('blur', () => { maybeLookupReclaim(); });
$('userName').addEventListener('input', () => {
  // 输入变化即清掉旧的召回结果与 UI，重置门禁
  const name = currentNameInput();
  if (name !== lastLookupName) {
    resetReclaimState();
    clearAccountHint();
    setCreateJoinEnabled(true);
  }
});
$('userName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (initialInviteRoom) joinRoom(initialInviteRoom);
    else createRoom();
  }
});

async function prepareIdentity({ host = false } = {}) {
  myName = $('userName').value.trim() || `用户${Math.random().toString(36).slice(2, 6)}`;
  persistProfile({ name: myName });
  renderProfileUi();
  await syncUserProfile({ silent: true });
  try {
    myPubKey = await cqCrypto.initLocal();
    if (host) await cqCrypto.createGroupKey();
  } catch (e) {
    alert('当前浏览器无法启用加密聊天。请使用 HTTPS 地址访问，或刷新后重试。');
    throw e;
  }
}

async function createRoom() {
  // 用户从大厅主动创建：先确保召回闭环（已召回旧账号或确认新建）
  if (!(await ensureReclaimResolved())) return;
  await prepareIdentity({ host: true });
  socket.emit('room:create', { roomName: '', userName: myName, userId: userProfile.id, avatar: userProfile.avatar }, (res) => {
    if (res && res.user) {
      persistProfile(res.user);
      renderProfileUi();
    }
    if (res && res.roomId) {
      enterRoom(res.roomId, { created: true });
    }
  });
}

async function joinRoom(roomId, { auto = false } = {}) {
  const rid = normalizeRoomId(roomId);
  if (!rid) return alert('请输入房间号或打开邀请链接');
  // 自动入房（点开邀请链接、本机已有 UUID）跳过召回门禁，直接以本机身份进入；
  // 手动从大厅点击加入则与创建一样走召回闭环。
  if (!auto) {
    if (!(await ensureReclaimResolved())) return;
  }
  await prepareIdentity();
  socket.emit('room:join', { roomId: rid, userName: myName, userId: userProfile.id, avatar: userProfile.avatar }, (res) => {
    if (res && res.user) {
      persistProfile(res.user);
      renderProfileUi();
    }
    if (res && res.error) {
      if (!auto) alert(res.error);
      else {
        $('btnJoin').textContent = '重新加入';
        alert(`没有找到房间 ${rid}，请确认邀请链接是否仍然有效。`);
      }
      return;
    }
    enterRoom(rid);
  });
}

function enterRoom(roomId, { created = false } = {}) {
  currentRoomId = normalizeRoomId(roomId);
  lobby.classList.add('hidden');
  room.classList.remove('hidden');
  $('roomName').textContent = '观影房';
  $('roomIdLabel').textContent = currentRoomId;
  $('btnCopy').title = '复制邀请链接';
  if (history.replaceState) history.replaceState(null, '', `/r/${currentRoomId}`);
  socket.emit('crypto:pubkey', { pubKey: myPubKey });
  appendSystem(`🔒 聊天已端到端加密（ECDH + AES-GCM）`);
  appendSystem(`欢迎来到房间「${currentRoomId}」。邀请链接已准备好，可以直接发给朋友。`);
  if (created) appendSystem('房间已创建。先加载一个视频，其他人进来后会自动看到当前状态。');
  renderEnvStatus();
  updateRoomHome();
}

if (initialInviteRoom && myName) {
  setTimeout(() => joinRoom(initialInviteRoom, { auto: true }), 250);
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
// 房主变更后重新协商：新房主广播 rekey，本端收到后重新发出自己的公钥，由新房主用新群密钥包裹回传
socket.on('crypto:rekey', () => {
  if (myPubKey) socket.emit('crypto:pubkey', { pubKey: myPubKey });
});

// ===================================================================
//  房间状态 & 用户列表
// ===================================================================
socket.on('room:state', ({ room, users, video, recentMessages, maxSeq } = {}) => {
  $('roomName').textContent = room.name;
  roomUsers = users;
  roomUsers.forEach((u) => userAudioLevels.set(u.id, u.level || 0));
  // 清理已不在房间内的用户的电平缓存，避免 Map 无限膨胀
  const presentIds = new Set(roomUsers.map((u) => u.id));
  for (const k of userAudioLevels.keys()) if (!presentIds.has(k)) userAudioLevels.delete(k);
  isHost = !!users.find((u) => u.id === socket.id && u.isHost);
  myId = socket.id;
  renderUsers();

  videoState = { ...videoState, ...video };
  controllerId = video.lastControllerId || '';
  applyVideoState(video, true);
  const hasVideoNow = !!(video.bili || video.url || video.fileName || (video.kind === 'iframe' && video.iframeUrl) || (video.kind === 'hls' && video.url));
  if (hasVideoNow) $('watchLoadPanel').classList.add('hidden');
  updateWatchCta();
  updateRoomHome();

  // 聊天历史：服务端下发最近一批密文。能解则显示明文，不能解（端到端 / 密钥已轮换）显示占位。
  if (Array.isArray(recentMessages)) {
    const box = $('chatMessages');
    if (box) box.innerHTML = '';
    recentMessages.forEach((m) => insertChatMessage(m, { selfOverride: false, skipScroll: true, skipDanmaku: true }));
    if (box) box.scrollTop = box.scrollHeight;
  }
});
socket.on('room:users', (users) => {
  myId = socket.id;
  roomUsers = users;
  roomUsers.forEach((u) => userAudioLevels.set(u.id, u.level || userAudioLevels.get(u.id) || 0));
  const wasHost = isHost;
  isHost = !!users.find((u) => u.id === socket.id && u.isHost);
  renderUsers();
  updateRoomHome();
  // 房主变更后重新协商群密钥：本端刚被推选为房主、但手上还没有群密钥时，生成新群密钥并广播 rekey，
  // 让房间内其他人重新取回群密钥（避免"房主离开后新成员拿不到群密钥"）
  if (isHost && !wasHost && !cqCrypto.hasKey()) {
    cqCrypto.createGroupKey().then(() => socket.emit('crypto:rekey')).catch(() => {});
  }
});
socket.on('user:join', ({ user }) => {
  roomUsers.push(user);
  userAudioLevels.set(user.id, user.level || 0);
  renderUsers();
  if (micOn && myId < user.id) createPeer(user.id);
  appendSystem(`「${user.name}」进入了房间`);
});
socket.on('user:leave', ({ id }) => {
  const u = roomUsers.find((x) => x.id === id);
  roomUsers = roomUsers.filter((x) => x.id !== id);
  userAudioLevels.delete(id); // 释放离场用户的电平缓存，避免 Map 无限膨胀
  renderUsers();
  closePeer(id);
  if (u) appendSystem(`「${u.name}」离开了房间`);
});

function audioPrefKey(id) {
  const user = roomUsers.find((u) => u.id === id);
  return (user && user.userId) || id;
}

function getRemoteAudioPref(id) {
  return remoteAudioPrefs.get(audioPrefKey(id)) || { volume: 1, muted: false };
}

function saveRemoteAudioPref(id, pref) {
  const key = audioPrefKey(id);
  remoteAudioPrefs.set(key, { ...getRemoteAudioPref(id), ...pref });
  saveSetting('remoteAudioPrefs', Object.fromEntries(remoteAudioPrefs.entries()));
  applyRemoteAudioSettings(id);
}

function applyRemoteAudioSettings(id) {
  const audio = remoteAudios.get(id);
  if (!audio) return;
  const pref = getRemoteAudioPref(id);
  audio.volume = Math.max(0, Math.min(1, Number(pref.volume)));
  audio.muted = !!pref.muted;
}

function setMemberLevel(id, level) {
  const next = Math.max(0, Math.min(1, Number(level) || 0));
  userAudioLevels.set(id, next);
  const bar = document.querySelector(`[data-member-level="${id}"]`);
  if (bar) bar.style.transform = `scaleX(${Math.max(.04, next)})`;
  const row = document.querySelector(`[data-member-id="${id}"]`);
  if (row) row.classList.toggle('speaking', next > .12);
  if (id === myId) updateMicMeter(next);
}

function renderMemberAvatar(el, u) {
  // 仅接受经服务端校验过的 data:image/... 头像，防止任意字符串注入到 CSS url() 造成 XSS
  const safeAvatar = typeof u.avatar === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(u.avatar) ? u.avatar : '';
  if (safeAvatar) {
    el.textContent = '';
    el.style.background = `center / cover no-repeat url("${safeAvatar}")`;
    return;
  }
  el.textContent = avatarText(u.name);
  const c1 = u.avatarColor || avatarColor(u.userId || u.id || u.name);
  el.style.background = `linear-gradient(135deg, ${c1}, ${avatarColor((u.userId || u.name) + '2')})`;
}

// 成员列表（仅成员抽屉使用）
function renderUsers() {
  const ul = $('userListWatch');
  $('userCount').textContent = roomUsers.length;
  $('heroUserCount').textContent = roomUsers.length;
  const activeMicCount = roomUsers.filter((u) => u.audio).length;
  $('heroMicState').textContent = activeMicCount ? `${activeMicCount} 人开麦` : '未开启';
  if (!ul) return;
  ul.innerHTML = '';
  roomUsers.forEach((u) => {
    const li = document.createElement('li');
    li.dataset.memberId = u.id;
    li.className = u.audio ? 'member-speaking-row mic-open' : 'member-speaking-row';

    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    renderMemberAvatar(avatar, u);
    li.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'member-body';

    const meta = document.createElement('div');
    meta.className = 'member-meta';
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = u.name;
    meta.appendChild(name);
    if (u.id === myId) {
      const me = document.createElement('span');
      me.className = 'member-me';
      me.textContent = '（我）';
      meta.appendChild(me);
    }
    if (u.isHost) {
      const t = document.createElement('span');
      t.className = 'tag-host';
      t.textContent = '房主';
      meta.appendChild(t);
    }
    body.appendChild(meta);

    const audioLine = document.createElement('div');
    audioLine.className = 'member-audio-line';
    const dot = document.createElement('span');
    dot.className = u.audio ? 'dot-online' : 'dot-offline';
    audioLine.appendChild(dot);
    const status = document.createElement('span');
    status.className = 'member-audio-status';
    status.textContent = u.audio ? '麦克风已开' : '麦克风关闭';
    audioLine.appendChild(status);
    const meter = document.createElement('span');
    meter.className = 'member-level';
    const fill = document.createElement('span');
    fill.dataset.memberLevel = u.id;
    fill.style.transform = `scaleX(${Math.max(.04, userAudioLevels.get(u.id) || 0)})`;
    meter.appendChild(fill);
    audioLine.appendChild(meter);
    body.appendChild(audioLine);

    if (u.id !== myId) {
      const pref = getRemoteAudioPref(u.id);
      const controls = document.createElement('div');
      controls.className = 'member-audio-controls';
      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '1';
      volume.step = '0.05';
      volume.value = String(pref.volume ?? 1);
      volume.title = '调整音量';
      volume.addEventListener('input', () => saveRemoteAudioPref(u.id, { volume: Number(volume.value) }));
      controls.appendChild(volume);
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'member-mute';
      mute.textContent = pref.muted ? '取消静音' : '静音';
      mute.addEventListener('click', () => {
        const nextMuted = !getRemoteAudioPref(u.id).muted;
        saveRemoteAudioPref(u.id, { muted: nextMuted });
        mute.textContent = nextMuted ? '取消静音' : '静音';
      });
      controls.appendChild(mute);
      body.appendChild(controls);
    }

    li.appendChild(body);
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
  if (!currentRoomId) return; // 未进入房间不发送
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

socket.on('chat:message', async (m) => insertChatMessage(m));

// 通用渲染：实时消息 socket.on('chat:message') 与历史消息 recentMessages 都走这里。
// m = { user, ts, cipher, seq?, self? }
// opts:
//   - selfOverride: 强制左右对齐（历史消息不知道是发送者本人还是别人，按需要传入）
//   - skipScroll:   连续插入多条时不每次都滚到底（最后再统一滚一次）
//   - skipDanmaku:  历史消息不当作实时弹幕飘出
async function insertChatMessage(m, opts = {}) {
  const box = $('chatMessages');
  if (!box) return;
  const self = (typeof opts.selfOverride === 'boolean') ? opts.selfOverride : !!m.self;
  const el = document.createElement('div');
  el.className = 'msg' + (self ? ' self' : '');
  const t = new Date(m.ts);

  if (!self) {
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.style.background = `linear-gradient(135deg, ${avatarColor(m.user || '')}, ${avatarColor(m.user + '_')})`;
    av.textContent = avatarText(m.user);
    el.appendChild(av);
  }

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<span class="who"></span><span class="time">${pad(t.getHours())}:${pad(t.getMinutes())}</span>`;
  head.querySelector('.who').textContent = m.user || '匿名';

  const body = document.createElement('div');
  body.className = 'msg-body';
  const loading = document.createElement('span');
  loading.className = 'txt';
  loading.textContent = '🔓 解密中…';
  body.appendChild(loading);
  el.appendChild(head);
  el.appendChild(body);
  box.appendChild(el);
  if (!opts.skipScroll) box.scrollTop = box.scrollHeight;

  let plain;
  try { plain = await cqCrypto.decrypt(m.cipher); }
  catch (e) {
    loading.textContent = (opts.skipDanmaku ? '🔒 历史消息（无法解密）' : '⚠️ 解密失败');
    if (!opts.skipScroll) box.scrollTop = box.scrollHeight;
    return;
  }
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
  if (!opts.skipScroll) box.scrollTop = box.scrollHeight;

  if (!opts.skipDanmaku && watchModeOn) {
    const dm = data.image && !data.text ? '[图片]' : (data.text || (data.image ? '[图片]' : ''));
    if (dm) spawnDanmaku(dm);
  }
}

function openLightbox(src) {
  const overlay = $('lightboxOverlay');
  const img = $('lightboxImg');
  img.src = src;
  overlay.classList.remove('hidden');
  overlay.onclick = () => overlay.classList.add('hidden');
}

function appendSystem(text) {
  const box = $('chatMessages');
  if (!box) return; // 大厅阶段聊天框可能尚未渲染，避免空引用
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

function sourceLabel() {
  if (lastVideoTitle) return lastVideoTitle;
  if (videoState.fileName) return videoState.fileName;
  if (videoState.bili) return 'B 站视频';
  if (videoState.url) return '视频直链';
  return '';
}

function hasVideoSource() {
  return !!(videoState.bili || videoState.url || videoState.fileName || videoState.kind === 'iframe' || videoState.kind === 'hls');
}

function updateRoomHome() {
  const has = hasVideoSource();
  const label = sourceLabel();
  $('roomHeroTitle').textContent = has ? '片源已就绪' : '准备片源，邀请朋友入座';
  $('roomHeroMeta').textContent = has ? label : '聊天和邀请链接已经可用。';
  $('heroSourceState').textContent = has ? label : '未设置';
  const activeMicCount = roomUsers.filter((u) => u.audio).length;
  $('heroMicState').textContent = activeMicCount ? `${activeMicCount} 人开麦` : (micOn ? '已开启' : '未开启');
  $('heroUserCount').textContent = roomUsers.length;
  $('roomOpenWatchText').textContent = has ? '进入观影' : '选择片源';
  $('roomSourceWatch').textContent = has ? '观影页' : '待片源';
  $('roomSourceHint').textContent = has ? `当前片源：${label}` : '支持 B 站链接、视频直链和本地同名文件。';
}

function focusRoomSource() {
  const panel = $('roomSourcePanel');
  panel.classList.add('source-pulse');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => panel.classList.remove('source-pulse'), 900);
  setTimeout(() => $('roomBiliUrl').focus(), 120);
}

function openWatchOrSource() {
  if (hasVideoSource()) enterWatch();
  else focusRoomSource();
}

function enterWatch({ auto = false } = {}) {
  watchModeOn = true;
  watchMode.classList.remove('hidden');
  const hasVideo = !!(videoState.bili || videoState.url || videoState.fileName);
  if (hasVideo) watchEmpty.classList.add('hidden');
  else watchEmpty.classList.remove('hidden');
  $('watchTitle').textContent = lastVideoTitle || (videoState.fileName ? videoState.fileName : '共享视频');
  if (auto && !hasVideo) $('watchLoadPanel').classList.remove('hidden');
  syncWatchUI();
  // 进入即播放（进入观影是用户主动点击，允许自动播放带声音）
  if (!auto && hasVideo) video.play().catch(() => {});
}
function exitWatch() {
  watchModeOn = false;
  watchMode.classList.add('hidden');
  try { video.pause(); videoAudio.pause(); } catch (e) {} // 本地暂停，避免后台幽灵声音（不影响他人）
}
function syncWatchUI() { updatePlayUI(); }

$('btnWatch').addEventListener('click', openWatchOrSource);
$('roomOpenWatch').addEventListener('click', openWatchOrSource);
$('roomSourceWatch').addEventListener('click', openWatchOrSource);
$('roomCopyInvite').addEventListener('click', () => copyInviteLink());
$('watchCtaBtn').addEventListener('click', enterWatch);
$('watchExit').addEventListener('click', exitWatch);
$('emptyLoadBtn').addEventListener('click', () => $('watchLoadPanel').classList.remove('hidden'));

// 加载面板
$('watchLoad').addEventListener('click', () => $('watchLoadPanel').classList.toggle('hidden'));
$('watchLoadClose').addEventListener('click', () => $('watchLoadPanel').classList.add('hidden'));
$('watchInvite').addEventListener('click', () => copyInviteLink());

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
  saveSetting('volume', v);
});
$('wcFull').addEventListener('click', () => {
  if (!document.fullscreenElement) { if (watchStage.requestFullscreen) watchStage.requestFullscreen(); }
  else { if (document.exitFullscreen) document.exitFullscreen(); }
});
$('wcDanmaku').addEventListener('click', () => {
  danmakuOn = !danmakuOn;
  $('wcDanmaku').classList.toggle('active', danmakuOn);
  saveSetting('danmakuOn', danmakuOn);
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
let videoFrame = null;
try { videoFrame = $('videoFrame'); } catch (e) { videoFrame = null; }
const savedVolume = Number(savedSettings.volume);
if (Number.isFinite(savedVolume)) {
  const v = Math.min(1, Math.max(0, savedVolume));
  $('wcVolume').value = v;
  video.volume = v;
  videoAudio.volume = v;
}
$('wcDanmaku').classList.toggle('active', danmakuOn);

// 把任意用户输入的视频地址分类为：direct / hls / bili / iframe（YouTube / 腾讯 / 优酷 / 西瓜）
function classifyVideoUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return { kind: '', url: '' };
  const testUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  // 1) 显式 HLS / m3u8
  if (/\.m3u8(\?|#|$)/i.test(testUrl)) return { kind: 'hls', url: testUrl };

  // 2) B 站视频：含 BV 号且 host 是 bilibili/b23
  {
    const bv = (url.match(/BV[0-9A-Za-z]+/) || [])[0];
    if (bv && /bilibili\.com|b23\.tv|bilivideo/i.test(testUrl)) return { kind: 'bili', bvid: bv };
  }

  // 3) YouTube
  {
    let ytId = '';
    try {
      const u = new URL(testUrl);
      const host = u.hostname.replace(/^www\.|^m\./i, '');
      if (host === 'youtu.be') ytId = u.pathname.slice(1).split('/')[0];
      else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') ytId = u.searchParams.get('v') || '';
        else if (u.pathname.startsWith('/embed/')) ytId = u.pathname.split('/')[2] || '';
        else if (u.pathname.startsWith('/shorts/')) ytId = u.pathname.split('/')[2] || '';
      }
    } catch (e) {}
    if (ytId) {
      return {
        kind: 'iframe', provider: 'youtube', url,
        embedUrl: `https://www.youtube.com/embed/${ytId}?autoplay=0&modestbranding=1&rel=0&playsinline=1`,
        title: `YouTube：${ytId}`,
      };
    }
  }

  // 4) 腾讯视频
  {
    let vid = '';
    try {
      const u = new URL(testUrl);
      const host = u.hostname.replace(/^www\.|^m\./i, '');
      if (host === 'v.qq.com') {
        const m = u.pathname.match(/\/(?:x\/)?(?:cover|page)\/[\w.-]+\/(\w+)\.html/i)
          || u.pathname.match(/\/(?:x\/)?(?:cover|page)\/(\w+)\.html/i);
        if (m) vid = m[1];
        if (!vid) vid = u.searchParams.get('vid') || '';
      }
    } catch (e) {}
    if (vid) {
      return {
        kind: 'iframe', provider: 'qq', url,
        embedUrl: `https://v.qq.com/txp/iframe/player.html?vid=${vid}&autoplay=0`,
        title: `腾讯视频：${vid}`,
      };
    }
  }

  // 5) 优酷
  {
    let yid = '';
    try {
      const u = new URL(testUrl);
      const host = u.hostname.replace(/^www\.|^m\./i, '');
      if (host === 'v.youku.com' || host === 'player.youku.com') {
        const m = u.pathname.match(/(?:v_show\/)?(id_[\w=]+)/i)
          || u.pathname.match(/player\.php\/sid\/([\w=]+)/i);
        if (m) yid = m[1];
      }
    } catch (e) {}
    if (yid) {
      return {
        kind: 'iframe', provider: 'youku', url,
        embedUrl: `https://player.youku.com/embed/${yid}?autoplay=0`,
        title: `优酷：${yid}`,
      };
    }
  }

  // 6) 西瓜视频
  {
    let xid = '';
    try {
      const u = new URL(testUrl);
      if (/ixigua\.com$/i.test(u.hostname)) {
        const m = u.pathname.match(/\/(\d+)/);
        if (m) xid = m[1];
      }
    } catch (e) {}
    if (xid) {
      return {
        kind: 'iframe', provider: 'ixigua', url,
        embedUrl: `https://www.ixigua.com/iframe/${xid}?autoplay=0`,
        title: `西瓜视频：${xid}`,
      };
    }
  }

  // 7) 默认：交给 <video> 直链尝试解码
  return { kind: 'direct', url: testUrl };
}

function showIframeFrame(srcUrl) {
  if (videoFrame) {
    videoFrame.src = srcUrl;
    videoFrame.style.display = 'block';
  }
  // 隐藏原生 video，避免占用舞台；同时暂停主视频与音频轨，避免切换 iframe 后原视频在后台继续播放
  const va = $('videoAudio');
  if (va && va.src) { try { va.pause(); va.removeAttribute('src'); va.load(); } catch (e) {} }
  try { video.pause(); } catch (e) {}
  video.classList.add('iframe-active-host'); // 与原生 video 同住容器；样式钩子在 style.css 可选
  if (videoFrame) videoFrame.classList.remove('hidden');
}

function hideIframeFrame() {
  if (videoFrame && videoFrame.src && videoFrame.src !== 'about:blank') {
    try { videoFrame.src = 'about:blank'; } catch (e) {}
  }
  if (videoFrame) { videoFrame.style.display = 'none'; videoFrame.classList.add('hidden'); }
  video.classList.remove('iframe-active-host');
}

function setIframeSource(info) {
  if (!videoFrame) { alert('当前页面未能初始化嵌入视频框架，请刷新后再试。'); return; }
  stopDash({ keepLocal: false });
  lastVideoTitle = info.title || (info.provider ? `${info.provider} 嵌入视频` : '嵌入视频');
  showIframeFrame(info.embedUrl);
  $('videoHint').textContent = `嵌入视频：${lastVideoTitle}（播放控制不同步，各自在自己的播放器里看，可一起聊天）`;
  $('watchTitle').textContent = lastVideoTitle;
  socket.emit('video:set', { kind: 'iframe', iframeUrl: info.embedUrl, label: lastVideoTitle, iframeProvider: info.provider || '', url: '', bili: '', fileName: '' });
  $('watchLoadPanel').classList.add('hidden');
  watchEmpty.classList.add('hidden');
  updateWatchCta();
  updateRoomHome();
}

function setHlsSource(url) {
  stopDash();
  hideIframeFrame();
  // 不引入第三方库：Safari 原生支持 m3u8；其它浏览器尝试用 <video src>，
  // 浏览器会自己决定能不能解；不支持的视频会触发 error。
  socket.emit('video:set', { kind: 'hls', url, bili: '', fileName: '', iframeUrl: '' });
  $('watchLoadPanel').classList.add('hidden');
  if (video.src !== url) video.src = url;
  $('videoHint').textContent = '已加载 HLS 直播流（.m3u8）。Safari 原生支持，其它浏览器可能需要更新到最新版 Chrome/Edge。';
  watchEmpty.classList.add('hidden');
  updateWatchCta();
  updateRoomHome();
}

function setVideoUrlSource(url) {
  url = String(url || '').trim();
  if (!url) return;
  const info = classifyVideoUrl(url);
  if (info.kind === 'bili' && info.bvid) { setBiliSource(url); return; }
  if (info.kind === 'iframe' && info.embedUrl) { setIframeSource(info); return; }
  if (info.kind === 'hls') { setHlsSource(info.url); return; }
  // 默认 direct：交给 <video> 直链解码
  stopDash();
  hideIframeFrame();
  socket.emit('video:set', { kind: 'direct', url: info.url, fileName: '', bili: '', iframeUrl: '' });
  $('watchLoadPanel').classList.add('hidden');
  if ($('roomVideoUrl')) $('roomVideoUrl').value = info.url;
  lastVideoTitle = info.url;
}

function setLocalFileSource(file) {
  if (!file) return;
  stopDash();
  hideIframeFrame();
  useLocalFile(file);
  socket.emit('video:set', { kind: 'file', url: '', fileName: file.name, bili: '', iframeUrl: '' });
  $('watchLoadPanel').classList.add('hidden');
}

function setBiliSource(url) {
  url = String(url || '').trim();
  if (!url) return;
  const m = url.match(/BV[0-9A-Za-z]+/);
  if (!m) return alert('请粘贴包含 BV 号的 B 站视频链接');
  hideIframeFrame();
  $('biliUrl').value = url;
  $('roomBiliUrl').value = url;
  socket.emit('video:set', { kind: 'bili', url: '', fileName: '', bili: m[0], iframeUrl: '' });
  $('watchLoadPanel').classList.add('hidden');
}

$('btnLoadUrl').addEventListener('click', () => setVideoUrlSource($('videoUrl').value));
$('roomLoadUrl').addEventListener('click', () => setVideoUrlSource($('roomVideoUrl').value));
$('videoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') setVideoUrlSource($('videoUrl').value); });
$('roomVideoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') setVideoUrlSource($('roomVideoUrl').value); });

$('videoFile').addEventListener('change', (e) => setLocalFileSource(e.target.files[0]));
$('roomVideoFile').addEventListener('change', (e) => setLocalFileSource(e.target.files[0]));

$('btnLoadBili').addEventListener('click', () => setBiliSource($('biliUrl').value));
$('roomLoadBili').addEventListener('click', () => setBiliSource($('roomBiliUrl').value));
$('biliUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') setBiliSource($('biliUrl').value); });
$('roomBiliUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') setBiliSource($('roomBiliUrl').value); });

$('biliQuality').addEventListener('change', (e) => {
  currentBiliQn = e.target.value;
  saveSetting('biliQn', currentBiliQn);
  if (videoState.bili) loadBili(videoState.bili, video.currentTime);
});

socket.on('video:state', (v) => {
  videoState = { ...videoState, ...v };
  controllerId = v.lastControllerId || '';
  const hasAny = !!(v.url || v.fileName || v.bili || (v.kind === 'iframe' && v.iframeUrl) || (v.kind === 'hls' && v.url));
  if (hasAny) watchEmpty.classList.add('hidden');
  else watchEmpty.classList.remove('hidden');
  $('watchLoadPanel').classList.add('hidden');
  updateWatchCta();
  applyVideoState(v, false);
  updateRoomHome();
});

function applyVideoState(v, isInitial) {
  if (v.kind === 'iframe' && v.iframeUrl) {
    stopDash({ keepLocal: false });
    showIframeFrame(v.iframeUrl);
    lastVideoTitle = v.label || (v.iframeProvider ? `${v.iframeProvider} 嵌入视频` : '嵌入视频');
    $('watchTitle').textContent = lastVideoTitle;
    $('videoHint').textContent = `嵌入视频：${lastVideoTitle}（iframe 模式下播放不参与房间同步，可各自在自己窗口里看 + 聊天）`;
    watchEmpty.classList.add('hidden');
    return;
  }
  if (v.kind === 'hls' && v.url) {
    stopDash();
    hideIframeFrame();
    watchEmpty.classList.add('hidden');
    if (video.src !== v.url) video.src = v.url;
    $('videoHint').textContent = '已加载 HLS 直播流（.m3u8）。Safari 原生支持，其它浏览器需最新版 Chrome/Edge。';
    if (typeof v.currentTime === 'number' && Math.abs(video.currentTime - v.currentTime) > 0.5) video.currentTime = v.currentTime;
    if (v.action === 'load') video.pause();
    return;
  }
  if (v.bili || v.kind === 'bili') {
    const bvid = v.bili || ((v.url || '').match(/BV[0-9A-Za-z]+/) || [])[0] || '';
    if (bvid) loadBili(bvid, parseStartAt(v._rawUrl));
    return;
  }
  if (v.kind === 'file' || v.fileName) {
    stopDash({ keepLocal: true });
    hideIframeFrame();
    watchEmpty.classList.add('hidden');
    if (localFileName === v.fileName && localFileUrl) {
      $('videoHint').textContent = `本机已选择「${v.fileName}」，播放进度会和房间同步。`;
    } else {
      try { video.removeAttribute('src'); video.load(); } catch (e) {}
      $('watchLoadPanel').classList.remove('hidden');
      if (isInitial) $('videoHint').textContent = `房间正在使用本地文件「${v.fileName}」。请在本机选择同名文件后再播放。`;
      else $('videoHint').textContent = `有人切换到本地文件「${v.fileName}」。请在本机选择同名文件后再播放。`;
    }
    if (typeof v.currentTime === 'number' && Math.abs(video.currentTime - v.currentTime) > 0.5) video.currentTime = v.currentTime;
    if (v.action === 'load') video.pause();
    return;
  }
  if (v.url || v.kind === 'direct') {
    stopDash();
    hideIframeFrame();
    watchEmpty.classList.add('hidden');
    if (video.src !== v.url) video.src = v.url;
    $('videoHint').textContent = '已加载视频链接，点击播放即可（所有人进度同步）。';
    if (typeof v.currentTime === 'number' && Math.abs(video.currentTime - v.currentTime) > 0.5) video.currentTime = v.currentTime;
    if (v.action === 'load') video.pause();
    return;
  }
  // 没有 source 的情况
  hideIframeFrame();
}

function parseStartAt(rawUrl) {
  if (!rawUrl) return 0;
  const m = rawUrl.match(/[?&]t=([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function clearLocalFile() {
  if (localFileUrl) {
    try { URL.revokeObjectURL(localFileUrl); } catch (e) {}
  }
  localFileUrl = '';
  localFileName = '';
}

function useLocalFile(file) {
  clearLocalFile();
  localFileName = file.name;
  localFileUrl = URL.createObjectURL(file);
  video.src = localFileUrl;
  $('videoHint').textContent = `本机已选择「${file.name}」，可以开始播放；其他人也需要选择同名文件。`;
  watchEmpty.classList.add('hidden');
}

function stopDash({ keepLocal = false } = {}) {
  stopBiliSync();
  try { videoAudio.removeAttribute('src'); videoAudio.load(); } catch (e) {}
  try { hideIframeFrame(); } catch (e) {}
  if (!keepLocal) clearLocalFile();
}

async function loadBili(bvid, startAt = 0, { forceRefresh = false } = {}) {
  stopDash();
  $('videoHint').textContent = `正在解析视频信息（${currentBiliQn}）…`;
  let data;
  try {
    const forceParam = forceRefresh ? '&force=1' : '';
    const res = await fetch(`/api/resolve-bili?url=${encodeURIComponent(bvid)}&qn=${encodeURIComponent(currentBiliQn)}${forceParam}`);
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (e) {
    $('videoHint').textContent = '解析失败。可能是会员/地区限制、B 站接口拦截，或服务器暂时无法访问 B 站。' + (e.message ? `（${e.message}）` : '');
    return;
  }
  $('videoHint').textContent = '已拿到清晰度，正在加载视频流…';

  const sel = $('biliQuality');
  sel.hidden = false; sel.innerHTML = '';
  (data.qualities || []).forEach((q) => {
    const opt = document.createElement('option');
    opt.value = q.label; opt.textContent = q.label;
    if (q.label === (data.quality || currentBiliQn)) opt.selected = true;
    sel.appendChild(opt);
  });
  currentBiliQn = data.quality || currentBiliQn;
  saveSetting('biliQn', currentBiliQn);
  lastVideoTitle = data.title || '';

  watchEmpty.classList.add('hidden');
  stopBiliSync();

  // 视频轨 / 音频轨：经服务端代理绕过 B 站防盗链
  video.src = '/api/bili-media?kind=video&url=' + encodeURIComponent(data.video.baseUrl);
  if (data.audio && data.audio.baseUrl) {
    videoAudio.src = '/api/bili-media?kind=audio&url=' + encodeURIComponent(data.audio.baseUrl);
    startBiliSync();
  }

  // 拉流失败自动重试一次：B 站流地址有时效或被风控/防盗链拦截。
  // 已是强制刷新重试则不再叠加，避免无限循环。用 onerror 单次赋值覆盖，避免多次切清晰度时堆叠监听器。
  if (!forceRefresh) {
    video.onerror = () => {
      if (!video.error) return;
      $('videoHint').textContent = '视频拉流失败，正在自动重新解析 B 站地址…';
      const resumeAt = video.currentTime || startAt;
      setTimeout(() => loadBili(bvid, resumeAt, { forceRefresh: true }), 400);
    };
  } else {
    video.onerror = null;
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
  updateRoomHome();
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
$('btnRefreshMics').addEventListener('click', () => refreshMicDevices({ requestLabel: true }));
$('btnTestMic').addEventListener('click', toggleMicTest);
$('micDeviceSelect').addEventListener('change', async (e) => {
  selectedMicDeviceId = e.target.value;
  saveSetting('micDeviceId', selectedMicDeviceId);
  if (micOn) await switchMicDevice();
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => refreshMicDevices({ requestLabel: false }));
}
refreshMicDevices({ requestLabel: false });

function micConstraints() {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (selectedMicDeviceId) audio.deviceId = { exact: selectedMicDeviceId };
  return { audio };
}

async function refreshMicDevices({ requestLabel = false } = {}) {
  const select = $('micDeviceSelect');
  if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  if (requestLabel && navigator.mediaDevices.getUserMedia) {
    let temp = null;
    try { temp = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) {}
    if (temp) temp.getTracks().forEach((t) => t.stop());
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  select.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '系统默认';
  select.appendChild(defaultOpt);
  devices.forEach((device, index) => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || `输入设备 ${index + 1}`;
    select.appendChild(opt);
  });
  if (selectedMicDeviceId && devices.some((d) => d.deviceId === selectedMicDeviceId)) {
    select.value = selectedMicDeviceId;
  } else {
    selectedMicDeviceId = '';
    select.value = '';
    saveSetting('micDeviceId', '');
  }
}

async function getSelectedMicStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('麦克风需要 HTTPS 或 localhost 安全上下文');
  }
  return navigator.mediaDevices.getUserMedia(micConstraints());
}

function ensureAudioContext() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function attachLocalMeter(stream) {
  stopLocalMeter({ keepContext: true });
  if (!stream) return;
  const ctx = ensureAudioContext();
  localAudioSource = ctx.createMediaStreamSource(stream);
  localAnalyser = ctx.createAnalyser();
  localAnalyser.fftSize = 512;
  localAudioSource.connect(localAnalyser);
  startLocalLevelLoop();
}

function stopLocalMeter({ keepContext = false } = {}) {
  if (localLevelRaf) cancelAnimationFrame(localLevelRaf);
  localLevelRaf = 0;
  if (localAudioSource) {
    try { localAudioSource.disconnect(); } catch (e) {}
    localAudioSource = null;
  }
  localAnalyser = null;
  updateMicMeter(0);
  if (!keepContext && audioContext && !micOn && !micTesting) {
    try { audioContext.close(); } catch (e) {}
    audioContext = null;
  }
}

function updateMicMeter(level) {
  const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
  if ($('micLevelBar')) $('micLevelBar').style.transform = `scaleX(${Math.max(.03, pct / 100)})`;
  if ($('micLevelBadge')) $('micLevelBadge').textContent = `${pct}%`;
  if ($('micStatusText')) $('micStatusText').textContent = micOn ? '麦克风已开' : (micTesting ? '试音中' : '未开麦');
}

function startLocalLevelLoop() {
  if (!localAnalyser || localLevelRaf) return;
  const data = new Uint8Array(localAnalyser.fftSize);
  const tick = () => {
    if (!localAnalyser) { localLevelRaf = 0; return; }
    localAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const centered = (data[i] - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 5);
    setMemberLevel(myId || socket.id, level);
    if (micOn && Date.now() - lastSpeakingEmit > 160) {
      lastSpeakingEmit = Date.now();
      socket.emit('user:speaking', { level });
    }
    localLevelRaf = requestAnimationFrame(tick);
  };
  localLevelRaf = requestAnimationFrame(tick);
}

function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

async function toggleMicTest() {
  if (micTesting) {
    // 停止试音
    micTesting = false;
    if (micTestStream) { stopStream(micTestStream); micTestStream = null; }
    $('btnTestMic').textContent = '试音';
    if (micOn && localStream) attachLocalMeter(localStream);
    else stopLocalMeter();
    return;
  }
  // 开启试音
  try {
    if (micOn && localStream) {
      attachLocalMeter(localStream);
    } else {
      micTestStream = await getSelectedMicStream();
      attachLocalMeter(micTestStream);
    }
    micTesting = true;
    $('btnTestMic').textContent = '停止试音';
    await refreshMicDevices({ requestLabel: false });
  } catch (err) {
    micTesting = false;
    if (micTestStream) { stopStream(micTestStream); micTestStream = null; }
    alert('无法打开这个输入设备：' + (err && err.message ? err.message : err));
  }
}

function updateMicButtons() {
  if (micOn) {
    $('btnMic').innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg><span>闭麦</span>';
    $('watchMic').classList.add('active');
  } else {
    $('btnMic').innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg><span>开麦</span>';
    $('watchMic').classList.remove('active');
  }
  updateMicMeter(userAudioLevels.get(myId || socket.id) || 0);
}

async function switchMicDevice() {
  try {
    const nextStream = await getSelectedMicStream();
    const nextTrack = nextStream.getAudioTracks()[0];
    peers.forEach((entry) => {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender && nextTrack) sender.replaceTrack(nextTrack).catch(() => {});
    });
    stopStream(localStream);
    localStream = nextStream;
    attachLocalMeter(localStream);
    socket.emit('user:audio', { enabled: true });
    await refreshMicDevices({ requestLabel: false });
  } catch (err) {
    alert('切换麦克风失败：' + (err && err.message ? err.message : err));
    refreshMicDevices({ requestLabel: false });
  }
}

async function toggleMic() {
  if (!micOn) {
    // 连麦(getUserMedia)是浏览器硬限制：仅 https:// 或 http://localhost 可用；http://IP 明文环境会被直接拒绝
    try { localStream = await getSelectedMicStream(); }
    catch (err) {
      if (err && err.name === 'NotAllowedError') alert('麦克风权限被拒绝，请在浏览器地址栏允许麦克风权限后重试。');
      else alert('无法获取麦克风：' + (err && err.message ? err.message : err));
      return;
    }
    if (micTestStream) {
      stopStream(micTestStream);
      micTestStream = null;
    }
    micTesting = false;
    $('btnTestMic').textContent = '试音';
    micOn = true;
    attachLocalMeter(localStream);
    updateRoomHome();
    updateMicButtons();
    socket.emit('user:audio', { enabled: true });
    await refreshMicDevices({ requestLabel: false });
    roomUsers.forEach((u) => {
      if (u.id === myId) return;
      const entry = peers.get(u.id);
      if (entry) entry.pc.addTrack(localStream.getTracks()[0], localStream);
      else createPeer(u.id);
    });
  } else {
    micOn = false;
    updateRoomHome();
    updateMicButtons();
    socket.emit('user:audio', { enabled: false });
    socket.emit('user:speaking', { level: 0 });
    [...peers.keys()].forEach((id) => closePeer(id));
    stopStream(localStream);
    localStream = null;
    stopLocalMeter();
  }
}

function createPeer(targetId) {
  if (peers.has(targetId)) return peers.get(targetId);
  const pc = new RTCPeerConnection(rtcConfig);
  const entry = { pc, polite: myId < targetId, makingOffer: false, ignoreOffer: false, remoteSet: false, pendingCandidates: [] };
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
    entry.remoteSet = true;
    // 在 setRemoteDescription 完成前到达的 ICE candidate 曾静默丢弃，这里补发缓冲队列
    if (entry.pendingCandidates.length) {
      for (const c of entry.pendingCandidates) { try { await pc.addIceCandidate(c); } catch (e) { console.error(e); } }
      entry.pendingCandidates = [];
    }
    if (desc.type === 'offer') { await pc.setLocalDescription(); socket.emit('rtc:signal', { to: from, data: pc.localDescription }); }
  } catch (err) { console.error(err); }
}

socket.on('rtc:signal', async ({ from, data }) => {
  if (data.candidate) {
    const entry = peers.get(from);
    if (entry) {
      if (entry.remoteSet) { try { await entry.pc.addIceCandidate(data.candidate); } catch (e) { console.error(e); } }
      else entry.pendingCandidates.push(data.candidate); // 远端描述未就绪，先缓冲
    }
    return;
  }
  await handleSignal(from, data);
});
socket.on('user:audio', ({ id, enabled }) => {
  if (!enabled) {
    setMemberLevel(id, 0);
    closePeer(id);
  }
});
socket.on('rtc:close', ({ id }) => { closePeer(id); });
socket.on('user:speaking', ({ id, level }) => setMemberLevel(id, level));

function attachRemote(stream, id) {
  let a = remoteAudios.get(id);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true; a.id = 'audio-' + id;
    document.body.appendChild(a);
    remoteAudios.set(id, a);
  }
  a.srcObject = stream;
  applyRemoteAudioSettings(id);
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
$('btnCopy').addEventListener('click', () => copyInviteLink());
// 复制文本：优先用 navigator.clipboard（仅安全上下文可用），否则降级到 execCommand（http://IP 明文 context 也可用）
function copyInviteLink() {
  copyText(inviteLink(currentRoomId), '邀请链接已复制：');
}
function copyText(text, label = '已复制：') {
  const done = () => alert(label + text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    let settled = false;
    navigator.clipboard.writeText(text).then(() => {
      if (settled) return;
      settled = true;
      done();
    }).catch(() => {
      if (settled) return;
      settled = true;
      fallbackCopy(text, done);
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        fallbackCopy(text, done);
      }
    }, 600);
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok && done) done();
    else alert('复制失败，请手动复制：' + text);
  } catch (e) {
    alert('复制失败，请手动复制：' + text);
  }
}
function leave() {
  if (!confirm('确定离开房间？')) return;
  [...peers.keys()].forEach((id) => closePeer(id));
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  stopLocalMeter(); // 停止麦克风试音电平表，避免离开后仍占用音频上下文
  try { socket.disconnect(); } catch (e) {}
  // 关键：跳到根路径，避免留在 /r/ABCDEF 页面被 reload 后因 (initialInviteRoom && myName) 又自动重新加入
  location.href = '/';
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

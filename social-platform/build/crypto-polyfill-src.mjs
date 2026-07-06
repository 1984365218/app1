// 纯 JS 实现的 WebCrypto 子集垫片（仅在 crypto.subtle 不可用时启用）
// 目的：让端到端加密在「非安全上下文」（如 http://<局域网IP>）也能工作，
// 避免 `crypto.subtle is undefined` 导致创建/加入房间崩溃。
// 仅在 window.crypto.subtle 缺失时安装；若原生可用（https/localhost）则完全不介入。
import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';

function toBytes(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d);
}
function bufOf(u8) {
  const out = u8.slice(); // 独立 buffer，避免底层 buffer 过大
  return out.buffer;
}
function rand(n) {
  const b = new Uint8Array(n);
  (window.crypto || globalThis.crypto).getRandomValues(b);
  return b;
}

function buildSubtle() {
  return {
    async generateKey(alg, extractable, _usages) {
      if (alg && alg.name === 'ECDH' && alg.namedCurve === 'P-256') {
        const priv = randomBytes(32);
        const pub = p256.getPublicKey(priv, false); // 65 字节非压缩
        return {
          privateKey: { __k: 'ecdh-priv', raw: priv },
          publicKey: { __k: 'ecdh-pub', raw: pub },
        };
      }
      if (alg && alg.name === 'AES-GCM') {
        const raw = rand(32);
        return { __k: 'aes', raw, extractable: !!extractable };
      }
      throw new Error('unsupported generateKey: ' + (alg && alg.name));
    },
    async exportKey(format, key) {
      if (format !== 'raw') throw new Error('only raw supported');
      return bufOf(key.raw);
    },
    async importKey(format, data, alg, extractable, _usages) {
      if (format !== 'raw') throw new Error('only raw supported');
      const raw = toBytes(data);
      if (alg && alg.name === 'ECDH') return { __k: 'ecdh-pub', raw };
      if (alg && alg.name === 'AES-GCM') return { __k: 'aes', raw, extractable: !!extractable };
      throw new Error('unsupported importKey: ' + (alg && alg.name));
    },
    async deriveKey(alg, baseKey, _derivedAlg, extractable, _usages) {
      // alg = { name:'ECDH', public: <ecdh-pub key> }
      if (!alg || alg.name !== 'ECDH') throw new Error('only ECDH deriveKey');
      const shared = p256.getSharedSecret(baseKey.raw, alg.public.raw); // 共享点（压缩 33 字节 / 非压缩 65 字节）
      // Web Crypto 的 ECDH 派生密钥取共享点的 x 坐标（32 字节），与浏览器原生一致
      let x = shared;
      if (shared.length === 33) x = shared.slice(1);
      else if (shared.length === 65) x = shared.slice(1, 33);
      return { __k: 'aes', raw: toBytes(x), extractable: !!extractable };
    },
    async encrypt(alg, key, data) {
      if (!alg || alg.name !== 'AES-GCM') throw new Error('only AES-GCM encrypt');
      const ct = gcm(key.raw, toBytes(alg.iv)).encrypt(toBytes(data));
      return bufOf(ct);
    },
    async decrypt(alg, key, data) {
      if (!alg || alg.name !== 'AES-GCM') throw new Error('only AES-GCM decrypt');
      const pt = gcm(key.raw, toBytes(alg.iv)).decrypt(toBytes(data));
      return bufOf(pt);
    },
  };
}

(function install() {
  if (typeof window === 'undefined') return;
  const wc = window.crypto || (window.crypto = {});
  if (wc && wc.subtle) return; // 原生可用，跳过
  Object.defineProperty(wc, 'subtle', { value: buildSubtle(), configurable: true });
  console.log('[crypto-polyfill] 已注入纯 JS 版 crypto.subtle（非安全上下文可用）');
})();

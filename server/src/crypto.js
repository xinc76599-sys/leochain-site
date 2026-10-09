// AES-256-GCM encryption for exchange API keys at rest. Key material comes ONLY from env MASTER_KEY.
const crypto = require('crypto');
function masterKey() {
  const k = process.env.MASTER_KEY || '';
  if (!k) return null;
  const buf = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, 'hex') : crypto.createHash('sha256').update(k).digest();
  return buf;
}
function encrypt(obj) {
  const key = masterKey(); if (!key) throw new Error('未配置 MASTER_KEY，拒绝存储密钥');
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
}
function decrypt(rec) {
  const key = masterKey(); if (!key) throw new Error('未配置 MASTER_KEY');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64')); d.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8'));
}
module.exports = { encrypt, decrypt, hasKey: () => !!masterKey() };

import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// A deliberately small S3 surface: private PutObject and short-lived GetObject.
// Same native-crypto SigV4 approach as the existing image plugin; no new dependency.
export function createR2Storage(config, fetcher = fetch, clock = () => new Date()) {
  if (!/^[a-f0-9]{32}$/.test(config.accountId ?? '') ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '') ||
      typeof config.accessKeyId !== 'string' || !config.accessKeyId.trim() ||
      typeof config.secretAccessKey !== 'string' || !config.secretAccessKey.trim() ||
      typeof config.archiveFrom !== 'string' || !Number.isFinite(Date.parse(config.archiveFrom))) {
    throw new Error('invalid_r2_config');
  }
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  function signing(key) {
    // Object names are server-generated, never taken from a client request.
    if (typeof key !== 'string' || key.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid_object_key');
    const url = new URL(`${endpoint}/${config.bucket}/${key.split('/').map(encode).join('/')}`);
    const date = clock().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const scope = `${date.slice(0, 8)}/auto/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + config.secretAccessKey, date.slice(0, 8)), 'auto'), 's3'), 'aws4_request');
    const signature = canonical => hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).toString('hex');
    return { url, date, scope, signature };
  }
  return {
    archiveFrom: new Date(config.archiveFrom).toISOString(),
    async put(key, body, type) {
      const { url, date, scope, signature } = signing(key);
      const hash = digest(body);
      const names = 'content-type;host;x-amz-content-sha256;x-amz-date';
      const headers = `content-type:${type}\nhost:${url.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n`;
      const canonical = `PUT\n${url.pathname}\n\n${headers}\n${names}\n${hash}`;
      const response = await fetcher(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000), body,
        headers: { 'content-type': type, 'x-amz-content-sha256': hash, 'x-amz-date': date,
          authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature(canonical)}` } });
      await response.body?.cancel();
      if (!response.ok) throw new Error('r2_upload_failed'); // Never include signed URLs or provider error bodies.
    },
    getUrl(key) {
      const { url, date, scope, signature } = signing(key);
      const values = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
        'X-Amz-Date': date, 'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host' };
      const query = Object.keys(values).sort().map(k => `${encode(k)}=${encode(values[k])}`).join('&');
      const canonical = `GET\n${url.pathname}\n${query}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
      return `${url}?${query}&X-Amz-Signature=${signature(canonical)}`;
    },
  };
}

export async function loadR2Storage(path) {
  if (!path) return null;
  // An explicitly configured but missing/invalid secret is a startup error.
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('r2_config_unreadable'); }
  return createR2Storage(config);
}

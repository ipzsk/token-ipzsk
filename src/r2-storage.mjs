import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const amzDate = date => date.toISOString().replace(/[:-]|\.\d{3}/g, '');
const GRACE_SEC = 1800;

// Query-string SigV4 (presigned URL). Pure, so it can be checked against AWS's documented example.
// `headers` are extra signed headers the caller must send verbatim (host is always signed).
export function presignUrl({ method, host, path, region, service = 's3', accessKeyId, secretAccessKey, date, expiresSec, headers = {} }) {
  const stamp = amzDate(date), scope = `${stamp.slice(0, 8)}/${region}/${service}/aws4_request`;
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host };
  const names = Object.keys(all).sort();
  const values = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp, 'X-Amz-Expires': String(expiresSec), 'X-Amz-SignedHeaders': names.join(';') };
  const query = Object.keys(values).sort().map(k => `${encode(k)}=${encode(values[k])}`).join('&');
  const canonical = `${method}\n${path}\n${query}\n${names.map(n => `${n}:${all[n]}\n`).join('')}\n${names.join(';')}\nUNSIGNED-PAYLOAD`;
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, stamp.slice(0, 8)), region), service), 'aws4_request');
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${digest(canonical)}`).toString('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

// Header SigV4 signature for a direct request. Returns the Authorization header value.
export function authorization({ method, host, path, query = '', region, service = 's3', accessKeyId, secretAccessKey, date, headers, payloadHash }) {
  const stamp = amzDate(date), scope = `${stamp.slice(0, 8)}/${region}/${service}/aws4_request`;
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host };
  const names = Object.keys(all).sort();
  const canonical = `${method}\n${path}\n${query}\n${names.map(n => `${n}:${all[n]}\n`).join('')}\n${names.join(';')}\n${payloadHash}`;
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, stamp.slice(0, 8)), region), service), 'aws4_request');
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${digest(canonical)}`).toString('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

// Fixed UTC time slices so the same key signs to the same URL for hours (browser cache hits).
// Near the end of a slice (< grace left) the URL keeps the current X-Amz-Date but covers the next slice too:
// signing with a future X-Amz-Date would be "not yet valid" at the provider until that slice starts.
export function slicedWindow(now, sliceHours = 6) {
  const sliceMs = sliceHours * 3600_000, start = Math.floor(now.getTime() / sliceMs) * sliceMs;
  const late = start + sliceMs - now.getTime() < GRACE_SEC * 1000;
  const expiresSec = (late ? 2 : 1) * sliceHours * 3600 + GRACE_SEC;
  return { date: new Date(start), expiresSec, expiresAt: new Date(start + expiresSec * 1000) };
}

// A deliberately small S3 surface over native crypto; no new dependency.
export function createR2Storage(config, fetcher = fetch, clock = () => new Date()) {
  if (!/^[a-f0-9]{32}$/.test(config.accountId ?? '') ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '') ||
      typeof config.accessKeyId !== 'string' || !config.accessKeyId.trim() ||
      typeof config.secretAccessKey !== 'string' || !config.secretAccessKey.trim() ||
      typeof config.archiveFrom !== 'string' || !Number.isFinite(Date.parse(config.archiveFrom))) {
    throw new Error('invalid_r2_config');
  }
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const creds = { host, region: 'auto', accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  function objectPath(key) {
    // Object names are server-generated, never taken from a client request.
    if (typeof key !== 'string' || key.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid_object_key');
    return `/${config.bucket}/${key.split('/').map(encode).join('/')}`;
  }
  // hash: 调用方已经算好的 payload sha256。流式上传（Blob/文件）靠它签名，不必把整个文件读进内存再 digest。
  async function send(method, key, { headers = {}, body, timeout = 30000, hash } = {}) {
    const path = objectPath(key), date = clock(), payloadHash = hash ?? digest(body ?? '');
    const signed = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) };
    return fetcher(new URL(`https://${host}${path}`), { method, redirect: 'error', signal: AbortSignal.timeout(timeout), body,
      headers: { ...signed, authorization: authorization({ ...creds, method, path, date, headers: signed, payloadHash }) } });
  }
  const presign = (method, key, date, expiresSec, headers) => presignUrl({ ...creds, method, path: objectPath(key), date, expiresSec, headers });
  return {
    archiveFrom: new Date(config.archiveFrom).toISOString(),
    // timeout/hash/metadata 只有大文件上传用得上（scripts/upload-desktop-release.mjs）；日常小对象仍是默认 30s。
    // ponytail: 单次 PUT，R2 上限 5GB。这个客户端没有 multipart，安装包真超过 5GB 或需要断点续传再加。
    async put(key, body, type, { cacheControl, timeout, hash, metadata } = {}) {
      const response = await send('PUT', key, { body, hash, ...(timeout ? { timeout } : {}),
        headers: { 'content-type': type, ...(cacheControl ? { 'cache-control': cacheControl } : {}),
          ...Object.fromEntries(Object.entries(metadata ?? {}).map(([k, v]) => ['x-amz-meta-' + k, String(v)])) } });
      await response.body?.cancel();
      if (!response.ok) throw new Error('r2_upload_failed'); // Never include signed URLs or provider error bodies.
    },
    getUrl(key, expiresSec = 300) { return presign('GET', key, clock(), expiresSec); },
    presignGetSliced(key, { sliceHours = 6 } = {}) {
      const { date, expiresSec } = slicedWindow(clock(), sliceHours);
      return presign('GET', key, date, expiresSec);
    },
    // content-length/content-type (and cache-control) are signed, so R2 rejects any other size or type.
    presignPut(key, { contentType, contentLength, cacheControl, expiresSec = 600 }) {
      return presign('PUT', key, clock(), expiresSec, { 'content-length': contentLength, 'content-type': contentType,
        ...(cacheControl ? { 'cache-control': cacheControl } : {}) });
    },
    async head(key) {
      const response = await send('HEAD', key);
      await response.body?.cancel();
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('r2_head_failed');
      // sha256: 上传时写进去的 x-amz-meta-sha256（没有就是 null，比如 CI 传的对象）。
      return { bytes: Number(response.headers.get('content-length')), contentType: response.headers.get('content-type'),
        sha256: response.headers.get('x-amz-meta-sha256') };
    },
    async getRange(key, start, end) {
      const response = await send('GET', key, { headers: { range: `bytes=${start}-${end}` } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('r2_get_failed'); }
      const max = end - start + 1, chunks = []; let size = 0;
      for await (const chunk of response.body) {
        chunks.push(Buffer.from(chunk)); size += chunk.length;
        if (size >= max) { await response.body.cancel?.().catch(() => {}); break; }
      }
      return Buffer.concat(chunks).subarray(0, max);
    },
    async delete(key) {
      const response = await send('DELETE', key);
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new Error('r2_delete_failed');
    },
    async copy(srcKey, dstKey, { cacheControl, contentType } = {}) {
      const response = await send('PUT', dstKey, { headers: { 'x-amz-copy-source': objectPath(srcKey),
        ...(cacheControl || contentType ? { 'x-amz-metadata-directive': 'REPLACE' } : {}),
        ...(cacheControl ? { 'cache-control': cacheControl } : {}), ...(contentType ? { 'content-type': contentType } : {}) } });
      await response.body?.cancel();
      if (!response.ok) throw new Error('r2_copy_failed');
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

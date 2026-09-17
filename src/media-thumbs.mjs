// Local ffmpeg thumbnail queue on media_assets.thumb_*: THUMB_CONCURRENCY ffmpeg processes per gateway process (default 1).
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMedia } from './media-probe.mjs';
import { OBJECT_CACHE_CONTROL } from './uploads.mjs';

const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000]; // after attempt 1..4; attempt 5 fails permanently
export const MAX_ATTEMPTS = 5;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024, MAX_PIXELS_SIDE = 8192, MAX_OUTPUT = 16 * 1024 * 1024;
const LEASE = '5 minutes'; // a crashed/OOM-killed run is reclaimed after this and counts as an attempt
const NICE = existsSync('/usr/bin/nice') ? '/usr/bin/nice' : null;
const DEMUXER = { 'image/png': 'png_pipe', 'image/jpeg': 'jpeg_pipe', 'image/webp': 'webp_pipe', 'video/mp4': 'mov' };
const ENCODER = {
  webp: { ext: 'webp', type: 'image/webp', args: ['-c:v', 'libwebp', '-quality', '80', '-f', 'webp'] },
  jpg: { ext: 'jpg', type: 'image/jpeg', args: ['-c:v', 'mjpeg', '-q:v', '4', '-f', 'mjpeg'] },
};

export const backoffMs = attempts => BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];

export async function enqueueThumb(db, assetId) {
  await db.query(`UPDATE media_assets SET thumb_state='queued',thumb_attempts=0,thumb_next_at=now(),thumb_error=NULL WHERE id=$1`, [assetId]);
}

const skip = reason => Object.assign(new Error(reason), { skip: true });

// Runs one process (args array, never a shell). Resolves with one Buffer per output pipe (fd 1, 3, 4, ...).
export function runProcess(spawn, cmd, args, { outputs = 1, timeoutMs = 60_000, nice = NICE } = {}) {
  return new Promise((resolve, reject) => {
    const [bin, argv] = nice ? [nice, ['-n', '10', cmd, ...args]] : [cmd, args];
    const fds = [1, ...Array.from({ length: outputs - 1 }, (_, i) => i + 3)];
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe', ...fds.slice(1).map(() => 'pipe')] });
    const bufs = fds.map(() => []), sizes = fds.map(() => 0);
    let stderr = '', killed = null, settled = false;
    const kill = reason => { if (!killed) { killed = reason; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    fds.forEach((fd, i) => child.stdio[fd].on('data', chunk => {
      bufs[i].push(chunk); sizes[i] += chunk.length;
      if (sizes[i] > MAX_OUTPUT) kill('output_too_large');
    }));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    const done = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    child.on('error', err => done(Object.assign(new Error('spawn_failed'), { stderr: err.message })));
    child.on('close', (code, signal) => {
      if (code === 0 && !killed) return done(null, bufs.map(b => Buffer.concat(b)));
      done(Object.assign(new Error(killed ?? `exit_${code ?? signal}`), { stderr }));
    });
  });
}

let formatPromise;
const detectFormat = (spawn, ffmpeg) => formatPromise ??= runProcess(spawn, ffmpeg, ['-hide_banner', '-encoders'], { nice: null })
  .then(([out]) => /\blibwebp\b/.test(out) ? 'webp' : 'jpg', err => { formatPromise = null; throw err; });

const NET = ['-rw_timeout', '15000000', '-protocol_whitelist', 'http,https,tls,tcp'];

export async function thumbnailAsset(row, { r2, spawn, ffmpeg, ffprobe, format, timeoutMs, nice }) {
  const opts = { timeoutMs, nice };
  if (row.kind === 'image' && Number(row.bytes) > MAX_IMAGE_BYTES) throw skip('image_too_large');
  const url = r2.getUrl(row.object_key);
  const [probeOut] = await runProcess(spawn, ffprobe, ['-v', 'error', ...NET, '-print_format', 'json', '-show_streams', '-show_format',
    '-f', DEMUXER[row.content_type], url], opts);
  const probe = JSON.parse(probeOut.toString('utf8') || '{}');
  const stream = probe.streams?.find(s => s.codec_type === 'video');
  if (!stream?.width || !stream?.height) throw new Error('no_video_stream');
  if (stream.width > MAX_PIXELS_SIDE || stream.height > MAX_PIXELS_SIDE) throw skip('too_many_pixels');
  const rotated = Math.abs(stream.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
  const duration = Number(probe.format?.duration);
  const meta = { width: rotated ? stream.height : stream.width, height: rotated ? stream.width : stream.height,
    duration_ms: row.kind === 'video' && Number.isFinite(duration) ? Math.round(duration * 1000) : null };

  // EXIF/display-matrix rotation is applied by ffmpeg before our filters, so the displayed width is only
  // known for sure after encoding; skip widths no orientation can reach, then drop outputs narrower than asked.
  const longSide = Math.max(stream.width, stream.height);
  const targets = row.kind === 'video' ? [['poster', 960], ['w480', 480]] : [['w480', 480], ['w960', 960]].filter(([, w]) => w < longSide);
  if (!targets.length) return { variants: {}, meta };
  const enc = ENCODER[format];
  const seek = row.kind === 'video' ? ['-ss', String(Math.min(1, Number.isFinite(duration) ? duration / 2 : 0))] : [];
  const graph = `[0:v]split=${targets.length}${targets.map((_, i) => `[s${i}]`).join('')};` +
    targets.map(([, w], i) => `[s${i}]scale=w='min(${w},iw)':h=-2:flags=lanczos[o${i}]`).join(';');
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', ...NET, ...seek,
    '-f', DEMUXER[row.content_type], '-i', url, '-filter_complex', graph,
    ...targets.flatMap((_, i) => ['-map', `[o${i}]`, '-frames:v', '1', '-threads', '1', ...enc.args, `pipe:${i === 0 ? 1 : i + 2}`])];
  const outs = await runProcess(spawn, ffmpeg, args, { ...opts, outputs: targets.length });
  const prefix = row.object_key.slice(0, row.object_key.lastIndexOf('/') + 1), variants = {};
  for (const [i, [name, w]] of targets.entries()) {
    const info = await probeMedia(outs[i], outs[i].length, async (s, e) => outs[i].subarray(s, e + 1));
    if (!info || info.contentType !== enc.type) throw new Error('bad_ffmpeg_output');
    if (name !== 'poster' && info.width < w) continue; // would be a copy of a smaller original
    const key = `${prefix}${name}.${enc.ext}`;
    await r2.put(key, outs[i], enc.type, { cacheControl: OBJECT_CACHE_CONTROL });
    variants[name] = key;
  }
  return { variants, meta };
}

// Server-side audio duration (ms) from the uploaded bytes via ffprobe. Never trusts the client.
// A temp file (not stdin): mp3 duration needs the file size / seeking, which a pipe cannot give.
export async function probeAudioDurationMs(data, { spawn = nodeSpawn, ffprobe = 'ffprobe', timeoutMs = 30_000, nice } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ipzsk-audio-'));
  let out;
  try {
    await writeFile(join(dir, 'in'), data);
    [out] = await runProcess(spawn, ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', join(dir, 'in')], { timeoutMs, nice });
  } finally { await rm(dir, { recursive: true, force: true }); }
  const probe = JSON.parse(out.toString('utf8') || '{}');
  if (!probe.streams?.some(s => s.codec_type === 'audio')) throw new Error('no_audio_stream');
  const seconds = Number(probe.format?.duration ?? probe.streams.find(s => s.codec_type === 'audio').duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('no_audio_duration');
  return Math.round(seconds * 1000);
}

// Slots, not a boolean: THUMB_CONCURRENCY (1–2) ffmpeg processes per gateway process. Each ffmpeg run is
// single-threaded with a 16MB output cap, but decoding an 8192² frame still takes a few hundred MB — keep 1 on the 2GB host.
let running = 0;
export const thumbConcurrency = (env = process.env) => Math.min(2, Math.max(1, Number.parseInt(env.THUMB_CONCURRENCY ?? '1', 10) || 1));
// THUMB_PRIORITY (default on): user uploads/generations are claimed before source='case' backfill jobs.
export const thumbPriority = (env = process.env) => env.THUMB_PRIORITY !== '0';

// One job per call. Returns the processed asset id, or null when the queue is empty or every slot is busy.
export async function runThumbJobs({ db, r2, log, now = () => new Date(), spawn = nodeSpawn, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe',
  format, timeoutMs = 60_000, nice, concurrency = 1, priority = true } = {}) {
  if (running >= concurrency || !r2) return null;
  running++;
  try {
    const at = now();
    const row = (await db.query(`UPDATE media_assets SET thumb_state='running',thumb_attempts=thumb_attempts+1,
        thumb_next_at=$1::timestamptz+interval '${LEASE}'
      WHERE id=(SELECT id FROM media_assets WHERE thumb_state IN ('queued','failed','running') AND thumb_next_at<=$1 AND status='ready' AND kind<>'audio'
        ORDER BY ${priority ? "(source='case')," : ''}thumb_next_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [at.toISOString()])).rows[0];
    if (!row) return null;
    try {
      if (row.thumb_attempts > MAX_ATTEMPTS) throw Object.assign(new Error('lease_expired'), { final: true });
      const { variants, meta } = await thumbnailAsset(row, { r2, spawn, ffmpeg, ffprobe, timeoutMs, nice,
        format: format ?? await detectFormat(spawn, ffmpeg) });
      await db.query(`UPDATE media_assets SET thumb_state='done',thumb_next_at=NULL,thumb_error=NULL,variants=$2,
        width=coalesce(width,$3),height=coalesce(height,$4),duration_ms=coalesce(duration_ms,$5) WHERE id=$1 AND thumb_state='running'`,
      [row.id, variants, meta.width, meta.height, meta.duration_ms]);
    } catch (err) {
      const stderr = String(err.stderr ?? '').slice(-2048);
      if (err.skip) {
        await db.query(`UPDATE media_assets SET thumb_state='skipped',thumb_next_at=NULL,thumb_error=$2 WHERE id=$1`, [row.id, err.message]);
        return row.id;
      }
      const final = err.final || row.thumb_attempts >= MAX_ATTEMPTS;
      await db.query(`UPDATE media_assets SET thumb_state='failed',thumb_error=$2,thumb_next_at=$3 WHERE id=$1`,
        [row.id, `${err.message}${stderr ? ': ' + stderr : ''}`.slice(0, 2048),
          final ? null : new Date(at.getTime() + backoffMs(row.thumb_attempts)).toISOString()]);
      log?.warn({ asset_id: row.id, attempt: row.thumb_attempts, error: err.message, stderr }, 'thumbnail_failed');
    }
    return row.id;
  } finally { running--; }
}

// Drains due jobs until the queue is empty or budgetMs has passed (the 5s interval stays the outer loop).
// `concurrency` workers share the slots above, so overlapping drains never exceed the cap.
export async function drainThumbJobs({ budgetMs = 4500, concurrency = 1, clock = Date.now, ...opts } = {}) {
  const until = clock() + budgetMs;
  let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (clock() < until && await runThumbJobs({ ...opts, concurrency })) done++;
  }));
  return done;
}

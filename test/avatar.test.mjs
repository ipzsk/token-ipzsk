import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarCatalogSpec, avatarChoice, avatarUpstreamBody, avatarErrorFor, avatarSubmitError, avatarItem, voiceItem, SCRIPT_MAX,
  avatarLaneRequest, avatarDraftIssues } from '../src/avatar-contract.mjs';
import { agentRequest } from '../src/agent-protocols.mjs';
import { sniffAudio, probeMedia } from '../src/media-probe.mjs';
import { probeAudioDurationMs } from '../src/media-thumbs.mjs';
import { mediaModelsFromCatalog } from '../src/lanehub-catalog.mjs';

// lanehub /api/catalog without mode/inputs hints (older lanehub): inference from params only.
const laneAvatar = (id) => ({ id, kind: 'video', billing: { unit: 'per_minute_output' }, params: { registered: true, passthrough: ['avatar_id', 'script'],
  fields: ['aspect_ratio', 'audio_url', 'background_color', 'background_image_url', 'captions', 'resolution', 'voice_id'].map((field) => ({ field })) } });
const lanePhoto = { id: 'heygen-image', kind: 'video', params: { registered: true, passthrough: ['script'],
  fields: ['aspect_ratio', 'audio_url', 'background_color', 'background_image_url', 'captions', 'image_urls', 'resolution', 'voice_id'].map((field) => ({ field })) } };
const AV = avatarCatalogSpec(laneAvatar('heygen-avatar')), PH = avatarCatalogSpec(lanePhoto);

test('catalog: mode + avatar block derived from passthrough/fields; hints override; non-heygen untouched', () => {
  assert.deepEqual(AV, { mode: 'avatar', avatar: { source: ['library'], voice: ['script', 'audio'], script: { max: 5000, voice_required: false },
    captions: true, background: ['color', 'image'], engine: 'iv' } });
  assert.equal(avatarCatalogSpec(laneAvatar('heygen-avatar-iii')).avatar.engine, 'iii');
  assert.deepEqual(PH.avatar.source, ['photo']); assert.equal(PH.avatar.script.voice_required, true); assert.equal(PH.mode, 'talking_photo');
  // lanehub's final catalog hints (mode + inputs) win over inference.
  const hinted = avatarCatalogSpec({ id: 'x-custom', mode: 'avatar', inputs: { required: ['image_urls'], one_of: ['audio_url'], required_with: { script: ['voice_id'] }, max_length: { script: 1200 } },
    params: { const: { engine: { type: 'avatar_v' } }, passthrough: [], fields: [{ field: 'audio_url' }] } });
  assert.deepEqual([hinted.avatar.source, hinted.avatar.voice, hinted.avatar.engine, hinted.avatar.script, hinted.avatar.captions, hinted.avatar.background],
    [['photo'], ['audio'], 'v', { max: 1200, voice_required: true }, false, []]);
  const final = avatarCatalogSpec({ id: 'heygen-image', mode: 'talking_photo', inputs: { required: ['image_urls'], one_of: ['script', 'audio_url'], required_with: { script: ['voice_id'] }, max_length: { script: 5000 } },
    params: { const: { type: 'image' }, passthrough: ['script'], fields: lanePhoto.params.fields } });
  assert.deepEqual(final, PH, 'hints and inference agree on today\'s models');
  assert.equal(avatarCatalogSpec({ id: 'heygen-avatar-iii', params: { const: { type: 'image' } } }).mode, 'talking_photo', 'const.type');
  // No hints at all → id fallback.
  assert.deepEqual(avatarCatalogSpec({ id: 'heygen-studio' }), { mode: 'studio' });
  assert.deepEqual(avatarCatalogSpec({ id: 'heygen-cinematic-avatar', params: { passthrough: ['avatar_id'] } }), { mode: 'cinematic_avatar' });
  assert.equal(avatarCatalogSpec({ id: 'heygen-avatar' }).avatar.voice.includes('audio'), true, 'no fields listed → assume both voices');
  assert.deepEqual(avatarCatalogSpec({ id: 'gpt-image-2.5-flare', params: { passthrough: ['avatar_id'] } }), {});
  const [spec] = mediaModelsFromCatalog({ models: [laneAvatar('heygen-avatar')] });
  assert.equal(spec.mode, 'avatar'); assert.deepEqual(spec.params.map((p) => p.field), ['aspect_ratio', 'resolution']);
});

test('avatarChoice: exhaustive source × voice × mode table', () => {
  const sources = { none: {}, library: { avatar_id: 'av_1' }, photo: { photo_asset_id: '00000000-0000-4000-8000-000000000001' },
    both: { avatar_id: 'av_1', photo_asset_id: '00000000-0000-4000-8000-000000000001' } };
  const voices = { none: {}, script: { script: '你好', voice_id: 'v1' }, audio: { audio_asset_id: '00000000-0000-4000-8000-000000000002' },
    both: { script: '你好', audio_asset_id: '00000000-0000-4000-8000-000000000002' } };
  let n = 0;
  for (const [mode, spec] of [['avatar', AV], ['talking_photo', PH]]) {
    for (const [s, sb] of Object.entries(sources)) {
      for (const [v, vb] of Object.entries(voices)) {
        const expected = s === 'both' ? 'avatar_source_conflict' : s === 'none' ? 'avatar_source_required'
          : (mode === 'avatar') !== (s === 'library') ? 'avatar_source_unsupported'
            : v === 'both' ? 'avatar_voice_conflict' : v === 'none' ? 'avatar_voice_required' : { source: s, voice: v, background: null };
        const run = () => avatarChoice({ model: 'm', ...sb, ...vb }, spec);
        if (typeof expected === 'string') {
          assert.throws(run, (e) => e.code === expected && e.statusCode === 400 && typeof e.fields.message === 'string', `${mode}/${s}/${v}`);
        } else assert.deepEqual(run(), expected, `${mode}/${s}/${v}`);
        n++;
      }
    }
  }
  assert.equal(n, 32);
  const code = (body, spec = AV) => { try { avatarChoice({ model: 'm', avatar_id: 'a', script: 'hi', ...body }, spec); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code({ prompt: 'x' }), 'avatar_prompt_not_supported');
  assert.equal(code({ n: 2 }), 'unsupported_parameter');
  assert.equal(code({ script: 'x'.repeat(SCRIPT_MAX + 1) }), 'script_too_long');
  assert.equal(code({ script: '字'.repeat(SCRIPT_MAX) }), 'ok', 'counted in characters, not bytes');
  assert.equal(code({ voice_id: undefined }), 'ok', 'library avatar may use its default voice');
  assert.equal(code({ avatar_id: undefined, photo_asset_id: 'p', voice_id: undefined }, PH), 'voice_id_required');
  assert.equal(code({ script: undefined, audio_asset_id: 'a', voice_id: 'v' }), 'avatar_voice_conflict');
  assert.equal(code({ captions: 'yes' }), 'invalid_captions');
  assert.equal(code({ background_color: '#12345' }), 'invalid_background_color');
  assert.equal(code({ background_color: '#123456', background_asset_id: 'b' }), 'background_conflict');
  assert.equal(code({ captions: true }, avatarCatalogSpec({ id: 'x', mode: 'avatar', params: { fields: [{ field: 'audio_url' }] } })), 'captions_unsupported');
  assert.deepEqual(avatarChoice({ model: 'm', avatar_id: 'a', script: 'hi', background_asset_id: 'b' }, AV).background, 'image');
});

test('avatarUpstreamBody: exactly one field per side, captions/background mapping, no prompt', () => {
  const urls = { photo: 'https://r2/p.png', audio: 'https://r2/a.mp3', background: 'https://r2/b.jpg' };
  const base = { model: 'heygen-avatar', aspect_ratio: '9:16', resolution: '1080p' };
  const map = (body, spec) => avatarUpstreamBody(body, avatarChoice(body, spec), urls, { uploadAssets: false });
  assert.deepEqual(map({ ...base, avatar_id: 'av', script: '你好', voice_id: 'v1', captions: true, background_color: '#00FF00' }, AV),
    { model: 'heygen-avatar', avatar_id: 'av', script: '你好', voice_id: 'v1', captions: true, background_color: '#00FF00', aspect_ratio: '9:16', resolution: '1080p' });
  assert.deepEqual(map({ ...base, avatar_id: 'av', audio_asset_id: 'x', background_asset_id: 'b' }, AV),
    { model: 'heygen-avatar', avatar_id: 'av', audio_url: urls.audio, background_image_url: urls.background, aspect_ratio: '9:16', resolution: '1080p' });
  assert.deepEqual(map({ model: 'heygen-image', photo_asset_id: 'p', script: 'hi', voice_id: 'v2', captions: false }, PH),
    { model: 'heygen-image', image_urls: [urls.photo], script: 'hi', voice_id: 'v2', captions: false });
  assert.deepEqual(map({ model: 'heygen-image', photo_asset_id: 'p', audio_asset_id: 'x' }, PH), { model: 'heygen-image', image_urls: [urls.photo], audio_url: urls.audio });
  const quote = avatarUpstreamBody({ model: 'm', avatar_id: 'a', audio_asset_id: 'x' }, { source: 'library', voice: 'audio', background: null }, urls, { duration: 95, uploadAssets: true });
  assert.deepEqual(quote, { model: 'm', avatar_id: 'a', audio_url: urls.audio, duration: 95, upload_assets: true });
});

test('upstream error mapping and list item normalisation', () => {
  assert.deepEqual(avatarSubmitError({ error: { code: 'invalid_parameter', message: 'Avatar does not support avatar_iii engine' } }),
    { code: 'avatar_engine_unavailable', field: 'avatar_id', message: '该数字人不支持 Avatar III 引擎，请换一个数字人或改用 Avatar IV 型号' });
  assert.equal(avatarErrorFor('invalid_parameter', 'engine not allowed', 'engine').code, 'invalid_parameter', 'client-sent engine param is not an avatar problem');
  assert.deepEqual(avatarErrorFor('avatar_consent_required'), { code: 'avatar_consent_required', message: '该数字人需要先完成肖像授权，请换一个已授权的数字人' });
  assert.equal(avatarErrorFor('content_policy_violation').code, 'content_policy_violation', 'lanehub codes pass through unchanged');
  assert.deepEqual(avatarSubmitError({ error: { code: 'constraint_violation', message: '参数 script / audio_url 必须恰好给一个', field: 'script|audio_url' } }),
    { code: 'constraint_violation', message: '参数 script / audio_url 必须恰好给一个', field: 'script|audio_url' });
  assert.equal(avatarSubmitError({ code: 'invalid_parameter', message: 'No face detected in the image' }).code, 'avatar_photo_no_face');
  assert.equal(avatarErrorFor(null, 'Talking photo: face not found').code, 'avatar_photo_no_face');
  assert.equal(avatarErrorFor(null, 'avatar requires consent').code, 'avatar_consent_required');
  assert.equal(avatarErrorFor('upstream_http_400', 'boom'), null);
  assert.equal(avatarSubmitError({ error: { code: 'Bad Code!' } }), null);
  assert.deepEqual(avatarItem({ id: 'a1', name: 'Anna', type: 'talking_photo', avatar_type: 'photo_avatar', engines: ['avatar_iii', 3] }),
    { id: 'a1', name: 'Anna', type: 'talking_photo', avatar_type: 'photo_avatar', gender: null, preview_image_url: null, preview_video_url: null, default_voice_id: null, engines: ['avatar_iii'] });
  assert.deepEqual(voiceItem({ id: 'v', language: 'Chinese', preview_audio_url: 'https://x/v.mp3', support_pause: true, type: 'public' }),
    { id: 'v', name: 'v', language: 'Chinese', gender: null, preview_audio_url: 'https://x/v.mp3', support_pause: true, type: 'public' });
});

test('audio magic sniffing: wav, mp3 (ID3 and bare frame), not webp/png/garbage', async () => {
  const wav = Buffer.alloc(44); wav.write('RIFF', 0); wav.write('WAVE', 8);
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
  assert.equal(sniffAudio(wav), 'audio/wav');
  assert.equal(sniffAudio(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1')), 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x64])), 'audio/mpeg', 'MPEG-1 Layer III frame');
  assert.equal(sniffAudio(Buffer.from([0xff, 0xf1, 0x50, 0x80])), null, 'ADTS AAC is not mp3');
  assert.equal(sniffAudio(webp), null);
  assert.equal(sniffAudio(Buffer.from('hello world!')), null);
  assert.equal((await probeMedia(wav, wav.length, async () => wav)).contentType, 'audio/wav');
  assert.equal((await probeMedia(webp, webp.length, async () => webp)).contentType, 'image/webp');
});

test('ffprobe measures audio duration from bytes', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ipzsk-avatar-test-'));
  for (const [fmt, codec] of [['wav', 'pcm_s16le'], ['mp3', 'libmp3lame']]) {
    const out = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', '-c:a', codec, '-f', fmt, '-y', join(dir, 'a.' + fmt)], { maxBuffer: 8e6 });
    assert.equal(out.status, 0, String(out.stderr));
    const bytes = readFileSync(join(dir, 'a.' + fmt));
    assert.equal(sniffAudio(bytes), fmt === 'wav' ? 'audio/wav' : 'audio/mpeg');
    const ms = await probeAudioDurationMs(bytes, { nice: null });
    assert.ok(Math.abs(ms - 2000) < 150, `${fmt} ${ms}`);
  }
  await assert.rejects(() => probeAudioDurationMs(Buffer.from('not audio at all'), { nice: null }));
  rmSync(dir, { recursive: true, force: true });
});

test('bearer /v1/videos/generations: avatar models use lanehub names, no prompt; same avatarChoice rules', () => {
  const v = '/v1/videos/generations';
  const ok = { model: 'heygen-image', image_urls: ['https://cdn.test/p.png'], script: 'hi', voice_id: 'v1', captions: true, background_image_url: 'https://cdn.test/b.jpg' };
  assert.deepEqual(agentRequest(v, ok, PH), { ...ok, stream: false });
  assert.deepEqual(agentRequest(v, { model: 'heygen-avatar', avatar_id: 'a', audio_url: 'https://cdn.test/a.mp3' }, AV).audio_url, 'https://cdn.test/a.mp3');
  const err = (body, spec = PH) => { try { agentRequest(v, body, spec); return 'ok'; } catch (e) { return [e.code, e.fields?.field ?? null, e.fields?.message ?? '']; } };
  assert.equal(err({ model: 'heygen-avatar', script: 'hi' }, null)[0], 'invalid_text', 'non-avatar spec still needs prompt');
  assert.deepEqual(err({ ...ok, voice_id: undefined }).slice(0, 2), ['voice_id_required', 'voice_id']);
  const conflict = err({ ...ok, script: undefined, voice_id: undefined, audio_url: 'https://cdn.test/a.mp3', avatar_id: 'x' });
  assert.deepEqual(conflict.slice(0, 2), ['avatar_source_conflict', 'avatar_id|image_urls']);
  assert.match(conflict[2], /image_urls/); assert.doesNotMatch(conflict[2], /photo_asset_id/, 'messages speak lanehub names');
  assert.equal(err({ ...ok, script: undefined, audio_url: 'https://cdn.test/a.mp3' })[0], 'avatar_voice_conflict');
  assert.equal(err({ ...ok, image_urls: ['https://a', 'https://b'] })[0], 'invalid_image_urls');
  assert.equal(err({ ...ok, audio_url: 'ftp://x' })[0], 'invalid_audio_url');
  assert.equal(err({ ...ok, prompt: 'x' })[0], 'avatar_prompt_not_supported');
  assert.equal(err({ ...ok, script: 'x'.repeat(SCRIPT_MAX + 1) })[0], 'script_too_long');
  assert.equal(err({ ...ok, stream: true })[0], 'media_uses_task_polling');
  assert.equal(avatarLaneRequest({ model: 'm', avatar_id: 'a', script: 'hi' }, AV).source, 'library');
});

test('avatarDraftIssues: gaps become issues (later format rules still run); format errors throw', () => {
  assert.deepEqual(avatarDraftIssues('heygen-avatar', {}, AV).map((i) => [i.code, i.field]), [['avatar_source_required', 'avatar_id'], ['avatar_voice_required', 'script|audio_asset_id']]);
  assert.deepEqual(avatarDraftIssues('heygen-image', { photo_asset_id: 'p', script: 'hi' }, PH).map((i) => i.code), ['voice_id_required']);
  assert.deepEqual(avatarDraftIssues('heygen-image', { voice_id: 'v' }, PH).map((i) => i.code), ['avatar_source_required', 'avatar_voice_required']);
  assert.deepEqual(avatarDraftIssues('heygen-avatar', { avatar_id: 'a', script: 'hi' }, AV), []);
  assert.throws(() => avatarDraftIssues('heygen-avatar', { script: 'x'.repeat(SCRIPT_MAX + 1) }, AV), (e) => e.code === 'script_too_long', 'hidden behind a missing avatar otherwise');
  assert.throws(() => avatarDraftIssues('heygen-avatar', { photo_asset_id: 'p' }, AV), (e) => e.code === 'avatar_source_unsupported');
  assert.throws(() => avatarDraftIssues('heygen-avatar', { background_color: 'red' }, AV), (e) => e.code === 'invalid_background_color');
});

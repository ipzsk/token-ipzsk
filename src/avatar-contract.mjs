// 数字人（HeyGen 经 lanehub）契约映射：网关请求形状 ↔ lanehub 字段名，全部集中在这一个文件。
// lanehub 字段名出处（2026-09-17 未提交改动，workstream A 已完成）：docs/downstream-api-contract.md、docs/heygen-onboarding.md、
// providers/heygen/{params,list,errors}.go、relay/task/normalize.go、controller/{catalog,quote}.go。
// 标 PROVISIONAL 的是 lanehub 没有实现、网关先按约定命名的，改名只改这里。
import { httpError } from './security.mjs';

// ── lanehub 请求体字段（已确认：params.go 的 Allow/Passthrough + canonical 表） ──
export const LANE = {
  avatarId: 'avatar_id', // Passthrough（avatar 线必填）
  image: 'image_urls', // canonical，lanehub 改名成 HeyGen 的 image:{type:'url',url}
  script: 'script', // Passthrough，≤5000 字（ScriptMaxChars）
  voiceId: 'voice_id', // canonical；avatar 线可省（用数字人默认音色），talking_photo 线配 script 必填
  audioUrl: 'audio_url', // canonical，与 script 互斥
  captions: 'captions', // canonical bool → HeyGen caption:{style:'default'}
  backgroundColor: 'background_color', // canonical #RRGGBB
  backgroundImageUrl: 'background_image_url', // canonical http(s) URL，与 background_color 互斥
  duration: 'duration', // 仅报价：pricing.ExtractRequestParams 认 duration，EstimateOutputSeconds 优先用它
  uploadAssets: 'upload_assets', // PROVISIONAL：lanehub 未实现，HEYGEN_UPLOAD_ASSETS=1 时才发
};
// 已确认：router/relay-router.go → providers/heygen/list.go，{items:[…]}；voices 收 language（如 Chinese）与 type=public|private。
export const LIST_PATHS = { avatars: '/v1/heygen/avatars', voices: '/v1/heygen/voices' };
export const SCRIPT_MAX = 5000;
export const AUDIO_MIN_MS = 1000, AUDIO_MAX_MS = 600_000, AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const QUOTE_MIN_SECONDS = 60; // lanehub pricing.MinOutputSeconds
// HeyGen 拉取的是我们 R2 的 1 小时预签名 GET（公网可达）。
// TODO(heygen): 若生产上 HeyGen 拉不到预签名 URL（download_failed），打开 HEYGEN_UPLOAD_ASSETS，
// 由 lanehub 先把素材传到 HeyGen 的 asset API 再用 asset_id 提交（lanehub 侧待实现）。
export const heygenUploadAssets = (env = process.env) => env.HEYGEN_UPLOAD_ASSETS === '1';

export const AVATAR_MODES = ['avatar', 'talking_photo'];
const PHOTO_TYPES = ['image/png', 'image/jpeg'];
export const isAvatarPhotoType = (type) => PHOTO_TYPES.includes(type);

// ── 目录：lanehub /api/catalog 的一个型号 → {mode, avatar} ──
// 已确认字段：m.mode、m.inputs {required, one_of, required_with, max_length}、params.const.type、params.passthrough/fields。
// 缺提示时的回退（老版本 lanehub）：params.const.type → passthrough/fields 推断 → 型号 id。
// engine：lanehub 用独立型号 heygen-avatar-iii 钉 Avatar III（不收 engine 参数），所以按 const.engine.type 或 id 后缀判。
const CONST_MODE = { avatar: 'avatar', image: 'talking_photo', cinematic_avatar: 'cinematic_avatar', studio: 'studio' };
export function avatarCatalogSpec(m) {
  const p = m.params ?? {}, pass = p.passthrough ?? [], fields = (p.fields ?? []).filter((f) => !f.unsupported).map((f) => f.field);
  const inputs = m.inputs ?? {};
  let mode = m.mode ?? CONST_MODE[p.const?.type];
  if (!mode && /^heygen-/.test(m.id)) {
    if (pass.includes('scenes')) mode = 'studio';
    else if (pass.includes('avatar_id')) mode = pass.includes('script') ? 'avatar' : 'cinematic_avatar';
    else if (pass.includes('script') && fields.includes('image_urls')) mode = 'talking_photo';
    else mode = { 'heygen-image': 'talking_photo', 'heygen-studio': 'studio', 'heygen-cinematic-avatar': 'cinematic_avatar' }[m.id]
      ?? (/^heygen-avatar/.test(m.id) ? 'avatar' : undefined);
  }
  if (!mode) return {};
  if (!AVATAR_MODES.includes(mode)) return { mode };
  const engineType = p.const?.engine?.type;
  const engine = engineType ? String(engineType).replace(/^avatar_/, '') : /-iii$/.test(m.id) ? 'iii' : 'iv';
  const oneOf = inputs.one_of ?? [], required = inputs.required ?? [];
  const voice = oneOf.length ? [...(oneOf.includes('script') ? ['script'] : []), ...(oneOf.includes('audio_url') ? ['audio'] : [])]
    : ['script', ...(fields.includes('audio_url') || !fields.length ? ['audio'] : [])];
  const source = required.includes('avatar_id') ? ['library'] : required.includes('image_urls') ? ['photo'] : [mode === 'avatar' ? 'library' : 'photo'];
  const voiceRequired = inputs.required_with ? Boolean(inputs.required_with.script?.includes('voice_id')) : mode === 'talking_photo';
  const background = [...(fields.includes('background_color') ? ['color'] : []), ...(fields.includes('background_image_url') ? ['image'] : [])];
  const max = Number(inputs.max_length?.script);
  return { mode, avatar: { source, voice,
    script: { max: max > 0 ? max : SCRIPT_MAX, voice_required: voiceRequired },
    captions: fields.includes('captions'), background, engine } };
}

// ── 形象来源 × 声音来源：校验、报价、组包共用这一个纯函数 ──
const bad = (code, message, field) => Object.assign(httpError(400, code), { fields: { message, ...(field ? { field } : {}) } });
const given = (v) => v !== undefined && v !== null && v !== '';
export const AVATAR_FIELDS = ['model', 'avatar_id', 'photo_asset_id', 'script', 'voice_id', 'audio_asset_id', 'captions',
  'background_color', 'background_asset_id', 'aspect_ratio', 'resolution'];

export function avatarChoice(body, spec) {
  const { mode, avatar } = spec;
  const extra = Object.keys(body).find((k) => !AVATAR_FIELDS.includes(k) && body[k] !== undefined);
  if (extra === 'prompt') throw bad('avatar_prompt_not_supported', '数字人不收 prompt：念的文字放 script（配 voice_id），或改用 audio_asset_id 上传录音', 'prompt');
  if (extra) throw bad('unsupported_parameter', `数字人不支持参数 ${extra.slice(0, 64)}`, extra.slice(0, 64));
  const hasAvatar = given(body.avatar_id), hasPhoto = given(body.photo_asset_id);
  if (hasAvatar && hasPhoto) throw bad('avatar_source_conflict', '形象只能选一个：avatar_id（形象库数字人）或 photo_asset_id（你的照片），不要同时给', 'avatar_id|photo_asset_id');
  const want = mode === 'avatar' ? 'avatar_id（形象库数字人）' : 'photo_asset_id（PNG/JPEG 人像照片）';
  if (!hasAvatar && !hasPhoto) throw bad('avatar_source_required', `缺少形象：该型号需要 ${want}`, mode === 'avatar' ? 'avatar_id' : 'photo_asset_id');
  const source = hasAvatar ? 'library' : 'photo';
  if (!avatar.source.includes(source)) {
    throw bad('avatar_source_unsupported', `该型号不收 ${hasAvatar ? 'avatar_id' : 'photo_asset_id'}，需要 ${want}；${hasAvatar ? '用照片请选照片数字人型号' : '用形象库数字人请选 avatar 型号'}`,
      hasAvatar ? 'avatar_id' : 'photo_asset_id');
  }
  if (hasAvatar && (typeof body.avatar_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(body.avatar_id))) throw bad('invalid_avatar_id', 'avatar_id 格式不对', 'avatar_id');
  const hasScript = given(body.script), hasAudio = given(body.audio_asset_id);
  if (hasScript && hasAudio) throw bad('avatar_voice_conflict', '声音只能选一个：script（文字 + voice_id 朗读）或 audio_asset_id（上传的录音），不要同时给', 'script|audio_asset_id');
  if (!hasScript && !hasAudio) throw bad('avatar_voice_required', '缺少声音：给 script（配 voice_id）或 audio_asset_id（上传的录音）', 'script|audio_asset_id');
  const voice = hasScript ? 'script' : 'audio';
  if (!avatar.voice.includes(voice)) throw bad('avatar_voice_unsupported', `该型号不支持 ${hasScript ? 'script' : 'audio_asset_id'}，请改用 ${avatar.voice.map((v) => v === 'script' ? 'script' : 'audio_asset_id').join(' / ')}`);
  if (hasScript) {
    if (typeof body.script !== 'string' || !body.script.trim()) throw bad('invalid_script', 'script 必须是非空文本', 'script');
    if ([...body.script].length > avatar.script.max) throw bad('script_too_long', `script 超长：上限 ${avatar.script.max} 字，收到 ${[...body.script].length}；长内容请改用 audio_asset_id 上传录音`, 'script');
    if (given(body.voice_id) && (typeof body.voice_id !== 'string' || body.voice_id.length > 200)) throw bad('invalid_voice_id', 'voice_id 格式不对', 'voice_id');
    if (avatar.script.voice_required && !given(body.voice_id)) throw bad('voice_id_required', '照片数字人用 script 时必须选 voice_id；或改用 audio_asset_id 上传录音', 'voice_id');
  } else if (given(body.voice_id)) throw bad('avatar_voice_conflict', '用录音（audio_asset_id）时不要再给 voice_id', 'voice_id');
  if (body.captions !== undefined && typeof body.captions !== 'boolean') throw bad('invalid_captions', 'captions 必须是 true / false', 'captions');
  if (body.captions === true && !avatar.captions) throw bad('captions_unsupported', '该型号不支持字幕', 'captions');
  const hasColor = given(body.background_color), hasBgImage = given(body.background_asset_id);
  if (hasColor && hasBgImage) throw bad('background_conflict', '背景只能选一个：background_color（#RRGGBB）或 background_asset_id（背景图）', 'background_color|background_asset_id');
  if (hasColor && (typeof body.background_color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.background_color))) throw bad('invalid_background_color', 'background_color 必须是 #RRGGBB', 'background_color');
  const background = hasColor ? 'color' : hasBgImage ? 'image' : null;
  if (background && !avatar.background.includes(background)) throw bad('background_unsupported', `该型号不支持${background === 'color' ? '纯色' : '图片'}背景`);
  return { source, voice, background };
}

// ── Bearer 客户端（桌面端 / API 用户）直接用 lanehub 字段名：URL 替素材 id，规则仍由 avatarChoice 判 ──
const LANE_NAMES = { photo_asset_id: 'image_urls', audio_asset_id: 'audio_url', background_asset_id: 'background_image_url' };
const httpUrl = (v) => typeof v === 'string' && v.length <= 4000 && /^https?:\/\/\S+$/.test(v);
export function avatarLaneRequest(body, spec) {
  const { stream, image_urls, audio_url, background_image_url, ...rest } = body;
  if (image_urls !== undefined && !(Array.isArray(image_urls) && image_urls.length === 1 && httpUrl(image_urls[0]))) {
    throw bad('invalid_image_urls', 'image_urls 只收 1 个 http(s) 人像照片 URL（PNG/JPEG）', 'image_urls');
  }
  for (const [k, v] of [['audio_url', audio_url], ['background_image_url', background_image_url]]) if (v !== undefined && !httpUrl(v)) throw bad('invalid_' + k, `${k} 必须是 http(s) URL`, k);
  try {
    return avatarChoice({ ...rest, photo_asset_id: image_urls?.[0], audio_asset_id: audio_url, background_asset_id: background_image_url }, spec);
  } catch (e) {
    const rename = (s) => s.replace(/photo_asset_id|audio_asset_id|background_asset_id/g, (m) => LANE_NAMES[m]);
    if (e.fields) e.fields = { ...e.fields, message: rename(e.fields.message), ...(e.fields.field ? { field: rename(e.fields.field) } : {}) };
    throw e;
  }
}

// ── 草稿（发送队列 / 模板）：同一套 avatarChoice 规则，但「缺什么」记成 issue 不拒绝 ──
// 缺项码 → 补一个占位值继续判，这样后面的格式错（script 超长、背景冲突…）不会被「缺形象」挡住。
export const AVATAR_ITEM_FIELDS = ['avatar_id', 'photo_asset_id', 'script', 'voice_id', 'audio_asset_id', 'captions', 'background_color', 'background_asset_id'];
export const AVATAR_ASSET_FIELDS = { photo_asset_id: 'photo', audio_asset_id: 'audio', background_asset_id: 'background' };
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const DRAFT_GAPS = {
  avatar_source_required: (b, { avatar }) => (avatar.source[0] === 'library' ? { avatar_id: 'draft' } : { photo_asset_id: PLACEHOLDER }),
  avatar_voice_required: (b, { avatar }) => (avatar.voice[0] === 'script' ? { script: 'draft', ...(given(b.voice_id) ? {} : { voice_id: 'draft' }) } : { audio_asset_id: PLACEHOLDER }),
  voice_id_required: () => ({ voice_id: 'draft' }),
};
// fields: 只含 AVATAR_ITEM_FIELDS（模板里的 {slot} 已换成占位 id）。返回缺项 issues；格式错直接抛（与生成同码）。
export function avatarDraftIssues(model, fields, spec) {
  let b = { model, ...fields };
  const issues = [];
  for (let i = 0; i < 4; i++) {
    try { avatarChoice(b, spec); return issues; } catch (e) {
      const fill = DRAFT_GAPS[e.code];
      if (!fill) throw e;
      issues.push({ code: e.code, field: e.fields.field ?? null, message: e.fields.message });
      b = { ...b, ...fill(b, spec) };
    }
  }
  return issues;
}
export const AVATAR_SLOT_PLACEHOLDER = PLACEHOLDER;

// ── 组 lanehub 请求体：每一侧只发一个字段 ──
// urls: {photo, audio, background}（已解析的预签名 URL）；duration: 报价时带上服务端测得的秒数。
export function avatarUpstreamBody(body, choice, urls = {}, { duration, uploadAssets = heygenUploadAssets() } = {}) {
  const out = { model: body.model };
  if (choice.source === 'library') out[LANE.avatarId] = body.avatar_id; else out[LANE.image] = [urls.photo];
  if (choice.voice === 'script') {
    out[LANE.script] = body.script;
    if (given(body.voice_id)) out[LANE.voiceId] = body.voice_id;
  } else out[LANE.audioUrl] = urls.audio;
  if (typeof body.captions === 'boolean') out[LANE.captions] = body.captions;
  if (choice.background === 'color') out[LANE.backgroundColor] = body.background_color;
  if (choice.background === 'image') out[LANE.backgroundImageUrl] = urls.background;
  for (const k of ['aspect_ratio', 'resolution']) if (body[k] !== undefined) out[k] = body[k];
  if (duration !== undefined) out[LANE.duration] = duration;
  if (uploadAssets) out[LANE.uploadAssets] = true;
  return out;
}

// ── 上游错误 → 用户错误 ──
// lanehub 的用户侧码（errors.go userSideCodes / userMessages、canonical constraint_violation）原样透传给官网（按码引导授权 / 改内容），
// 只补中文说明；「没有人脸」HeyGen 没有独立码，按原文识别成网关自己的 avatar_photo_no_face。
const MESSAGES = {
  avatar_consent_required: '该数字人需要先完成肖像授权，请换一个已授权的数字人',
  content_policy_violation: '内容未通过审核（脚本、照片或录音），请修改后重试',
  avatar_not_found: '数字人不存在或不可用，请重新选择',
  voice_not_found: '音色不存在，请换一个音色',
  voice_not_usable: '该音色当前不可用，请换一个音色',
  script_too_short: '脚本太短，合成语音至少要 1 秒',
  tts_text_invalid: '脚本无法合成语音，请检查文本内容',
  download_failed: '上游拉取照片 / 录音失败，请稍后重试',
  invalid_parameter: '请求参数不合法',
  constraint_violation: '参数组合不合该型号的约束',
};
const ENGINE = { code: 'avatar_engine_unavailable', field: 'avatar_id', message: '该数字人不支持 Avatar III 引擎，请换一个数字人或改用 Avatar IV 型号' };
const FACE = { code: 'avatar_photo_no_face', message: '照片里没有识别到清晰人脸，请上传正脸、光线充足的 PNG/JPEG 人像照片' };
// code/text/field 来自 lanehub 错误体；返回 null = 不是可识别的用户侧错误（按 upstream_http_* 处理）。
export function avatarErrorFor(code, text = '', field) {
  const c = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
  const t = String(text ?? '');
  if (/face/i.test(t) || (c && c.includes('face'))) return FACE;
  // Avatar III：HeyGen 没有独立码，形象不支持该引擎时按原文（avatar_iii / engine）识别；客户端自带 engine 参数被拒（field=engine）不算。
  if (field !== 'engine' && (/avatar[_ ]?iii|engine/i.test(t) || (c && c.includes('engine')))) return ENGINE;
  const withField = typeof field === 'string' && /^[a-z_|]{1,64}$/.test(field) ? { field } : {};
  if (c && MESSAGES[c]) return { code: c, message: (c === 'constraint_violation' || c === 'invalid_parameter') && t ? t.slice(0, 300) : MESSAGES[c], ...withField };
  if (/consent/i.test(t)) return { code: 'avatar_consent_required', message: MESSAGES.avatar_consent_required };
  if (/content.?policy|moderat/i.test(t)) return { code: 'content_policy_violation', message: MESSAGES.content_policy_violation };
  return null;
}
// 提交期：只接受 lanehub 返回的 4xx 用户侧错误体（{error:{code,message,field}} 或平铺）。
export const avatarSubmitError = (j) => (j ? avatarErrorFor(j.error?.code ?? j.code, j.error?.message ?? j.message, j.error?.field ?? j.field) : null);

// ── 列表项（lanehub providers/heygen/list.go 的 AvatarItem / VoiceItem；可选键缺省给 null） ──
// engines 形如 avatar_iv / avatar_iii：含 avatar_iii 的形象才能选 heygen-avatar-iii（对照 ModelSpec.avatar.engine）。
const str = (v) => (typeof v === 'string' && v ? v : null);
export function avatarItem(x) {
  return { id: String(x.id), name: str(x.name) ?? String(x.id), type: x.type === 'talking_photo' ? 'talking_photo' : 'avatar', avatar_type: str(x.avatar_type),
    gender: str(x.gender), preview_image_url: str(x.preview_image_url), preview_video_url: str(x.preview_video_url), default_voice_id: str(x.default_voice_id),
    engines: Array.isArray(x.engines) ? x.engines.filter((e) => typeof e === 'string') : [] };
}
export function voiceItem(x) {
  return { id: String(x.id), name: str(x.name) ?? String(x.id), language: str(x.language), gender: str(x.gender),
    preview_audio_url: str(x.preview_audio_url), support_pause: typeof x.support_pause === 'boolean' ? x.support_pause : null, type: str(x.type) };
}

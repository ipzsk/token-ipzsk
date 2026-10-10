import { httpError } from './security.mjs';

export async function resolveSkillCalls(db, raw, model, boundPluginId = null) {
  if (raw === undefined) return { pluginId: boundPluginId, calls: [], state: 'none' };
  let calls;
  try { calls = typeof raw === 'string' && raw.length <= 8000 ? JSON.parse(raw) : null; } catch { /* invalid marker */ }
  if (!Array.isArray(calls) || calls.length > 32 || calls.some(call => !call || typeof call !== 'object'
    || Object.keys(call).sort().join(',') !== 'content_sha256,name'
    || typeof call.name !== 'string' || call.name.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(call.name)
    || typeof call.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(call.content_sha256))
    || new Set(calls.map(call => call.name)).size !== calls.length) throw httpError(400, 'invalid_skill_calls');
  const registry = (await db.query(`SELECT s.skill_ref,p.id AS plugin_id,p.enabled AS plugin_enabled,p.allowed_models,v.content_sha256,v.enabled
    FROM plugin_skills s JOIN plugins p ON p.id=s.plugin_id LEFT JOIN commission_skill_versions v USING(skill_ref)
    WHERE s.skill_ref=ANY($1::text[])`, [calls.map(call => call.name)])).rows;
  const verified = calls.map(call => {
    const known = registry.filter(row => row.skill_ref === call.name);
    if (!known.length || known.every(row => row.content_sha256 === null)) return { ...call, plugin_id: null };
    const version = known.find(row => row.content_sha256 === call.content_sha256 && row.enabled && row.plugin_enabled);
    if (!version) throw httpError(403, 'skill_version_denied');
    if (!version.allowed_models.includes(model)) throw httpError(403, 'plugin_model_denied');
    return { ...call, plugin_id: version.plugin_id };
  });
  const plugins = [...new Set(verified.map(call => call.plugin_id).filter(Boolean))];
  if (boundPluginId && plugins.some(id => id !== boundPluginId)) throw httpError(403, 'skill_plugin_conflict');
  // Preserve all markers; multi-plugin revenue needs a reviewed allocation before any author is paid.
  return { pluginId: boundPluginId ?? (plugins.length === 1 ? plugins[0] : null), calls: verified,
    state: plugins.length > 1 ? 'ambiguous' : plugins.length === 1 ? 'attributed' : calls.length ? 'unregistered' : 'none' };
}

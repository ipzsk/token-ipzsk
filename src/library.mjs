// 画布项目（§8.6）与素材文件夹（v19 表）的用户接口。cookie 会话，别人的 id 一律 404。
import { publicAsset } from './uploads.mjs';
import { me, isUuid, fail, plainObject, addCursor, paged, body, idParam } from './studio.mjs';

export const MAX_CANVAS_NODES = 2000, MAX_CANVAS_EDGES = 10000, MAX_CANVAS_BYTES = 2_000_000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// {version,nodes,edges,groups,viewport}; nodes+groups ≤ 2000, edges ≤ 10000, compact JSON ≤ 2MB (jsonb::text adds spaces; DB cap 2.5MB).
export function validCanvasDocument(doc) {
  const bad = () => fail(400, 'invalid_canvas_document');
  if (!plainObject(doc) || !Number.isInteger(doc.version) || doc.version < 1) throw bad();
  for (const k of ['nodes', 'edges', 'groups']) if (!Array.isArray(doc[k]) || doc[k].some((x) => !plainObject(x))) throw bad();
  const v = doc.viewport;
  if (!plainObject(v) || !finite(v.x) || !finite(v.y) || !finite(v.zoom) || v.zoom <= 0) throw bad();
  if (doc.nodes.length + doc.groups.length > MAX_CANVAS_NODES) throw fail(413, 'too_many_canvas_nodes');
  if (doc.edges.length > MAX_CANVAS_EDGES) throw fail(413, 'too_many_canvas_edges');
  for (const n of [...doc.nodes, ...doc.groups]) {
    if (typeof n.id !== 'string' || !n.id.length || n.id.length > 100 || (n.data !== undefined && !plainObject(n.data))) throw bad();
  }
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_CANVAS_BYTES) throw fail(413, 'canvas_too_large');
  return doc;
}

// Media refs in node.data: asset_id, asset.id, reference_asset_ids[], results[] (ids or {id}). Anything else there is ignored.
export function canvasAssetIds(doc) {
  const ids = new Set();
  const add = (id) => { if (!isUuid(id)) throw fail(400, 'invalid_canvas_document'); ids.add(id.toLowerCase()); };
  for (const n of [...doc.nodes, ...doc.groups]) {
    const d = n.data;
    if (!plainObject(d)) continue;
    if (d.asset_id !== undefined) add(d.asset_id);
    if (d.asset !== undefined && d.asset !== null) { if (!plainObject(d.asset)) throw fail(400, 'invalid_canvas_document'); add(d.asset.id); }
    for (const field of ['reference_asset_ids', 'results']) {
      if (d[field] === undefined) continue;
      if (!Array.isArray(d[field])) throw fail(400, 'invalid_canvas_document');
      for (const x of d[field]) add(plainObject(x) ? x.id : x);
    }
  }
  return [...ids];
}

export function libraryRoutes(app, { db, imageStorage: storage }) {
  // ── 画布 ──
  const thumbOut = (row) => !row.thumb_key ? null : storage
    ? publicAsset({ id: row.thumb_id, kind: 'image', source: row.thumb_source, status: 'ready', object_key: row.thumb_key, variants: row.thumb_variants,
      width: row.thumb_width, height: row.thumb_height, duration_ms: row.thumb_duration_ms, created_at: row.thumb_created_at, thumb_state: row.thumb_state }, storage)
    : { id: row.thumb_id, urls: {} };
  const projectOut = (row, withDocument) => ({ id: row.id, title: row.title, revision: row.revision, thumb_id: row.thumb_id, thumb: thumbOut(row),
    created_at: row.created_at, updated_at: row.updated_at, ...(withDocument ? { document: row.document } : {}) });
  const select = (doc) => `SELECT p.id,p.title,p.revision,p.thumb_id,p.created_at,p.updated_at,p.updated_at::text AS cursor_at${doc ? ',p.document' : ''},
      a.object_key AS thumb_key,a.variants AS thumb_variants,a.width AS thumb_width,a.height AS thumb_height,a.source AS thumb_source,a.thumb_state,a.duration_ms AS thumb_duration_ms,a.created_at AS thumb_created_at
    FROM canvas_projects p LEFT JOIN media_assets a ON a.id=p.thumb_id AND a.status='ready'`;
  const oneProject = async (userId, id) => {
    const row = (await db.query(`${select(true)} WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`, [idParam(id, 'canvas_not_found'), userId])).rows[0];
    if (!row) throw fail(404, 'canvas_not_found');
    return row;
  };
  const title = (v, fallback) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || v.length > 80) throw fail(400, 'invalid_title');
    return v;
  };
  // 本人的资产（含已软删：删素材不该让画布再也存不上）或公开案例资产。
  async function checkAssets(userId, doc) {
    const ids = canvasAssetIds(doc);
    if (!ids.length) return;
    const found = (await db.query(`SELECT count(*)::int AS n FROM media_assets WHERE id=ANY($1::uuid[]) AND (user_id=$2 OR (user_id IS NULL AND source='case'))`,
      [ids, userId])).rows[0].n;
    if (found !== ids.length) throw fail(422, 'canvas_asset_forbidden');
  }
  const tooLarge = (e) => { if (e.code === '23514') throw fail(413, 'canvas_too_large'); throw e; };
  const big = { bodyLimit: 2_600_000 };

  app.get('/api/me/canvas', async (req) => {
    const args = [me(req)], where = ['p.user_id=$1', 'p.deleted_at IS NULL'];
    addCursor(req.query, where, args, 'p.updated_at', 'p.id');
    return paged((await db.query(`${select(false)} WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC,p.id DESC LIMIT 51`, args)).rows,
      (r) => projectOut(r, false));
  });
  app.post('/api/me/canvas', big, async (req) => {
    const userId = me(req), b = body(req);
    if (b.id !== undefined && !isUuid(b.id)) throw fail(400, 'invalid_id'); // 前端本地先建 id
    const doc = validCanvasDocument(b.document);
    await checkAssets(userId, doc);
    const { id } = (await db.query(`INSERT INTO canvas_projects(id,user_id,title,document) VALUES(coalesce($1::uuid,gen_random_uuid()),$2,$3,$4) RETURNING id`,
      [b.id ?? null, userId, title(b.title, '未命名画布'), JSON.stringify(doc)]).catch(tooLarge)).rows[0];
    return projectOut(await oneProject(userId, id), true);
  });
  app.get('/api/me/canvas/:id', async (req) => projectOut(await oneProject(me(req), req.params.id), true));
  app.put('/api/me/canvas/:id', big, async (req, reply) => {
    const userId = me(req), b = body(req), current = await oneProject(userId, req.params.id);
    if (!Number.isInteger(b.revision) || b.revision < 1) throw fail(400, 'invalid_revision');
    const doc = validCanvasDocument(b.document);
    await checkAssets(userId, doc);
    const saved = await db.query(`UPDATE canvas_projects SET title=$4,document=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND revision=$3`,
    [current.id, userId, b.revision, title(b.title, current.title), JSON.stringify(doc)]).catch(tooLarge);
    if (!saved.rowCount) {
      return reply.code(409).send({ error: { code: 'canvas_conflict', message: 'canvas_conflict' }, project: projectOut(await oneProject(userId, current.id), true) });
    }
    return projectOut(await oneProject(userId, current.id), true);
  });
  app.delete('/api/me/canvas/:id', async (req, reply) => {
    const r = await db.query('UPDATE canvas_projects SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [idParam(req.params.id, 'canvas_not_found'), me(req)]);
    if (!r.rowCount) throw fail(404, 'canvas_not_found');
    return reply.code(204).send();
  });
  app.post('/api/me/canvas/:id/thumb', async (req) => {
    const userId = me(req), { asset_id } = body(req), project = await oneProject(userId, req.params.id);
    if (asset_id !== null && (!isUuid(asset_id) || !(await db.query(`SELECT 1 FROM media_assets WHERE id=$1 AND user_id=$2 AND status='ready' AND kind='image'`,
      [asset_id, userId])).rowCount)) throw fail(422, 'canvas_asset_forbidden');
    await db.query('UPDATE canvas_projects SET thumb_id=$2 WHERE id=$1', [project.id, asset_id]);
    return projectOut(await oneProject(userId, project.id), false);
  });

  // ── 素材文件夹 ──
  const folderOut = ({ id, name, position, count, created_at }) => ({ id, name, position, count: count ?? 0, created_at });
  const folderSelect = `SELECT f.*,(SELECT count(*)::int FROM asset_folder_items i JOIN media_assets a ON a.id=i.asset_id
      WHERE i.folder_id=f.id AND a.status<>'deleted') AS count FROM asset_folders f`;
  const oneFolder = async (userId, id) => {
    const row = (await db.query(`${folderSelect} WHERE f.id=$1 AND f.user_id=$2`, [idParam(id, 'folder_not_found'), userId])).rows[0];
    if (!row) throw fail(404, 'folder_not_found');
    return row;
  };
  const folderName = (v) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > 60) throw fail(400, 'invalid_name'); return v.trim(); };
  const nameTaken = (e) => { if (e.code === '23505') throw fail(409, 'folder_name_taken'); throw e; };

  app.get('/api/me/folders', async (req) => ({
    items: (await db.query(`${folderSelect} WHERE f.user_id=$1 ORDER BY f.position,f.created_at,f.id`, [me(req)])).rows.map(folderOut) }));
  app.post('/api/me/folders', async (req) => {
    const userId = me(req), b = body(req);
    if (b.position !== undefined && !finite(b.position)) throw fail(400, 'invalid_position');
    // Default position: after the last folder.
    const row = (await db.query(`INSERT INTO asset_folders(user_id,name,position)
      VALUES($1,$2,coalesce($3,(SELECT coalesce(max(position),0)+1 FROM asset_folders WHERE user_id=$1))) RETURNING *`,
    [userId, folderName(b.name), b.position ?? null]).catch(nameTaken)).rows[0];
    return folderOut(row);
  });
  app.patch('/api/me/folders/:id', async (req) => {
    const userId = me(req), b = body(req), row = await oneFolder(userId, req.params.id);
    if (b.position !== undefined && !finite(b.position)) throw fail(400, 'invalid_position');
    await db.query('UPDATE asset_folders SET name=$2,position=$3 WHERE id=$1',
      [row.id, b.name === undefined ? row.name : folderName(b.name), b.position ?? row.position]).catch(nameTaken);
    return folderOut(await oneFolder(userId, row.id));
  });
  app.delete('/api/me/folders/:id', async (req, reply) => {
    const r = await db.query('DELETE FROM asset_folders WHERE id=$1 AND user_id=$2', [idParam(req.params.id, 'folder_not_found'), me(req)]);
    if (!r.rowCount) throw fail(404, 'folder_not_found');
    return reply.code(204).send(); // memberships cascade; assets stay
  });
  app.put('/api/me/folders/:id/items', async (req) => {
    const userId = me(req), { asset_ids: ids } = body(req), folder = await oneFolder(userId, req.params.id);
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((x) => !isUuid(x))) throw fail(400, 'invalid_asset_ids');
    const unique = [...new Set(ids.map((x) => x.toLowerCase()))];
    await db.tx(async (c) => {
      const owned = (await c.query(`SELECT count(*)::int AS n FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status<>'deleted'`, [unique, userId])).rows[0].n;
      if (owned !== unique.length) throw fail(422, 'asset_not_owned');
      // Append in request order after the current last item; existing memberships keep their position.
      await c.query(`INSERT INTO asset_folder_items(folder_id,asset_id,position)
        SELECT $1,x.id,(SELECT coalesce(max(position),0) FROM asset_folder_items WHERE folder_id=$1)+x.n
        FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id,n) ON CONFLICT DO NOTHING`, [folder.id, unique]);
    });
    return { count: (await oneFolder(userId, folder.id)).count };
  });
  app.delete('/api/me/folders/:id/items/:assetId', async (req, reply) => {
    const folder = await oneFolder(me(req), req.params.id);
    await db.query('DELETE FROM asset_folder_items WHERE folder_id=$1 AND asset_id=$2', [folder.id, idParam(req.params.assetId, 'asset_not_found')]);
    return reply.code(204).send();
  });
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'GET /api/me/canvas': { query: 'cursor', response: 'Page<CanvasProjectSummary>' },
  'POST /api/me/canvas': { body: 'CanvasCreate', response: 'CanvasProject' },
  'GET /api/me/canvas/:id': { response: 'CanvasProject' },
  'PUT /api/me/canvas/:id': { body: 'CanvasPut', response: 'CanvasProject', conflict: 'CanvasConflict' },
  'DELETE /api/me/canvas/:id': { response: 'Empty' },
  'POST /api/me/canvas/:id/thumb': { body: 'CanvasThumbPost', response: 'CanvasProjectSummary' },
  'GET /api/me/folders': { response: 'FolderList' },
  'POST /api/me/folders': { body: 'FolderCreate', response: 'Folder' },
  'PATCH /api/me/folders/:id': { body: 'FolderPatch', response: 'Folder' },
  'DELETE /api/me/folders/:id': { response: 'Empty' },
  'PUT /api/me/folders/:id/items': { body: 'FolderItemsPut', response: 'FolderItemsResult' },
  'DELETE /api/me/folders/:id/items/:assetId': { response: 'Empty' },
};

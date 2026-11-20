import { getStore } from '@netlify/blobs';
const CH = 4 * 1024 * 1024;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const hash = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clean = s => String(s || '').replace(/[^\w-]/g, '');
async function rm(store, id) {
  const m = await store.get('f/' + id + '/meta', { type: 'json' });
  if (!m) return;
  for (let i = 0; i < m.n; i++) await store.delete('f/' + id + '/' + i);
  await store.delete('f/' + id + '/meta');
}
export default async (req) => {
  const store = getStore('you'), u = new URL(req.url);
  const p = u.pathname.replace(/^\/api\/?/, '').split('/');
  const cid = req.headers.get('x-cid') || '', me = cid ? await hash(cid) : '';
  try {
    if (p[0] === 'list') {
      const kind = u.searchParams.get('kind') === 'clips' ? 'clips' : 'tracks';
      const { blobs } = await store.list({ prefix: 'm/' + kind + '/' });
      const r = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
      return J(r.filter(Boolean).sort((a, b) => b.t - a.t).map(({ owner, ...x }) => ({ ...x, mine: !!me && owner === me })));
    }
    if (p[0] === 'init' && req.method === 'POST') {
      const b = await req.json();
      const n = Math.max(1, Math.min(10, +b.n || 1)), size = +b.size || 0;
      if (size > 40 * 1024 * 1024) return J({ e: 'big' }, 413);
      let type = String(b.type || '');
      if (!/^(audio|video|image)\/[\w.+-]+$/.test(type) || /svg/.test(type)) type = 'application/octet-stream';
      const id = rid();
      await store.setJSON('f/' + id + '/meta', { size, type, n });
      return J({ id });
    }
    if (p[0] === 'file') {
      const id = clean(p[1]);
      if (req.method === 'PUT') {
        const m = await store.get('f/' + id + '/meta', { type: 'json' }), i = +p[2];
        if (!m || !(i >= 0 && i < m.n)) return J({ e: 'bad' }, 400);
        await store.set('f/' + id + '/' + i, await req.arrayBuffer());
        return J({ ok: 1 });
      }
      const m = await store.get('f/' + id + '/meta', { type: 'json' });
      if (!m) return new Response('no', { status: 404 });
      const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
      let s = rg && rg[1] ? +rg[1] : 0, e = rg && rg[2] ? +rg[2] : m.size - 1;
      e = Math.min(e, m.size - 1);
      const ci = Math.floor(s / CH);
      e = Math.min(e, (ci + 1) * CH - 1);
      const buf = await store.get('f/' + id + '/' + ci, { type: 'arrayBuffer' });
      if (!buf) return new Response('no', { status: 404 });
      const part = buf.slice(s - ci * CH, e - ci * CH + 1);
      const full = !rg && m.n === 1;
      return new Response(part, {
        status: full ? 200 : 206,
        headers: { 'content-type': m.type, 'accept-ranges': 'bytes', 'content-length': String(part.byteLength), 'x-content-type-options': 'nosniff', 'cache-control': 'public,max-age=31536000', ...(full ? {} : { 'content-range': `bytes ${s}-${e}/${m.size}` }) }
      });
    }
    if (p[0] === 'add' && req.method === 'POST') {
      if (!me) return J({ e: 'cid' }, 400);
      const b = await req.json(), kind = b.kind === 'clips' ? 'clips' : 'tracks', id = rid();
      await store.setJSON('m/' + kind + '/' + id, { id, name: String(b.name || 'Без названия').slice(0, 120), fileId: clean(b.fileId), coverId: clean(b.coverId), t: Date.now(), owner: me });
      return J({ id });
    }
    if ((p[0] === 'update' || p[0] === 'delete') && req.method === 'POST') {
      const b = await req.json(), kind = b.kind === 'clips' ? 'clips' : 'tracks', key = 'm/' + kind + '/' + clean(b.id);
      const m = await store.get(key, { type: 'json' });
      if (!m) return J({ e: 'no' }, 404);
      const adm = process.env.ADMIN_KEY && req.headers.get('x-admin') === process.env.ADMIN_KEY;
      if (!adm && (!me || m.owner !== me)) return J({ e: 'forbidden' }, 403);
      if (p[0] === 'update') {
        if (m.coverId) await rm(store, m.coverId);
        m.coverId = clean(b.coverId);
        await store.setJSON(key, m);
        return J({ ok: 1 });
      }
      await store.delete(key);
      await rm(store, m.fileId);
      if (m.coverId) await rm(store, m.coverId);
      return J({ ok: 1 });
    }
    return J({ e: 'not found' }, 404);
  } catch (err) {
    return J({ e: String(err && err.message || err) }, 500);
  }
};
export const config = { path: '/api/*' };

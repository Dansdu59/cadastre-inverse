// GET /api/parcelles-libres?insee=53130&min=800&cats=U,AU
//   Parcelles NON BÂTIES d'au moins `min` m² dont le centroïde tombe dans une
//   zone du PLU de catégorie demandée (U, AU par défaut).
//
//   -> { insee, hasPlu, min, cats, examined, built, matched, features:[...] }

import zlib from 'node:zlib';
import { geomContains, geomBbox, geomCentroid, deptDir, iduOf } from '../lib/geo.js';
import { getPluZones } from '../lib/plu.js';

const MAX_FEATURES = 4000;
const MAX_BYTES = 4 * 1024 * 1024;

async function fetchGeojsonGz(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let txt;
  try { txt = zlib.gunzipSync(buf).toString('utf8'); }
  catch { txt = buf.toString('utf8'); }
  return JSON.parse(txt);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const insee = String(req.query.insee || '').trim().toUpperCase();
  if (!/^(\d{5}|2[AB]\d{3})$/.test(insee)) {
    res.status(400).json({ error: 'Paramètre "insee" invalide.' });
    return;
  }
  const minSurf = Math.max(0, Number(req.query.min) || 0);
  const cats = String(req.query.cats || 'U,AU')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  try {
    const dep = deptDir(insee);
    const base = `https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/${dep}/${insee}`;
    const [parc, bat, plu] = await Promise.all([
      fetchGeojsonGz(`${base}/cadastre-${insee}-parcelles.json.gz`),
      fetchGeojsonGz(`${base}/cadastre-${insee}-batiments.json.gz`).catch(() => null),
      getPluZones(insee),
    ]);

    if (!parc || !parc.features || !parc.features.length) {
      res.status(502).json({ error: 'Parcelles indisponibles pour cette commune.' });
      return;
    }
    if (!plu.hasPlu) {
      res.status(200).json({
        insee, nom: plu.nom, hasPlu: false, min: minSurf, cats, features: [],
        message: "Aucun zonage PLU numérisé pour cette commune (RNU ou document non versé au Géoportail de l'Urbanisme). Le filtre U/AU n'est pas applicable.",
      });
      return;
    }

    // 1) parcelles candidates (surface mini)
    const parcelles = parc.features.filter((f) => (f.properties && f.properties.contenance || 0) >= minSurf);
    const CELL = 0.0025; // ~180 m — grille d'indexation
    const gkey = (gx, gy) => gx + ':' + gy;
    const grid = new Map();
    parcelles.forEach((f, idx) => {
      f._bb = geomBbox(f.geometry);
      f._c = geomCentroid(f.geometry);
      for (let gx = Math.floor(f._bb[0] / CELL); gx <= Math.floor(f._bb[2] / CELL); gx++) {
        for (let gy = Math.floor(f._bb[1] / CELL); gy <= Math.floor(f._bb[3] / CELL); gy++) {
          const k = gkey(gx, gy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(idx);
        }
      }
    });

    // 2) marque les parcelles bâties (un bâtiment "en dur" dont le centroïde est dans la parcelle)
    const built = new Set();
    const buildings = (bat && bat.features) || [];
    for (const b of buildings) {
      const t = b.properties && b.properties.type;
      if (t && t !== '01' && t !== '03') continue; // 01 = dur, 03 = à cheval ; on ignore 02 (léger)
      const bc = geomCentroid(b.geometry);
      const cand = grid.get(gkey(Math.floor(bc[0] / CELL), Math.floor(bc[1] / CELL))) || [];
      for (const idx of cand) {
        if (built.has(idx)) continue;
        const f = parcelles[idx];
        if (bc[0] < f._bb[0] || bc[0] > f._bb[2] || bc[1] < f._bb[1] || bc[1] > f._bb[3]) continue;
        if (geomContains(f.geometry, bc[0], bc[1])) built.add(idx);
      }
    }

    // 3) zones du PLU retenues
    const zones = plu.zones.filter((z) => cats.includes(z.cat));

    // 4) parcelles non bâties dont le centroïde est dans une zone retenue
    const out = [];
    parcelles.forEach((f, idx) => {
      if (built.has(idx)) return;
      const [cx, cy] = f._c;
      let hit = null;
      for (const z of zones) {
        const bb = z.bbox;
        if (cx < bb[0] || cx > bb[2] || cy < bb[1] || cy > bb[3]) continue;
        if (geomContains(z.geometry, cx, cy)) { hit = z; break; }
      }
      if (!hit) return;
      out.push({
        type: 'Feature',
        geometry: { type: f.geometry.type, coordinates: f.geometry.coordinates },
        properties: {
          idu: iduOf(f.properties),
          contenance: f.properties.contenance,
          zone: hit.libelle,
          zone_long: hit.libelong,
          typezone: hit.typezone,
          cat: hit.cat,
        },
      });
    });
    out.sort((a, b) => b.properties.contenance - a.properties.contenance);

    const stats = { examined: parcelles.length, built: built.size, matched: out.length };
    let features = out;
    if (features.length > MAX_FEATURES) features = features.slice(0, MAX_FEATURES);

    let body = JSON.stringify({
      insee, nom: plu.nom, hasPlu: true, min: minSurf, cats,
      examined: stats.examined, built: stats.built, matched: stats.matched,
      returned: features.length,
      features,
    });
    if (Buffer.byteLength(body) > MAX_BYTES) {
      features = features.slice(0, Math.max(200, Math.floor(features.length / 2)));
      body = JSON.stringify({
        insee, nom: plu.nom, hasPlu: true, min: minSurf, cats,
        examined: stats.examined, built: stats.built, matched: stats.matched,
        returned: features.length, truncated: true, features,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).json({ error: e && e.message ? `Erreur : ${e.message}` : 'Erreur inconnue.' });
  }
}

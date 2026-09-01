// Proxy serverless : récupère les parcelles cadastrales d'une commune côté serveur
// (où CORS ne s'applique pas), filtre par surface, et renvoie un GeoJSON allégé.
//
// Source principale : cadastre.data.gouv.fr (export Etalab, un fichier .json.gz par commune,
//   bien plus rapide que la pagination IGN sur les grandes communes).
// Secours : apicarto.ign.fr (pagination) si le fichier Etalab est absent.
//
// GET /api/parcelles?insee=53130&min=500&max=1000
//   -> { type:"FeatureCollection", source, total, matched, features:[...] }

import zlib from 'node:zlib';

const MEM_TTL_MS = 30 * 60 * 1000; // cache mémoire par instance chaude
const MEM_MAX = 25;
const MAX_FEATURES = 20000; // garde-fou : au-delà, on demande de resserrer la fourchette
const MAX_BYTES = 4 * 1024 * 1024; // limite de corps de réponse Vercel (~4,5 Mo)

/** insee -> { ts, source, parcelles: Feature[] } */
const cache = new Map();

// Villes à arrondissements municipaux : pas de fichier au niveau commune,
// il faut fusionner les fichiers d'arrondissement.
const PLM = {
  '75056': intRange(75101, 75120), // Paris
  '13055': intRange(13201, 13216), // Marseille
  '69123': intRange(69381, 69389), // Lyon
};
function intRange(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(String(i));
  return out;
}

// Répertoire "département" dans l'arborescence Etalab.
function deptDir(insee) {
  if (/^2[AB]/i.test(insee)) return insee.slice(0, 2).toUpperCase(); // Corse : 2A / 2B
  if (/^9[78]\d/.test(insee)) return insee.slice(0, 3); // DROM : 971..976, 977, 978
  return insee.slice(0, 2);
}

function etalabUrl(insee) {
  return `https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/${deptDir(insee)}/${insee}/cadastre-${insee}-parcelles.json.gz`;
}

async function fetchEtalabCommune(insee) {
  const res = await fetch(etalabUrl(insee), { redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`cadastre.data.gouv.fr a répondu ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  try {
    text = zlib.gunzipSync(buf).toString('utf8');
  } catch {
    text = buf.toString('utf8'); // au cas où le corps serait déjà décompressé
  }
  const fc = JSON.parse(text);
  return fc.features || [];
}

async function fetchEtalab(insee) {
  if (PLM[insee]) {
    const parts = await Promise.all(
      PLM[insee].map((c) => fetchEtalabCommune(c).catch(() => null))
    );
    const merged = parts.filter(Boolean).flat();
    return merged.length ? merged : null;
  }
  return fetchEtalabCommune(insee);
}

async function fetchIgn(insee) {
  const limit = 1000;
  const all = [];
  for (let start = 0; start < 300000; start += limit) {
    const url =
      `https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=${encodeURIComponent(insee)}` +
      `&_limit=${limit}&_start=${start}`;
    let res;
    try {
      res = await fetch(url);
    } catch {
      break;
    }
    if (!res.ok) break;
    const data = await res.json();
    const feats = (data && data.features) || [];
    all.push(...feats);
    if (feats.length < limit) break;
  }
  return all;
}

function pad(value, n) {
  const s = String(value == null ? '' : value);
  return s.length >= n ? s : '0'.repeat(n - s.length) + s;
}

// Référence cadastrale complète (14 caractères) quelle que soit la source.
function getIdu(p) {
  if (!p) return '';
  if (p.idu) return String(p.idu).toUpperCase();
  if (p.id && /^[0-9A-Za-z]{10,15}$/.test(String(p.id))) return String(p.id).toUpperCase();
  const insee = p.code_insee || p.commune || '';
  const prefixe = pad(p.com_abs != null ? p.com_abs : p.prefixe != null ? p.prefixe : '000', 3);
  return (insee + prefixe + pad(p.section, 2) + pad(p.numero, 4)).toUpperCase();
}

// Arrondi des coordonnées à 6 décimales (~0,1 m) pour alléger la réponse.
function round6(coords) {
  if (typeof coords[0] === 'number') {
    return [Math.round(coords[0] * 1e6) / 1e6, Math.round(coords[1] * 1e6) / 1e6];
  }
  return coords.map(round6);
}

function normalize(f) {
  const p = f.properties || {};
  let geometry = f.geometry || null;
  if (geometry && geometry.coordinates) {
    geometry = { type: geometry.type, coordinates: round6(geometry.coordinates) };
  }
  return {
    type: 'Feature',
    geometry,
    properties: {
      idu: getIdu(p),
      section: p.section || '',
      numero: p.numero || '',
      contenance: p.contenance != null ? Number(p.contenance) : null,
    },
  };
}

function trimCache() {
  while (cache.size > MEM_MAX) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const insee = String(req.query.insee || '').trim().toUpperCase();
  if (!/^(\d{5}|2[AB]\d{3})$/.test(insee)) {
    res.status(400).json({ error: 'Paramètre "insee" invalide : code INSEE à 5 caractères attendu.' });
    return;
  }

  const min =
    req.query.min !== undefined && req.query.min !== '' ? Number(req.query.min) : null;
  const max =
    req.query.max !== undefined && req.query.max !== '' ? Number(req.query.max) : null;

  try {
    let entry = cache.get(insee);
    if (!entry || Date.now() - entry.ts > MEM_TTL_MS) {
      let source = 'cadastre.data.gouv.fr';
      let feats = await fetchEtalab(insee);
      if (!feats || feats.length === 0) {
        source = 'apicarto.ign.fr';
        feats = await fetchIgn(insee);
      }
      if (!feats || feats.length === 0) {
        res.status(502).json({
          error:
            'Parcelles indisponibles pour cette commune (cadastre.data.gouv.fr et IGN sans réponse). Réessayez dans un instant.',
        });
        return;
      }
      const parcelles = feats.map(normalize).filter((f) => f.geometry);
      entry = { ts: Date.now(), source, parcelles };
      cache.set(insee, entry);
      trimCache();
    }

    let out = entry.parcelles;
    const total = out.length;
    if (min != null && !Number.isNaN(min)) {
      out = out.filter((f) => f.properties.contenance != null && f.properties.contenance >= min);
    }
    if (max != null && !Number.isNaN(max)) {
      out = out.filter((f) => f.properties.contenance != null && f.properties.contenance <= max);
    }

    if (out.length > MAX_FEATURES) {
      res.status(413).json({
        error: `${out.length} parcelles correspondent — trop pour un affichage d'un coup. Resserrez la fourchette de surface.`,
        total,
        matched: out.length,
      });
      return;
    }

    const body = JSON.stringify({
      type: 'FeatureCollection',
      source: entry.source,
      total,
      matched: out.length,
      features: out,
    });

    if (Buffer.byteLength(body) > MAX_BYTES) {
      res.status(413).json({
        error: `Résultat trop volumineux (${(Buffer.byteLength(body) / 1048576).toFixed(
          1
        )} Mo). Resserrez la fourchette de surface.`,
        total,
        matched: out.length,
      });
      return;
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).json({
      error: e && e.message ? `Erreur proxy : ${e.message}` : 'Erreur proxy inconnue.',
    });
  }
}

// Proxy serverless : ventes DVF autour d'un point (une parcelle), dans un rayon
// donné, avec synthèse €/m² (moyen / min / max / médian) filtrable par type de bien.
//
// GET /api/dvf-around?lat=48.05&lon=-0.77&radius=1&months=24&type=maison&communes=53130,53146
//   - `communes` : liste des codes INSEE dont le territoire touche le cercle
//     (calculée côté client via geo.api.gouv.fr).
//   -> { center, radius_km, months, from, type, communes, data_through, synthese, ventes:[...] }

import { getCommuneMutations, median, monthsCutoffISO, distanceMeters, isInsee } from '../lib/dvf-core.js';

const MAX_VENTES = 800;
const TYPES = { tous: null, maison: 'Maison', appartement: 'Appartement', terrain: 'Terrain', local: 'Local' };

function mean(values) {
  const a = values.filter((x) => Number.isFinite(x));
  return a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
// Nettoyage des €/m² : DVF contient des cessions à l'euro symbolique, des ventes
// multi-parcelles, etc. On borne à une fourchette plausible puis on écrête les
// 5 % extrêmes de chaque côté quand l'échantillon est suffisant.
function cleanPm2(values, base) {
  const lo = base === 'terrain' ? 1 : 100;
  const hi = base === 'terrain' ? 10000 : 40000;
  let a = values.filter((v) => Number.isFinite(v) && v >= lo && v <= hi).sort((x, y) => x - y);
  if (a.length >= 20) {
    const p5 = percentile(a, 5);
    const p95 = percentile(a, 95);
    a = a.filter((v) => v >= p5 && v <= p95);
  }
  return a;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Paramètres "lat"/"lon" requis.' });
    return;
  }

  let radiusKm = Number(req.query.radius);
  if (!Number.isFinite(radiusKm)) radiusKm = 1;
  radiusKm = Math.max(0.1, Math.min(10, radiusKm));

  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months)) months = 24;
  months = Math.max(1, Math.min(72, months));
  const from = monthsCutoffISO(months);

  const typeKey = String(req.query.type || 'tous').toLowerCase();
  if (!(typeKey in TYPES)) {
    res.status(400).json({ error: 'Paramètre "type" invalide (tous|maison|appartement|terrain|local).' });
    return;
  }
  const typeCat = TYPES[typeKey];

  const communes = String(req.query.communes || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(isInsee);
  const uniqueCommunes = [...new Set(communes)].slice(0, 30);
  if (uniqueCommunes.length === 0) {
    res.status(400).json({ error: 'Paramètre "communes" requis (au moins un code INSEE).' });
    return;
  }

  try {
    const byId = new Map();
    let filesFound = 0;
    let dataThrough = '';
    for (const insee of uniqueCommunes) {
      const { all, filesFound: ff, dataThrough: dt } = await getCommuneMutations(insee, months);
      filesFound += ff;
      if (dt && dt > dataThrough) dataThrough = dt;
      for (const m of all) if (!byId.has(m.id)) byId.set(m.id, m);
    }
    if (filesFound === 0) {
      res.status(502).json({ error: 'Données DVF indisponibles autour de ce point. Réessayez dans un instant.' });
      return;
    }

    const radiusM = radiusKm * 1000;
    let inRadius = [];
    for (const m of byId.values()) {
      if (m.lat == null || m.lon == null) continue;
      if (m.date < from) continue;
      const d = distanceMeters(lat, lon, m.lat, m.lon);
      if (d > radiusM) continue;
      inRadius.push({ ...m, distance_m: Math.round(d) });
    }
    inRadius.sort((a, b) => a.distance_m - b.distance_m);

    const ventesRadius = inRadius.filter((m) => /^Vente/i.test(m.nature || ''));
    const matching = typeCat ? ventesRadius.filter((m) => m.categorie === typeCat) : ventesRadius;
    const base = typeKey === 'terrain' ? 'terrain' : 'bati';

    let rawPm2;
    if (typeKey === 'terrain') {
      rawPm2 = matching.map((m) => m.prix_m2_terrain);
    } else if (typeKey === 'tous') {
      rawPm2 = ventesRadius
        .filter((m) => m.categorie === 'Maison' || m.categorie === 'Appartement')
        .map((m) => m.prix_m2);
    } else {
      rawPm2 = matching.map((m) => m.prix_m2);
    }
    const pm2 = cleanPm2(rawPm2, base);

    const synthese = {
      count_radius: inRadius.length,
      count_ventes: ventesRadius.length,
      count_type: matching.length,
      count_pm2: pm2.length,
      pm2_base: base,
      pm2_moyen: mean(pm2),
      pm2_min: pm2.length ? pm2[0] : null,
      pm2_max: pm2.length ? pm2[pm2.length - 1] : null,
      pm2_median: median(pm2),
      pm2_p25: percentile(pm2, 25),
      pm2_p75: percentile(pm2, 75),
      prix_median: median(matching.map((m) => m.valeur)),
    };

    // La liste (et les marqueurs côté client) suit le filtre de type.
    const list = typeCat ? matching : inRadius;
    const total = list.length;
    const ventes = list.slice(0, MAX_VENTES);

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(
      JSON.stringify({
        center: { lat, lon },
        radius_km: radiusKm,
        months,
        from,
        type: typeKey,
        communes: uniqueCommunes,
        data_through: dataThrough || null,
        synthese,
        count_total: total,
        count_returned: ventes.length,
        ventes,
      })
    );
  } catch (e) {
    res.status(500).json({ error: e && e.message ? `Erreur DVF : ${e.message}` : 'Erreur DVF inconnue.' });
  }
}

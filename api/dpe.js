// Proxy serverless : diagnostics de performance énergétique (DPE) d'une commune.
//
// Source : ADEME — « DPE Logements existants (depuis juillet 2021) », API data-fair
//   https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant
//
// GET /api/dpe?insee=53130&months=36&type=tous&limit=1500
//   - months : fenêtre glissante ; 0 ou absent => tout depuis le 01/07/2021.
//   - type   : tous | maison | appartement | immeuble
//   - limit  : nb de DPE géolocalisés renvoyés (récents d'abord), max 3000.
//   -> { insee, nom, from, type, count_total, count_returned,
//        distribution_dpe:{A..G}, distribution_ges:{A..G}, dpe:[...] }

import { PLM, isInsee } from '../lib/dvf-core.js';

const BASE = 'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant';
const METHOD_START = '2021-07-01';
const FIELDS = [
  'numero_dpe', 'etiquette_dpe', 'etiquette_ges', 'date_etablissement_dpe',
  'type_batiment', 'surface_habitable_logement', 'annee_construction', 'adresse_ban',
  'nom_commune_ban', 'conso_5_usages_par_m2_ep', 'emission_ges_5_usages_par_m2', '_geopoint',
].join(',');
const TYPES = { tous: null, maison: 'maison', appartement: 'appartement', immeuble: 'immeuble' };

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cutoffISO(months) {
  if (!Number.isFinite(months) || months <= 0) return METHOD_START;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const iso = d.toISOString().slice(0, 10);
  return iso < METHOD_START ? METHOD_START : iso;
}
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function inseeList(insee) {
  return (PLM && PLM[insee]) ? PLM[insee] : [insee];
}
async function ademe(path, params) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`ADEME a répondu ${r.status}`);
  return r.json();
}
function distFromAgg(aggs) {
  const out = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
  for (const a of aggs || []) if (a && a.value && out[a.value] != null) out[a.value] = a.total;
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const insee = String(req.query.insee || '').trim().toUpperCase();
  if (!isInsee(insee)) {
    res.status(400).json({ error: 'Paramètre "insee" invalide (code INSEE à 5 caractères).' });
    return;
  }
  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months)) months = 0;
  months = Math.max(0, Math.min(120, months));
  const from = cutoffISO(months);

  const typeKey = String(req.query.type || 'tous').toLowerCase();
  if (!(typeKey in TYPES)) {
    res.status(400).json({ error: 'Paramètre "type" invalide (tous|maison|appartement|immeuble).' });
    return;
  }

  let limit = parseInt(req.query.limit, 10);
  limit = Number.isFinite(limit) ? Math.max(1, Math.min(3000, limit)) : 1500;

  const key = `${insee}|${months}|${typeKey}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts <= MEM_TTL_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(hit.body));
    return;
  }

  const codes = inseeList(insee);
  const inseeClause =
    codes.length > 1 ? `code_insee_ban:(${codes.map((c) => `"${c}"`).join(' OR ')})` : `code_insee_ban:"${codes[0]}"`;
  let qs = inseeClause + ` AND date_etablissement_dpe:[${from} TO *]`;
  if (TYPES[typeKey]) qs += ` AND type_batiment:"${TYPES[typeKey]}"`;

  try {
    const [lines, aggDpe, aggGes] = await Promise.all([
      ademe('/lines', { qs, size: String(limit), select: FIELDS, sort: '-date_etablissement_dpe' }),
      ademe('/values_agg', { field: 'etiquette_dpe', qs, agg_size: '10', size: '0' }),
      ademe('/values_agg', { field: 'etiquette_ges', qs, agg_size: '10', size: '0' }),
    ]);

    const dpe = [];
    for (const r of lines.results || []) {
      let lat = null, lon = null;
      if (r._geopoint && typeof r._geopoint === 'string') {
        const [a, b] = r._geopoint.split(',');
        lat = num(a); lon = num(b);
      }
      if (lat == null || lon == null) continue;
      dpe.push({
        id: r.numero_dpe || null,
        dpe: r.etiquette_dpe || null,
        ges: r.etiquette_ges || null,
        date: r.date_etablissement_dpe || null,
        bati: r.type_batiment || null,
        surf: num(r.surface_habitable_logement),
        annee: num(r.annee_construction),
        adr: r.adresse_ban || null,
        conso: num(r.conso_5_usages_par_m2_ep),
        ges_m2: num(r.emission_ges_5_usages_par_m2),
        lat, lon,
      });
    }

    const body = {
      insee,
      nom: (lines.results && lines.results[0] && lines.results[0].nom_commune_ban) || null,
      from,
      months,
      type: typeKey,
      source: 'ADEME — DPE logements existants (depuis 07/2021)',
      count_total: (aggDpe && aggDpe.total) || 0,
      count_returned: dpe.length,
      distribution_dpe: distFromAgg(aggDpe && aggDpe.aggs),
      distribution_ges: distFromAgg(aggGes && aggGes.aggs),
      dpe,
    };

    cache.set(key, { ts: Date.now(), body });
    if (cache.size > 60) cache.delete(cache.keys().next().value);

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(body));
  } catch (e) {
    res.status(502).json({ error: e && e.message ? `Erreur DPE : ${e.message}` : 'Erreur DPE inconnue.' });
  }
}

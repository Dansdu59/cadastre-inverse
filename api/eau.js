// Proxy serverless : qualité de l'eau potable d'une commune.
//
// Source : Hub'Eau — API « Qualité de l'eau potable » (résultats du contrôle
//   sanitaire, ministère de la Santé / ARS, données SISE-Eaux).
//   https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable
//
// GET /api/eau?insee=53130&months=24
//   -> { insee, nom, from, source, udis:[...],
//        prelevements:{ total, conformes, pct, non_conf_bact, non_conf_pc, partiel },
//        parametres:[ {id,label,valeur,unite,limite,ref,date,statut} ],
//        pesticides:{ n_recherches, n_detectes, n_depassements, max_valeur, max_substance, date },
//        derniers:[ {date, code, conforme, conclusion} ] }

import { isInsee } from '../lib/dvf-core.js';

const BASE = 'https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable';
const FIELDS = [
  'code_prelevement', 'code_parametre', 'libelle_parametre', 'resultat_numerique', 'libelle_unite',
  'limite_qualite_parametre', 'reference_qualite_parametre', 'date_prelevement',
  'conclusion_conformite_prelevement',
  'conformite_limites_bact_prelevement', 'conformite_limites_pc_prelevement',
  'conformite_references_bact_prelevement', 'conformite_references_pc_prelevement',
].join(',');

// Paramètres mis en avant, repérés par le libellé.
const KEY = [
  { id: 'nitrates', re: /^nitrates\s*\(/i, kind: 'max' },
  { id: 'nitrites', re: /^nitrites\s*\(/i, kind: 'max' },
  { id: 'ecoli', re: /escherichia coli/i, kind: 'max' },
  { id: 'enterocoques', re: /ent[ée]rocoque/i, kind: 'max' },
  { id: 'coliformes', re: /bact[ée]ries et spores|coliformes/i, kind: 'max' },
  { id: 'durete', re: /duret[ée]\s*(totale|tot)/i, kind: 'info' },
  { id: 'ph', re: /^ph\b|potentiel en hydrog|potentiel hydrog/i, kind: 'range' },
  { id: 'chlore', re: /chlore (libre|total)/i, kind: 'info' },
  { id: 'conductivite', re: /conductivit/i, kind: 'range' },
  { id: 'turbidite', re: /turbidit/i, kind: 'max' },
];

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cutoffISO(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - (Number.isFinite(months) && months > 0 ? months : 24));
  return d.toISOString().slice(0, 10);
}
function parseNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
// "<=50 mg/L" -> 50 ; ">=200 et <=1100 µS/cm" -> null (fourchette) ; "<=0,1 µg/L" -> 0.1
function parseUpperLimit(s) {
  if (!s) return null;
  const t = String(s).replace(',', '.');
  if (/>=|\bet\b/i.test(t)) return null;
  const m = t.match(/<?=?\s*(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
async function hubeau(path, params) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`Hub'Eau a répondu ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const insee = String(req.query.insee || '').trim().toUpperCase();
  if (!isInsee(insee)) {
    res.status(400).json({ error: 'Paramètre "insee" invalide (code INSEE à 5 caractères).' });
    return;
  }
  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months)) months = 24;
  months = Math.max(6, Math.min(72, months));
  const from = cutoffISO(months);

  const key = `${insee}|${months}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts <= MEM_TTL_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(hit.body));
    return;
  }

  try {
    const year = new Date().getFullYear();
    const [udiRes, resRes] = await Promise.all([
      hubeau('/communes_udi', { code_commune: insee, annee: String(year), size: '20' }).catch(() => ({ data: [] })),
      hubeau('/resultats_dis', {
        code_commune: insee, date_min_prelevement: from, sort: 'desc', size: '10000', fields: FIELDS,
      }),
    ]);

    const rows = resRes.data || [];
    const partiel = (resRes.count || 0) > rows.length;

    // Conformité par prélèvement distinct
    const prByCode = new Map();
    for (const r of rows) {
      const c = r.code_prelevement;
      if (!c || prByCode.has(c)) continue;
      prByCode.set(c, r);
    }
    const prels = [...prByCode.values()];
    const okFlag = (v) => v == null || v === '' || v === 'C' || v === 'S' || v === 'D';
    // Conformité sanitaire = limites de qualité (santé). Les « références de
    // qualité » sont des indicateurs de bon fonctionnement (goût, fer, chlore…),
    // suivis à part : un dépassement n'est pas un risque sanitaire.
    const isConf = (r) => okFlag(r.conformite_limites_bact_prelevement) && okFlag(r.conformite_limites_pc_prelevement);
    const isRefOk = (r) => okFlag(r.conformite_references_bact_prelevement) && okFlag(r.conformite_references_pc_prelevement);
    const conformes = prels.filter(isConf).length;
    const nonBact = prels.filter((r) => r.conformite_limites_bact_prelevement === 'N').length;
    const nonPc = prels.filter((r) => r.conformite_limites_pc_prelevement === 'N').length;
    const nonRef = prels.filter((r) => isConf(r) && !isRefOk(r)).length;

    // Paramètres clés : valeur la plus récente
    const parametres = [];
    for (const spec of KEY) {
      const r = rows.find((x) => spec.re.test(x.libelle_parametre || '') && x.resultat_numerique != null);
      if (!r) continue;
      const limite = parseUpperLimit(r.limite_qualite_parametre) ?? parseUpperLimit(r.reference_qualite_parametre);
      const val = parseNum(r.resultat_numerique);
      let statut = null;
      if (spec.kind === 'max' && limite != null && val != null) statut = val > limite ? 'depasse' : 'ok';
      parametres.push({
        id: spec.id,
        label: r.libelle_parametre,
        valeur: val,
        unite: r.libelle_unite || '',
        limite: spec.kind === 'max' ? limite : null,
        ref: r.limite_qualite_parametre || r.reference_qualite_parametre || null,
        date: r.date_prelevement || null,
        statut,
      });
    }

    // Pesticides : dernière valeur par substance
    const pestLatest = new Map();
    for (const r of rows) {
      if (!/pesticide|herbicide|m[ée]tabolite|\besa\b|atrazine|glyphosate|chlortoluron|metolachlor/i.test(r.libelle_parametre || '')) continue;
      if (/total|somme/i.test(r.libelle_parametre || '')) continue;
      const k = r.code_parametre;
      if (!pestLatest.has(k)) pestLatest.set(k, r);
    }
    let maxVal = 0, maxSub = null, nDet = 0, nDep = 0;
    for (const r of pestLatest.values()) {
      const v = parseNum(r.resultat_numerique);
      if (v == null) continue;
      if (v > 0) nDet++;
      if (v > 0.1) nDep++;
      if (v > maxVal) { maxVal = v; maxSub = r.libelle_parametre; }
    }
    const pesticides = pestLatest.size
      ? { n_recherches: pestLatest.size, n_detectes: nDet, n_depassements: nDep, max_valeur: maxVal || null, max_substance: maxSub, date: null }
      : null;

    // Derniers prélèvements
    const derniers = prels
      .slice()
      .sort((a, b) => String(b.date_prelevement).localeCompare(String(a.date_prelevement)))
      .slice(0, 20)
      .map((r) => ({
        date: r.date_prelevement || null,
        code: r.code_prelevement || null,
        conforme: isConf(r),
        conclusion: r.conclusion_conformite_prelevement || null,
      }));

    const body = {
      insee,
      nom: (udiRes.data && udiRes.data[0] && udiRes.data[0].nom_commune) || (rows[0] && rows[0].nom_commune) || null,
      from,
      months,
      source: "Hub'Eau — contrôle sanitaire de l'eau potable (ARS / SISE-Eaux)",
      udis: (udiRes.data || []).map((u) => ({ nom: u.nom_reseau, code: u.code_reseau, debut: u.debut_alim || null })),
      prelevements: {
        total: prels.length,
        conformes,
        pct: prels.length ? Math.round((1000 * conformes) / prels.length) / 10 : null,
        non_conf_bact: nonBact,
        non_conf_pc: nonPc,
        non_conf_ref: nonRef,
        partiel,
      },
      parametres,
      pesticides,
      derniers,
    };

    cache.set(key, { ts: Date.now(), body });
    if (cache.size > 60) cache.delete(cache.keys().next().value);

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(body));
  } catch (e) {
    res.status(502).json({ error: e && e.message ? `Erreur qualité de l'eau : ${e.message}` : "Erreur qualité de l'eau inconnue." });
  }
}

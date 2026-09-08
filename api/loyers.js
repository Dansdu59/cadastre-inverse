// Proxy serverless : loyer d'annonce au m² (carte des loyers DHUP) + rendement
// locatif brut par commune.
//
// GET /api/loyers?communes=53130,53001,53007&months=60
//   - `communes` : codes INSEE (calculés côté client — commune choisie + voisines
//     dans un rayon). Plafonné à 40.
//   - `months`   : fenêtre DVF pour le prix de vente médian (déf. 60, max 72).
//   -> { months, source, data_through, communes: [{
//         insee, nom, loy_app, loy_mai, loy_mix, ic_app, typ_app, typ_mai,
//         prix_m2, ventes_n, rdt_app, rdt_mai, rdt_mix }] }
//
// Rendement brut = loyer annuel/m² ÷ prix de vente/m². Avant charges, taxe
// foncière, vacance et frais : c'est un ordre de grandeur, pas un net.

import { getCommuneMutations, median, monthsCutoffISO, isInsee } from '../lib/dvf-core.js';

const MAX_COMMUNES = 40;
const LOYER_TTL_MS = 24 * 60 * 60 * 1000;

// Carte des loyers 2023 (ministère du Logement / DHUP, data.gouv.fr) : une ligne
// par commune, loyer d'annonce prédit en €/m²/mois. CSV « ; », décimale « , »,
// encodage latin1.
const SRC = {
  app: 'https://static.data.gouv.fr/resources/carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-2023/20240115-134743/pred-app-mef-dhup.csv',
  mai: 'https://static.data.gouv.fr/resources/carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-2023/20240115-134640/pred-mai-mef-dhup.csv',
};

let loyerCache = null; // { ts, byInsee: Map(insee -> rec) }

function toNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function loadLoyers() {
  if (loyerCache && Date.now() - loyerCache.ts < LOYER_TTL_MS) return loyerCache;

  const byInsee = new Map();
  for (const [kind, url] of Object.entries(SRC)) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`carte des loyers (${kind}) a répondu ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('latin1');
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) continue;
    const head = lines[0].split(';').map((s) => s.replace(/^"|"$/g, ''));
    const iC = head.indexOf('INSEE_C');
    const iG = head.indexOf('LIBGEO');
    const iL = head.indexOf('loypredm2');
    const iLo = head.indexOf('lwr.IPm2');
    const iUp = head.indexOf('upr.IPm2');
    const iT = head.indexOf('TYPPRED');
    for (let n = 1; n < lines.length; n++) {
      const ln = lines[n];
      if (!ln) continue;
      const c = ln.split(';').map((s) => s.replace(/^"|"$/g, ''));
      const insee = (c[iC] || '').toUpperCase();
      if (!insee) continue;
      const val = toNum(c[iL]);
      if (val == null) continue;
      const rec = byInsee.get(insee) || { insee, nom: c[iG] || '' };
      rec[kind] = val;
      rec[`${kind}_lo`] = toNum(c[iLo]);
      rec[`${kind}_up`] = toNum(c[iUp]);
      rec[`${kind}_typ`] = c[iT] || '';
      byInsee.set(insee, rec);
    }
  }
  loyerCache = { ts: Date.now(), byInsee };
  return loyerCache;
}

// Prix de vente médian €/m² (maisons + appartements) d'une commune sur `months`.
async function communePrixM2(insee, months, fromISO) {
  try {
    const { all, filesFound, dataThrough } = await getCommuneMutations(insee, months);
    if (!filesFound) return { prix_m2: null, ventes_n: 0, dataThrough: '' };
    const ventes = all.filter(
      (m) =>
        m.date >= fromISO &&
        /^Vente/i.test(m.nature || '') &&
        (m.categorie === 'Maison' || m.categorie === 'Appartement') &&
        Number.isFinite(m.prix_m2) &&
        m.prix_m2 >= 300 &&
        m.prix_m2 <= 20000
    );
    return {
      prix_m2: median(ventes.map((m) => m.prix_m2)),
      ventes_n: ventes.length,
      dataThrough: dataThrough || '',
    };
  } catch {
    return { prix_m2: null, ventes_n: 0, dataThrough: '' };
  }
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const communes = String(req.query.communes || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(isInsee);
  const list = [...new Set(communes)].slice(0, MAX_COMMUNES);
  if (!list.length) {
    res.status(400).json({ error: 'Paramètre "communes" requis (codes INSEE séparés par des virgules).' });
    return;
  }

  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months)) months = 60;
  months = Math.max(12, Math.min(72, months));
  const fromISO = monthsCutoffISO(months);

  try {
    const { byInsee } = await loadLoyers();

    const dvf = await mapLimited(list, 8, (insee) => communePrixM2(insee, months, fromISO));

    let dataThrough = '';
    const communesOut = list.map((insee, k) => {
      const L = byInsee.get(insee) || {};
      const { prix_m2, ventes_n, dataThrough: dt } = dvf[k];
      if (dt && dt > dataThrough) dataThrough = dt;

      const loyApp = Number.isFinite(L.app) ? L.app : null;
      const loyMai = Number.isFinite(L.mai) ? L.mai : null;
      const loyMix =
        loyApp != null && loyMai != null ? (loyApp + loyMai) / 2 : loyApp != null ? loyApp : loyMai;

      const rdt = (loy) =>
        loy != null && prix_m2 ? round2((loy * 12) / prix_m2 * 100) : null;

      return {
        insee,
        nom: L.nom || '',
        loy_app: round2(loyApp),
        loy_mai: round2(loyMai),
        loy_mix: round2(loyMix),
        ic_app: loyApp != null ? [round2(L.app_lo), round2(L.app_up)] : null,
        typ_app: L.app_typ || null,
        typ_mai: L.mai_typ || null,
        prix_m2: prix_m2 != null ? Math.round(prix_m2) : null,
        ventes_n,
        rdt_app: rdt(loyApp),
        rdt_mai: rdt(loyMai),
        rdt_mix: rdt(loyMix),
      };
    });

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(
      JSON.stringify({
        months,
        from: fromISO,
        source: 'Carte des loyers 2023 (DHUP / data.gouv.fr) · prix de vente DVF (geo-dvf Etalab)',
        data_through: dataThrough || null,
        count: communesOut.length,
        communes: communesOut,
      })
    );
  } catch (e) {
    res.status(500).json({ error: e && e.message ? `Erreur loyers : ${e.message}` : 'Erreur loyers inconnue.' });
  }
}

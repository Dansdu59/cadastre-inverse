// Proxy serverless : transactions immobilières (DVF) d'une commune.
//
// GET /api/dvf?insee=53130&months=24
//   -> { insee, months, from, stats:{count,total,data_through,prix_median,prix_m2_median}, mutations:[...] }

import { getCommuneMutations, median, monthsCutoffISO, isInsee } from '../lib/dvf-core.js';

const MAX_MUTATIONS = 1500;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const insee = String(req.query.insee || '').trim().toUpperCase();
  if (!isInsee(insee)) {
    res.status(400).json({ error: 'Paramètre "insee" invalide : code INSEE à 5 caractères attendu.' });
    return;
  }

  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months)) months = 24;
  months = Math.max(1, Math.min(72, months));
  const from = monthsCutoffISO(months);

  try {
    const { all, filesFound, dataThrough } = await getCommuneMutations(insee, months);
    if (filesFound === 0) {
      res.status(502).json({ error: 'Données DVF indisponibles pour cette commune. Réessayez dans un instant.' });
      return;
    }

    let mutations = all
      .filter((m) => m.date >= from)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const total = mutations.length;
    if (mutations.length > MAX_MUTATIONS) mutations = mutations.slice(0, MAX_MUTATIONS);

    const ventes = mutations.filter((m) => /^Vente/i.test(m.nature || ''));
    const stats = {
      count: mutations.length,
      total,
      data_through: dataThrough,
      prix_median: median(ventes.map((m) => m.valeur)),
      prix_m2_median: median(
        ventes.filter((m) => m.categorie === 'Maison' || m.categorie === 'Appartement').map((m) => m.prix_m2)
      ),
    };

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ insee, months, from, stats, mutations }));
  } catch (e) {
    res.status(500).json({ error: e && e.message ? `Erreur DVF : ${e.message}` : 'Erreur DVF inconnue.' });
  }
}

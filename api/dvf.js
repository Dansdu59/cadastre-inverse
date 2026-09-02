// Proxy serverless : transactions immobilières (DVF — Demande de Valeurs Foncières).
// Source : files.data.gouv.fr/geo-dvf (export Etalab, un CSV par commune et par an).
// Récupéré côté serveur (pas de CORS), regroupé par mutation, trié par date décroissante.
//
// GET /api/dvf?insee=53130&months=24
//   -> { insee, months, from, stats:{count,total,prix_median,prix_m2_median}, mutations:[...] }

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const MEM_MAX = 30;
const MAX_MUTATIONS = 1500;

/** "insee:months" -> { ts, from, mutations, stats, filesFound } */
const cache = new Map();

// Villes à arrondissements municipaux : pas de fichier au niveau commune.
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

function deptDir(insee) {
  if (/^2[AB]/i.test(insee)) return insee.slice(0, 2).toUpperCase();
  if (/^9[78]\d/.test(insee)) return insee.slice(0, 3);
  return insee.slice(0, 2);
}

function csvUrl(year, insee) {
  return `https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/communes/${deptDir(insee)}/${insee}.csv`;
}

async function fetchCsv(year, insee) {
  const res = await fetch(csvUrl(year, insee), { redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`geo-dvf ${year} a répondu ${res.status}`);
  return res.text();
}

async function fetchYearParts(year, insee) {
  const codes = PLM[insee] || [insee];
  const parts = await Promise.all(codes.map((c) => fetchCsv(year, c).catch(() => null)));
  return parts.filter(Boolean);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Les CSV geo-dvf sont propres (séparateur ",", aucun champ entre guillemets) :
// un simple split suffit et reste rapide sur les gros fichiers.
function accumulate(text, acc) {
  const lines = text.split('\n');
  if (lines.length < 2) return;
  const header = lines[0].split(',');
  const H = {};
  header.forEach((h, i) => (H[h] = i));

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    const id = c[H.id_mutation];
    if (!id) continue;

    let m = acc.get(id);
    if (!m) {
      m = {
        id,
        date: c[H.date_mutation] || '',
        nature: c[H.nature_mutation] || '',
        valeur: num(c[H.valeur_fonciere]),
        cp: c[H.code_postal] || '',
        commune: c[H.nom_commune] || '',
        adr: [c[H.adresse_numero], c[H.adresse_suffixe], c[H.adresse_nom_voie]].filter(Boolean).join(' ').trim(),
        lat: num(c[H.latitude]),
        lon: num(c[H.longitude]),
        locaux: [],
        parcelles: new Set(),
        terrainByParcelle: new Map(),
      };
      acc.set(id, m);
    }
    if (m.valeur == null) m.valeur = num(c[H.valeur_fonciere]);
    if (m.lat == null) { m.lat = num(c[H.latitude]); m.lon = num(c[H.longitude]); }

    const type = c[H.type_local];
    if (type) m.locaux.push({ type, bati: num(c[H.surface_reelle_bati]), pieces: num(c[H.nombre_pieces_principales]) });

    const par = c[H.id_parcelle];
    if (par) {
      m.parcelles.add(par);
      const st = num(c[H.surface_terrain]);
      if (st != null && !m.terrainByParcelle.has(par)) m.terrainByParcelle.set(par, st);
    }
  }
}

function finalize(m) {
  const habit = m.locaux.filter((l) => l.type === 'Maison' || l.type === 'Appartement');
  const batiTotal = habit.reduce((s, l) => s + (l.bati || 0), 0);
  const terrainTotal = [...m.terrainByParcelle.values()].reduce((s, v) => s + v, 0);

  let categorie = 'Autre';
  if (m.locaux.some((l) => l.type === 'Maison')) categorie = 'Maison';
  else if (m.locaux.some((l) => l.type === 'Appartement')) categorie = 'Appartement';
  else if (m.locaux.some((l) => /local/i.test(l.type))) categorie = 'Local';
  else if (batiTotal === 0 && terrainTotal > 0) categorie = 'Terrain';

  const prixM2 = m.valeur && batiTotal > 0 ? Math.round(m.valeur / batiTotal) : null;
  const adresse = [m.adr, [m.cp, m.commune].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  return {
    id: m.id,
    date: m.date,
    nature: m.nature,
    valeur: m.valeur,
    categorie,
    locaux: m.locaux.map((l) => ({ type: l.type, bati: l.bati, pieces: l.pieces })),
    bati_total: batiTotal || null,
    terrain_total: terrainTotal || null,
    pieces: habit.reduce((s, l) => s + (l.pieces || 0), 0) || null,
    prix_m2: prixM2,
    adresse,
    parcelles: [...m.parcelles],
    lat: m.lat,
    lon: m.lon,
  };
}

function median(values) {
  const a = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

function trimCache() {
  while (cache.size > MEM_MAX) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
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

  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months)) months = 24;
  months = Math.max(1, Math.min(72, months));

  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  const from = cutoff.toISOString().slice(0, 10);

  // Années à télécharger : de l'année du seuil jusqu'à l'année courante, plus les
  // 2 années précédentes (DVF est publié avec ~6 mois de décalage : le fichier de
  // l'année en cours n'existe souvent pas encore). Le filtrage par date se fait
  // ensuite sur `from`, donc télécharger un peu large est sans conséquence.
  const yearSet = new Set();
  for (let y = cutoff.getFullYear(); y <= now.getFullYear(); y++) yearSet.add(y);
  yearSet.add(now.getFullYear() - 1);
  yearSet.add(now.getFullYear() - 2);
  const years = [...yearSet].sort((a, b) => a - b).slice(-6); // au plus 6 années

  const key = `${insee}:${months}`;
  try {
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.ts > MEM_TTL_MS) {
      const acc = new Map();
      let filesFound = 0;
      for (const y of years) {
        const parts = await fetchYearParts(y, insee);
        filesFound += parts.length;
        for (const text of parts) accumulate(text, acc);
      }

      const all = [...acc.values()].map(finalize).filter((m) => m.date);
      const dataThrough = all.reduce((mx, m) => (m.date > mx ? m.date : mx), '');

      let mutations = all
        .filter((m) => m.date >= from)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      const total = mutations.length;
      if (mutations.length > MAX_MUTATIONS) mutations = mutations.slice(0, MAX_MUTATIONS);

      const ventes = mutations.filter((m) => /^Vente/i.test(m.nature || ''));
      const stats = {
        count: mutations.length,
        total,
        data_through: dataThrough || null,
        prix_median: median(ventes.map((m) => m.valeur)),
        prix_m2_median: median(
          ventes.filter((m) => m.categorie === 'Maison' || m.categorie === 'Appartement').map((m) => m.prix_m2)
        ),
      };

      entry = { ts: Date.now(), from, mutations, stats, filesFound };
      cache.set(key, entry);
      trimCache();
    }

    if (entry.filesFound === 0) {
      res.status(502).json({ error: 'Données DVF indisponibles pour cette commune. Réessayez dans un instant.' });
      return;
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(
      JSON.stringify({ insee, months, from: entry.from, stats: entry.stats, mutations: entry.mutations })
    );
  } catch (e) {
    res.status(500).json({ error: e && e.message ? `Erreur DVF : ${e.message}` : 'Erreur DVF inconnue.' });
  }
}

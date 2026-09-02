// Cœur DVF partagé par /api/dvf et /api/dvf-around.
// Source : files.data.gouv.fr/geo-dvf (export Etalab, un CSV par commune et par an),
// récupéré côté serveur (pas de CORS), regroupé par mutation.

const MEM_TTL_MS = 6 * 60 * 60 * 1000;
const MEM_MAX = 60;

/** "insee:months" -> { ts, all, filesFound, dataThrough } */
const cache = new Map();

// Villes à arrondissements municipaux : pas de fichier au niveau commune.
export const PLM = {
  '75056': intRange(75101, 75120), // Paris
  '13055': intRange(13201, 13216), // Marseille
  '69123': intRange(69381, 69389), // Lyon
};
function intRange(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(String(i));
  return out;
}

export function deptDir(insee) {
  if (/^2[AB]/i.test(insee)) return insee.slice(0, 2).toUpperCase();
  if (/^9[78]\d/.test(insee)) return insee.slice(0, 3);
  return insee.slice(0, 2);
}

export function isInsee(v) {
  return /^(\d{5}|2[AB]\d{3})$/.test(String(v || '').toUpperCase());
}

export function median(values) {
  const a = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

// Distance approximative entre deux points (mètres), formule de haversine.
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

// Les CSV geo-dvf sont propres (séparateur ",", aucun champ entre guillemets).
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
  const prixM2Terrain = m.valeur && terrainTotal > 0 ? Math.round(m.valeur / terrainTotal) : null;
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
    prix_m2_terrain: prixM2Terrain,
    adresse,
    parcelles: [...m.parcelles],
    lat: m.lat,
    lon: m.lon,
  };
}

// Années à télécharger pour couvrir `months` : de l'année du seuil à l'année
// courante, plus les 2 précédentes (DVF publié avec ~6 mois de décalage).
export function yearsForMonths(months) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  const set = new Set();
  for (let y = cutoff.getFullYear(); y <= now.getFullYear(); y++) set.add(y);
  set.add(now.getFullYear() - 1);
  set.add(now.getFullYear() - 2);
  return [...set].sort((a, b) => a - b).slice(-6);
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

// Toutes les mutations finalisées d'une commune sur la fenêtre d'années couvrant
// `months` (non filtrées par date — le filtrage fin est laissé à l'appelant).
export async function getCommuneMutations(insee, months) {
  insee = String(insee).toUpperCase();
  const key = `${insee}:${months}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts <= MEM_TTL_MS) return hit;

  const acc = new Map();
  let filesFound = 0;
  for (const y of yearsForMonths(months)) {
    const parts = await fetchYearParts(y, insee);
    filesFound += parts.length;
    for (const text of parts) accumulate(text, acc);
  }
  const all = [...acc.values()].map(finalize).filter((m) => m.date);
  const dataThrough = all.reduce((mx, m) => (m.date > mx ? m.date : mx), '');

  const entry = { ts: Date.now(), all, filesFound, dataThrough: dataThrough || null };
  cache.set(key, entry);
  trimCache();
  return entry;
}

export function monthsCutoffISO(months) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  return cutoff.toISOString().slice(0, 10);
}

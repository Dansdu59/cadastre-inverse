// Statistiques d'usage de l'app (proto) : compteur de visites, durée moyenne de visite,
// onglets les plus utilisés.
//
// Stockage : variables en mémoire du process serverless (pas de base de données).
//   -> APPROXIMATIF par construction : Vercel peut faire tourner plusieurs instances
//      de cette fonction en parallèle (chacune avec ses propres compteurs) et les
//      réinitialise à chaque redéploiement ou "cold start". Pour des statistiques
//      fiables sur la durée, il faudrait un stockage persistant (Vercel KV, etc.).
//
// POST /api/stats  { type:'view' }                           -> +1 visite
// POST /api/stats  { type:'end', durationMs, tabHits:{...} }  -> +1 session mesurée
//                                                                 (durée + clics par onglet)
// GET  /api/stats  -> { totalVisits, sessionsCounted, avgDurationMs, topTabs:[{tab,count}], since, note }

const MAX_TAB_KEY = 20;
const MAX_TAB_HITS_PER_EVENT = 500;    // garde-fou anti-abus par évènement
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;   // 6 h : au-delà, valeur aberrante ignorée

let totalVisits = 0;
let sessionsCounted = 0;
let sumDurationMs = 0;
const tabCounts = {};
const startedAt = Date.now();

function num(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body && typeof body === 'object' ? body : {};

    if (body.type === 'view') {
      totalVisits++;
    } else if (body.type === 'end') {
      const d = num(body.durationMs);
      if (d != null && d > 0 && d <= MAX_DURATION_MS) { sumDurationMs += d; sessionsCounted++; }
      const hits = body.tabHits && typeof body.tabHits === 'object' ? body.tabHits : {};
      for (const [k, v] of Object.entries(hits)) {
        const n = num(v);
        if (!n || n <= 0) continue;
        const key = String(k).slice(0, MAX_TAB_KEY);
        tabCounts[key] = (tabCounts[key] || 0) + Math.min(n, MAX_TAB_HITS_PER_EVENT);
      }
    }
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') { res.status(405).json({ error: 'Méthode non supportée.' }); return; }

  const avgDurationMs = sessionsCounted ? Math.round(sumDurationMs / sessionsCounted) : 0;
  const topTabs = Object.entries(tabCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tab, count]) => ({ tab, count }));

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    totalVisits,
    sessionsCounted,
    avgDurationMs,
    topTabs,
    since: new Date(startedAt).toISOString(),
    note: "Compteur en mémoire serveur : approximatif, peut repartir à zéro après un redéploiement ou se répartir entre plusieurs instances.",
  });
}

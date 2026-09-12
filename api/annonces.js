// Proto : annonces immobilières partagées par les utilisateurs (vente / location),
// avec votation communautaire (info correcte / mauvaise info) et modération admin.
//
// Stockage : en mémoire du process serverless (comme api/stats.js) — AUCUNE base de
// données. Les annonces peuvent disparaître après un redéploiement ou un cold start,
// et se répartir entre plusieurs instances si le trafic est important. Pour une vraie
// mise en production il faudrait un stockage persistant (Vercel KV, Postgres, etc.).
//
// GET  /api/annonces
//   -> { listings:[{id,lat,lon,type,source,url,note,label,createdAt,ok,bad,verified}] }
//
// POST /api/annonces  { action:'create', lat, lon, type:'vente'|'location',
//                        source:'agence'|'perso', url?, note?, label? }
//   -> { listing }
// POST /api/annonces  { action:'vote', id, vote:'ok'|'bad' }
//   -> { listing } ou { listing:null, removed:true } si trop de « mauvaise info »
// POST /api/annonces  { action:'delete', id, adminKey }
//   -> { ok:true } (nécessite la clé admin — ANNONCES_ADMIN_KEY en variable
//       d'environnement Vercel ; valeur par défaut 'admin123' pour ce proto, à changer)

const OK_THRESHOLD = 5;    // votes « info correcte » avant le badge vérifié
const BAD_THRESHOLD = 5;   // votes « mauvaise info » avant suppression automatique
const ADMIN_KEY = process.env.ANNONCES_ADMIN_KEY || 'admin123';
const MAX_LISTINGS = 5000; // garde-fou anti-abus (mémoire)

const listings = new Map();   // id -> annonce
let seq = 0;

function genId() {
  return Date.now().toString(36) + '-' + (++seq).toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}
function serialize(l) {
  return {
    id: l.id, lat: l.lat, lon: l.lon, type: l.type, source: l.source,
    url: l.url, note: l.note, label: l.label, createdAt: l.createdAt,
    ok: l.ok, bad: l.bad, verified: l.ok >= OK_THRESHOLD,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const all = [...listings.values()].map(serialize).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.status(200).json({ listings: all });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non supportée.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const action = body.action;

  if (action === 'create') {
    if (listings.size >= MAX_LISTINGS) { res.status(429).json({ error: 'Trop d’annonces enregistrées, réessayez plus tard.' }); return; }
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      res.status(400).json({ error: 'Coordonnées invalides.' }); return;
    }
    const type = body.type === 'location' ? 'location' : 'vente';
    const source = body.source === 'perso' ? 'perso' : 'agence';
    let url = null, note = null;
    if (source === 'agence') {
      url = String(body.url || '').trim().slice(0, 500);
      if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'Lien d’annonce invalide (http/https requis).' }); return; }
    } else {
      note = String(body.note || '').trim().slice(0, 300) || null;
    }
    const label = String(body.label || '').trim().slice(0, 200) || null;
    const l = { id: genId(), lat, lon, type, source, url, note, label, createdAt: new Date().toISOString(), ok: 0, bad: 0 };
    listings.set(l.id, l);
    res.status(201).json({ listing: serialize(l) });
    return;
  }

  if (action === 'vote') {
    const id = String(body.id || '');
    const l = listings.get(id);
    if (!l) { res.status(404).json({ error: 'Annonce introuvable (déjà supprimée ?).' }); return; }
    if (body.vote === 'ok') l.ok++;
    else if (body.vote === 'bad') l.bad++;
    else { res.status(400).json({ error: 'Vote invalide.' }); return; }
    if (l.bad >= BAD_THRESHOLD) {
      listings.delete(id);
      res.status(200).json({ listing: null, removed: true });
      return;
    }
    res.status(200).json({ listing: serialize(l) });
    return;
  }

  if (action === 'delete') {
    if (String(body.adminKey || '') !== ADMIN_KEY) { res.status(403).json({ error: 'Clé admin invalide.' }); return; }
    const id = String(body.id || '');
    const existed = listings.delete(id);
    res.status(200).json({ ok: true, existed });
    return;
  }

  res.status(400).json({ error: 'Action inconnue.' });
}

// Annonces immobilières partagées par les utilisateurs (vente / location), avec
// votation communautaire (info correcte / mauvaise info) et modération admin.
//
// Stockage : Firestore (Firebase Admin SDK, accès serveur privilégié — le client ne
// parle jamais directement à Firestore). Nécessite 3 variables d'environnement Vercel :
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// (issues d'une clé de compte de service générée dans la console Firebase).
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
//   -> { ok:true, existed } (nécessite la clé admin — ANNONCES_ADMIN_KEY en variable
//       d'environnement Vercel ; valeur par défaut 'admin123' pour ce proto, à changer)

import admin from 'firebase-admin';

const OK_THRESHOLD = 5;    // votes « info correcte » avant le badge vérifié
const BAD_THRESHOLD = 5;   // votes « mauvaise info » avant suppression automatique
const ADMIN_KEY = process.env.ANNONCES_ADMIN_KEY || 'admin123';
const MAX_LISTINGS = 5000; // garde-fou anti-abus
const COL = 'annonces';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel stocke les sauts de ligne échappés (\n littéral) dans les variables d'env :
      // on les reconvertit en vrais retours à la ligne pour le format PEM.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

function toListing(id, d) {
  return {
    id, lat: d.lat, lon: d.lon, type: d.type, source: d.source,
    url: d.url ?? null, note: d.note ?? null, label: d.label ?? null,
    createdAt: d.createdAt, ok: d.ok || 0, bad: d.bad || 0, verified: (d.ok || 0) >= OK_THRESHOLD,
  };
}
function serialize(doc) { return toListing(doc.id, doc.data()); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const snap = await db.collection(COL).orderBy('createdAt', 'desc').limit(1000).get();
      res.status(200).json({ listings: snap.docs.map(serialize) });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non supportée.' }); return; }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body && typeof body === 'object' ? body : {};

    const action = body.action;

    if (action === 'create') {
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

      const countSnap = await db.collection(COL).count().get();
      if (countSnap.data().count >= MAX_LISTINGS) { res.status(429).json({ error: 'Trop d’annonces enregistrées, réessayez plus tard.' }); return; }

      const data = { lat, lon, type, source, url, note, label, createdAt: new Date().toISOString(), ok: 0, bad: 0 };
      const ref = await db.collection(COL).add(data);
      res.status(201).json({ listing: toListing(ref.id, data) });
      return;
    }

    if (action === 'vote') {
      const id = String(body.id || '');
      const field = body.vote === 'ok' ? 'ok' : body.vote === 'bad' ? 'bad' : null;
      if (!field) { res.status(400).json({ error: 'Vote invalide.' }); return; }
      const ref = db.collection(COL).doc(id);

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { notFound: true };
        const d = snap.data();
        const nextVal = (d[field] || 0) + 1;
        if (field === 'bad' && nextVal >= BAD_THRESHOLD) {
          tx.delete(ref);
          return { removed: true };
        }
        tx.update(ref, { [field]: nextVal });
        return { data: { ...d, [field]: nextVal } };
      });

      if (result.notFound) { res.status(404).json({ error: 'Annonce introuvable (déjà supprimée ?).' }); return; }
      if (result.removed) { res.status(200).json({ listing: null, removed: true }); return; }
      res.status(200).json({ listing: toListing(id, result.data) });
      return;
    }

    if (action === 'delete') {
      if (String(body.adminKey || '') !== ADMIN_KEY) { res.status(403).json({ error: 'Clé admin invalide.' }); return; }
      const id = String(body.id || '');
      const ref = db.collection(COL).doc(id);
      const snap = await ref.get();
      const existed = snap.exists;
      if (existed) await ref.delete();
      res.status(200).json({ ok: true, existed });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur Firestore : ' + (e && e.message ? e.message : String(e)) });
  }
}

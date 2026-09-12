// Annonces immobilières partagées par les utilisateurs (vente / location), avec
// votation communautaire (info correcte / mauvaise info), modération admin, et
// gamification légère : pseudo (stocké côté client, pas de compte), points,
// badges, classement.
//
// Stockage : Firestore (Firebase Admin SDK, accès serveur privilégié — le client ne
// parle jamais directement à Firestore). Nécessite 3 variables d'environnement Vercel :
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// (issues d'une clé de compte de service générée dans la console Firebase).
//
// Le pseudo n'est PAS un compte : n'importe qui peut taper n'importe quel pseudo,
// il ne fait qu'identifier les contributions (comme un pseudo de forum sans mot de
// passe). Les points/badges sont donc indicatifs, pas une preuve d'identité.
//
// GET  /api/annonces
//   -> { listings:[{id,lat,lon,type,source,url,note,label,author,createdAt,ok,bad,verified}] }
// GET  /api/annonces?view=leaderboard&limit=50
//   -> { contributors:[{pseudo,points,listingsCreated,listingsVerified,votesCast,badges:[{code,icon,label}]}] }
//
// POST /api/annonces  { action:'create', pseudo, lat, lon, type:'vente'|'location',
//                        source:'agence'|'perso', url?, note?, label? }
//   -> { listing }
// POST /api/annonces  { action:'vote', pseudo, id, vote:'ok'|'bad' }
//   -> { listing } ou { listing:null, removed:true } si trop de « mauvaise info »
// POST /api/annonces  { action:'verify', adminKey }
//   -> { ok:true } ou 403 si la clé est invalide (sert à activer le mode admin côté
//       client sans jamais faire de suppression réelle)
// POST /api/annonces  { action:'delete', id, adminKey }
//   -> { ok:true, existed } (nécessite la clé admin — ANNONCES_ADMIN_KEY en variable
//       d'environnement Vercel ; valeur par défaut 'admin123' pour ce proto, à changer)

// firebase-admin v9+ utilise une API modulaire (comme le SDK client Firebase v9+) :
// pas d'objet "admin" namespacé avec admin.firestore()/admin.credential.cert() — il
// faut importer chaque morceau depuis son sous-module.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const OK_THRESHOLD = 5;    // votes « info correcte » avant le badge vérifié
const BAD_THRESHOLD = 5;   // votes « mauvaise info » avant suppression automatique
const ADMIN_KEY = process.env.ANNONCES_ADMIN_KEY || 'admin123';
const MAX_LISTINGS = 5000; // garde-fou anti-abus
const COL = 'annonces';
const CONTRIB_COL = 'contributors';

// Points de gamification.
const PTS_CREATE = 10;    // partager une info
const PTS_VOTE = 2;       // noter une annonce (correcte ou fausse)
const PTS_VERIFIED = 25;  // bonus quand une annonce qu'on a partagée devient vérifiée

// Initialisation paresseuse (appelée dans le try/catch du handler) : si les
// identifiants sont absents ou mal formés, on veut une réponse JSON 500 propre,
// pas un crash de la fonction serverless en dehors de toute gestion d'erreur.
let db = null;
function getDb() {
  if (!db) {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Vercel stocke les sauts de ligne échappés (\n littéral) dans les variables d'env :
          // on les reconvertit en vrais retours à la ligne pour le format PEM.
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
    }
    db = getFirestore();
  }
  return db;
}

function toListing(id, d) {
  return {
    id, lat: d.lat, lon: d.lon, type: d.type, source: d.source,
    url: d.url ?? null, note: d.note ?? null, label: d.label ?? null, author: d.author ?? null,
    createdAt: d.createdAt, ok: d.ok || 0, bad: d.bad || 0, verified: (d.ok || 0) >= OK_THRESHOLD,
  };
}
function serialize(doc) { return toListing(doc.id, doc.data()); }

function sanitizePseudo(p) {
  return String(p || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}
// Clé de document stable pour un pseudo (insensible à la casse/aux espaces superflus/aux
// accents — « François » et « francois » doivent pointer vers le même contributeur).
function pseudoKey(p) {
  const ascii = sanitizePseudo(p).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const k = ascii.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return k || null;
}

// Badges calculés à partir des compteurs — purement affichage, aucune conséquence
// fonctionnelle. « Partage » récompense ceux qui signalent des biens, « notation »
// ceux qui votent sur les annonces des autres.
const BADGE_DEFS = [
  { code: 'first_share', icon: '🥉', label: 'Premier signalement', test: (c) => c.listingsCreated >= 1 },
  { code: 'active_sharer', icon: '📣', label: 'Contributeur actif', test: (c) => c.listingsCreated >= 5 },
  { code: 'top_sharer', icon: '🏆', label: 'Pilier de la communauté', test: (c) => c.listingsCreated >= 20 },
  { code: 'reliable', icon: '✅', label: 'Info fiable', test: (c) => c.listingsVerified >= 1 },
  { code: 'local_ref', icon: '🎖️', label: 'Référence locale', test: (c) => c.listingsVerified >= 5 },
  { code: 'watcher', icon: '👀', label: 'Observateur', test: (c) => c.votesCast >= 10 },
  { code: 'checker', icon: '🔍', label: 'Vérificateur assidu', test: (c) => c.votesCast >= 50 },
  { code: 'top_points', icon: '⭐', label: 'Top contributeur', test: (c) => c.points >= 200 },
];
function computeBadges(c) {
  return BADGE_DEFS.filter((b) => b.test(c)).map((b) => ({ code: b.code, icon: b.icon, label: b.label }));
}
function toContributor(doc) {
  const d = doc.data();
  const c = {
    pseudo: d.pseudo || doc.id, points: d.points || 0,
    listingsCreated: d.listingsCreated || 0, listingsVerified: d.listingsVerified || 0, votesCast: d.votesCast || 0,
  };
  return { ...c, badges: computeBadges(c) };
}

// Best-effort : les stats de gamification ne doivent jamais faire échouer l'action
// principale (créer/voter) si Firestore a un souci ponctuel dessus.
async function bumpContributor(db, pseudo, fields) {
  const key = pseudoKey(pseudo);
  if (!key) return;
  try {
    const upd = { pseudo: sanitizePseudo(pseudo), updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(fields)) upd[k] = FieldValue.increment(v);
    await db.collection(CONTRIB_COL).doc(key).set(upd, { merge: true });
  } catch (e) { /* silencieux : la gamification ne doit pas casser le reste */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const db = getDb();
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const q = req.query || {};
      if (q.view === 'leaderboard') {
        const limit = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50));
        const snap = await db.collection(CONTRIB_COL).orderBy('points', 'desc').limit(limit).get();
        res.status(200).json({ contributors: snap.docs.map(toContributor) });
        return;
      }
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
      const pseudo = sanitizePseudo(body.pseudo);
      if (pseudo.length < 2) { res.status(400).json({ error: 'Pseudo requis (2 caractères minimum).' }); return; }
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

      const data = { lat, lon, type, source, url, note, label, author: pseudo, createdAt: new Date().toISOString(), ok: 0, bad: 0 };
      const ref = await db.collection(COL).add(data);
      await bumpContributor(db, pseudo, { points: PTS_CREATE, listingsCreated: 1 });
      res.status(201).json({ listing: toListing(ref.id, data) });
      return;
    }

    if (action === 'vote') {
      const pseudo = sanitizePseudo(body.pseudo);
      if (pseudo.length < 2) { res.status(400).json({ error: 'Pseudo requis (2 caractères minimum).' }); return; }
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
        // Bascule en vérifié pile à ce vote (pas déjà vérifié avant) : bonus à l'auteur.
        const justVerified = field === 'ok' && nextVal === OK_THRESHOLD;
        return { data: { ...d, [field]: nextVal }, justVerified, author: d.author };
      });

      if (result.notFound) { res.status(404).json({ error: 'Annonce introuvable (déjà supprimée ?).' }); return; }
      if (result.removed) { res.status(200).json({ listing: null, removed: true }); return; }

      await bumpContributor(db, pseudo, { points: PTS_VOTE, votesCast: 1 });
      if (result.justVerified && result.author) {
        await bumpContributor(db, result.author, { points: PTS_VERIFIED, listingsVerified: 1 });
      }
      res.status(200).json({ listing: toListing(id, result.data) });
      return;
    }

    if (action === 'verify') {
      if (String(body.adminKey || '') !== ADMIN_KEY) { res.status(403).json({ error: 'Clé admin invalide.' }); return; }
      res.status(200).json({ ok: true });
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

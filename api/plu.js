// GET /api/plu?insee=53130
//   -> { insee, nom, centre, hasPlu, docType:'PLU'|'CC', clipped,
//        features:[ {geometry, properties:{typezone,cat,libelle,libelong}} ], sources }

import { getPluZones } from '../lib/plu.js';

const MAX_BYTES = 4 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const insee = String(req.query.insee || '').trim().toUpperCase();
  if (!/^(\d{5}|2[AB]\d{3})$/.test(insee)) {
    res.status(400).json({ error: 'Paramètre "insee" invalide.' });
    return;
  }

  try {
    const { nom, centre, hasPlu, docType, clipped, reason, zones } = await getPluZones(insee);
    const c0 = centre && centre.coordinates;
    const gpuUrlBase = c0
      ? `https://www.geoportail-urbanisme.gouv.fr/map/#tile=1&lon=${c0[0]}&lat=${c0[1]}&zoom=15&mlon=${c0[0]}&mlat=${c0[1]}`
      : 'https://www.geoportail-urbanisme.gouv.fr/';
    if (!hasPlu) {
      res.status(200).json({
        insee, nom, centre, hasPlu: false, docType: null, features: [], gpu_url: gpuUrlBase,
        message: reason || "Aucun document d'urbanisme numérisé pour cette emprise dans le Géoportail de l'Urbanisme (commune au RNU, ou PLU non versé au GPU).",
      });
      return;
    }

    const feats = zones.map((z) => ({
      type: 'Feature',
      geometry: z.geometry,
      properties: {
        typezone: z.typezone, cat: z.cat, libelle: z.libelle, libelong: z.libelong,
        datappro: z.datappro, partition: z.partition, urlfic: z.urlfic || null,
      },
    }));
    // Lien vers le PLU officiel : carte du Géoportail de l'Urbanisme centrée sur la commune.
    const gpu_url = gpuUrlBase;
    const src = docType === 'CC'
      ? "Géoportail de l'Urbanisme (wfs_du:secteur_cc)"
      : "Géoportail de l'Urbanisme (wfs_du:zone_urba)";
    let body = JSON.stringify({ insee, nom, centre, hasPlu: true, docType, clipped: !!clipped, count: feats.length, gpu_url, features: feats, source: src });

    if (Buffer.byteLength(body) > MAX_BYTES) {
      // simplifie : ne garde que les zones U / AU si le zonage complet est trop lourd
      const light = feats.filter((f) => f.properties.cat === 'U' || f.properties.cat === 'AU');
      body = JSON.stringify({ insee, nom, centre, hasPlu: true, docType, clipped: !!clipped, count: light.length, gpu_url, features: light, partial: true, source: src });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).json({ error: e && e.message ? `Erreur PLU : ${e.message}` : 'Erreur PLU.' });
  }
}

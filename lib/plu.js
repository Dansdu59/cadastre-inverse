// Zonage des documents d'urbanisme via le Géoportail de l'Urbanisme.
// GPU WFS : wfs_du:zone_urba (PLU/PLUi) + wfs_du:secteur_cc (carte communale),
// interrogés sur la bbox de la commune PUIS découpés sur son contour — sans quoi
// les documents des communes voisines débordent dans le rectangle englobant.

import { geomBbox, geomContains } from './geo.js';

const cache = new Map(); // insee -> { ts, nom, centre, hasPlu, docType, clipped, reason, zones }
const TTL = 6 * 60 * 60 * 1000;

export function pluCat(typezone) {
  const t = String(typezone || '').toUpperCase();
  if (t === 'U') return 'U';
  if (t.startsWith('AU')) return 'AU';
  if (t.startsWith('A')) return 'A';
  if (t.startsWith('N')) return 'N';
  return 'autre';
}

// Carte communale : secteur constructible (CCu) ou non constructible (CCn).
// Le libellé CNIG est le plus fiable (ZC / ZCa = constructible, ZnC = non) ;
// à défaut on retombe sur typesect (03/05 = inconstructible, le reste = constructible).
export function ccCat(typesect, libelle) {
  const l = String(libelle || '').trim();
  if (/^znc/i.test(l)) return 'CCn';
  if (/^zc/i.test(l)) return 'CCu';
  const t = String(typesect || '').trim();
  return t === '03' || t === '3' || t === '05' || t === '5' ? 'CCn' : 'CCu';
}

async function communeInfo(insee) {
  const r = await fetch(
    `https://geo.api.gouv.fr/communes/${encodeURIComponent(insee)}?fields=nom,centre,bbox,contour`
  );
  if (!r.ok) return null;
  return r.json();
}

async function wfs(typename, bbox) {
  const url =
    'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
    `&TYPENAMES=${typename}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=6000` +
    '&BBOX=' + bbox.join(',');
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return j.features || [];
  } catch {
    return [];
  }
}

// Sommets des anneaux extérieurs (échantillonnés) + centre de la bbox.
function samplePoints(geom, cap = 64) {
  const pts = [];
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates
    : geom.type === 'Polygon' ? [geom.coordinates] : [];
  for (const poly of polys) for (const c of (poly[0] || [])) pts.push(c);
  const bb = geomBbox(geom);
  pts.push([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]);
  if (pts.length <= cap) return pts;
  const step = Math.ceil(pts.length / cap);
  return pts.filter((_, i) => i % step === 0);
}

// Une zone est rattachée à la commune si ≥ 40 % de ses points-échantillons
// tombent dans le contour communal (rejette les zones purement voisines,
// conserve celles qui chevauchent réellement la limite).
function inCommune(zbb, geom, contour, cbb) {
  if (!contour) return true;
  if (cbb && (zbb[2] < cbb[0] || zbb[0] > cbb[2] || zbb[3] < cbb[1] || zbb[1] > cbb[3])) return false;
  const pts = samplePoints(geom);
  if (!pts.length) return false;
  let hit = 0;
  for (const [x, y] of pts) if (geomContains(contour, x, y)) hit++;
  return hit / pts.length >= 0.4;
}

export async function getPluZones(insee) {
  insee = String(insee).toUpperCase();
  const hit = cache.get(insee);
  if (hit && Date.now() - hit.ts <= TTL) return hit;

  const com = await communeInfo(insee);
  if (!com || !com.bbox) {
    const entry = {
      ts: Date.now(), nom: null, centre: null, hasPlu: false,
      docType: null, clipped: false, reason: 'commune inconnue', zones: [],
    };
    cache.set(insee, entry);
    return entry;
  }
  const ring = com.bbox.coordinates[0];
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const bbox = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)]; // WFS 2.0 lat,lon
  const contour = com.contour && com.contour.type ? com.contour : null;
  const cbb = contour ? geomBbox(contour) : null;

  // 1) PLU / PLUi — couche zone_urba
  const feats = await wfs('wfs_du:zone_urba', bbox);
  const rawPlu = feats.length;
  let zones = feats
    .filter((f) => f.geometry && f.properties)
    .map((f) => {
      const zbb = geomBbox(f.geometry);
      return {
        geometry: f.geometry,
        bbox: zbb,
        typezone: f.properties.typezone || '',
        cat: pluCat(f.properties.typezone),
        libelle: f.properties.libelle || f.properties.typezone || '?',
        libelong: f.properties.libelong || '',
        partition: f.properties.partition || '',
        datappro: f.properties.datappro || null,
        nomfic: f.properties.nomfic || '',
        urlfic: f.properties.urlfic || '',
      };
    });
  let clipped = false;
  if (contour && zones.length) {
    const before = zones.length;
    zones = zones.filter((z) => inCommune(z.bbox, z.geometry, contour, cbb));
    clipped = zones.length !== before;
  }
  let docType = zones.length ? 'PLU' : null;

  // 2) repli carte communale — couche secteur_cc — si aucun zonage PLU propre
  if (!zones.length) {
    const cc = await wfs('wfs_du:secteur_cc', bbox);
    let ccz = cc
      .filter((f) => f.geometry && f.properties)
      .map((f) => {
        const zbb = geomBbox(f.geometry);
        return {
          geometry: f.geometry,
          bbox: zbb,
          typezone: f.properties.typesect || '',
          cat: ccCat(f.properties.typesect, f.properties.libelle),
          libelle: f.properties.libelle || 'Secteur',
          libelong: f.properties.libelong || '',
          partition: f.properties.partition || '',
          datappro: f.properties.datvalid || null,
          nomfic: f.properties.nomfic || '',
          urlfic: f.properties.urlfic || '',
        };
      });
    if (contour && ccz.length) ccz = ccz.filter((z) => inCommune(z.bbox, z.geometry, contour, cbb));
    if (ccz.length) { zones = ccz; docType = 'CC'; clipped = true; }
  }

  const reason = zones.length ? null
    : rawPlu > 0
      ? "Aucun document d'urbanisme ne couvre cette commune dans le Géoportail de l'Urbanisme (les zones des communes voisines ont été écartées) : carte communale non numérisée, POS, RNU, ou document non versé au GPU."
      : "Aucun document d'urbanisme numérisé pour cette emprise dans le Géoportail de l'Urbanisme (commune au RNU, ou PLU non versé au GPU).";

  const entry = {
    ts: Date.now(),
    nom: com.nom,
    centre: com.centre,
    hasPlu: zones.length > 0,
    docType,
    clipped,
    reason,
    zones,
  };
  cache.set(insee, entry);
  return entry;
}

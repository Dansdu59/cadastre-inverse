// Zonage des documents d'urbanisme (PLU/PLUi) via le Géoportail de l'Urbanisme.
// GPU WFS : wfs_du:zone_urba, interrogé sur l'emprise (bbox) de la commune.

import { geomBbox } from './geo.js';

const cache = new Map(); // insee -> { ts, nom, centre, hasPlu, zones }
const TTL = 6 * 60 * 60 * 1000;

export function pluCat(typezone) {
  const t = String(typezone || '').toUpperCase();
  if (t === 'U') return 'U';
  if (t.startsWith('AU')) return 'AU';
  if (t.startsWith('A')) return 'A';
  if (t.startsWith('N')) return 'N';
  return 'autre';
}

async function communeInfo(insee) {
  const r = await fetch(
    `https://geo.api.gouv.fr/communes/${encodeURIComponent(insee)}?fields=nom,centre,bbox`
  );
  if (!r.ok) return null;
  return r.json();
}

export async function getPluZones(insee) {
  insee = String(insee).toUpperCase();
  const hit = cache.get(insee);
  if (hit && Date.now() - hit.ts <= TTL) return hit;

  const com = await communeInfo(insee);
  if (!com || !com.bbox) {
    const entry = { ts: Date.now(), nom: null, centre: null, hasPlu: false, zones: [] };
    cache.set(insee, entry);
    return entry;
  }
  const ring = com.bbox.coordinates[0];
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const bbox = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)]; // WFS 2.0 lat,lon

  const url =
    'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
    '&TYPENAMES=wfs_du:zone_urba&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=6000' +
    '&BBOX=' + bbox.join(',');

  let feats = [];
  try {
    const wr = await fetch(url);
    if (wr.ok) {
      const wj = await wr.json();
      feats = wj.features || [];
    }
  } catch (e) {
    /* GPU indisponible → traité comme "pas de PLU" */
  }

  const zones = feats
    .filter((f) => f.geometry && f.properties)
    .map((f) => ({
      geometry: f.geometry,
      bbox: geomBbox(f.geometry),
      typezone: f.properties.typezone || '',
      cat: pluCat(f.properties.typezone),
      libelle: f.properties.libelle || f.properties.typezone || '?',
      libelong: f.properties.libelong || '',
      partition: f.properties.partition || '',
      datappro: f.properties.datappro || null,
    }));

  const entry = {
    ts: Date.now(),
    nom: com.nom,
    centre: com.centre,
    hasPlu: zones.length > 0,
    zones,
  };
  cache.set(insee, entry);
  return entry;
}

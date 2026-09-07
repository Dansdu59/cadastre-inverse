// Helpers géométriques sans dépendance (GeoJSON, coordonnées [lon, lat]).

export function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// polygon = [anneau_extérieur, trou1, trou2, ...]
export function polygonContains(polygon, x, y) {
  if (!polygon.length || !ringContains(polygon[0], x, y)) return false;
  for (let k = 1; k < polygon.length; k++) if (ringContains(polygon[k], x, y)) return false;
  return true;
}

export function geomContains(geom, x, y) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, x, y);
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) if (polygonContains(poly, x, y)) return true;
  }
  return false;
}

export function geomBbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else for (const cc of c) scan(cc);
  };
  if (geom && geom.coordinates) scan(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

// Centroïde (aire pondérée) de l'anneau extérieur du plus grand polygone.
export function geomCentroid(geom) {
  let rings = [];
  if (!geom) return [0, 0];
  if (geom.type === 'Polygon') rings = [geom.coordinates[0]];
  else if (geom.type === 'MultiPolygon') rings = geom.coordinates.map((p) => p[0]);
  let best = null, bestA = -1;
  for (const r of rings) {
    if (!r || r.length < 3) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
    }
    a *= 0.5;
    const area = Math.abs(a);
    if (area > bestA) {
      bestA = area;
      best = a ? [cx / (6 * a), cy / (6 * a)] : [r[0][0], r[0][1]];
    }
  }
  if (best) return best;
  const b = geomBbox(geom);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function deptDir(insee) {
  if (/^2[AB]/i.test(insee)) return insee.slice(0, 2).toUpperCase();
  if (/^9[78]\d/.test(insee)) return insee.slice(0, 3);
  return insee.slice(0, 2);
}

export function pad(v, n) {
  const s = String(v == null ? '' : v);
  return s.length >= n ? s : '0'.repeat(n - s.length) + s;
}

export function iduOf(p) {
  if (!p) return '';
  if (p.idu) return String(p.idu).toUpperCase();
  if (p.id && /^[0-9A-Za-z]{10,15}$/.test(String(p.id))) return String(p.id).toUpperCase();
  const insee = p.code_insee || p.commune || '';
  const prefixe = pad(p.com_abs != null ? p.com_abs : p.prefixe != null ? p.prefixe : '000', 3);
  return (insee + prefixe + pad(p.section, 2) + pad(p.numero, 4)).toUpperCase();
}

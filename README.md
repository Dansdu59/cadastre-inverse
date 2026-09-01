# Cadastre Inversé — recherche de parcelles cadastrales

Application web : à partir d'une **commune française** et d'une **fourchette de surface**,
localise sur une carte interactive toutes les parcelles cadastrales correspondantes.
Pour chaque parcelle : référence cadastrale (IDU), surface, adresse approximative
(géocodage inverse), liens Google Maps / Street View.

Fonctionne sur **toute la France** (métropole, Corse, DROM).

## Architecture

```
index.html          Front statique (HTML + CSS + JS vanilla, Leaflet 1.9.4 via CDN)
api/parcelles.js     Fonction serverless Vercel — proxy cadastre
vercel.json          Config Vercel (mémoire / durée de la fonction)
```

- **Front** : autocomplétion commune (`geo.api.gouv.fr`), carte Leaflet, fonds
  Plan / Satellite IGN / Satellite Esri, panneau de résultats. Les appels
  `geo.api.gouv.fr` et `api-adresse.data.gouv.fr` (adresse) restent en direct
  navigateur — leur CORS est ouvert.
- **Proxy `/api/parcelles`** : récupère les parcelles **côté serveur** (pas de
  restriction CORS), les filtre par surface, renvoie un GeoJSON allégé.
  - Source principale : `cadastre.data.gouv.fr` (export Etalab, un fichier
    `.json.gz` par commune — rapide même sur les grandes communes).
  - Repli automatique : `apicarto.ign.fr` (pagination) si le fichier Etalab manque.
  - Villes à arrondissements (Paris `75056`, Lyon `69123`, Marseille `13055`) :
    les fichiers d'arrondissement sont récupérés et fusionnés.
  - Cache : mémoire par instance chaude (30 min) + cache CDN Vercel
    (`s-maxage=86400`), partagé entre utilisateurs.
  - Garde-fou : au-delà de ~20 000 parcelles ou ~4 Mo de réponse, l'API renvoie
    un `413` invitant à resserrer la fourchette de surface (limite de corps de
    réponse Vercel).

## Développement local

Nécessite Node ≥ 18 et la CLI Vercel.

```bash
npm i -g vercel
vercel dev
```

Ouvre `http://localhost:3000`. La fonction `api/parcelles.js` est servie automatiquement.

## Déploiement sur Vercel

### Option A — via Git (recommandé)

1. Créer un dépôt Git et pousser ce dossier :
   ```bash
   git init && git add -A && git commit -m "Initial commit"
   git branch -M main
   git remote add origin <URL_DU_DEPOT>
   git push -u origin main
   ```
2. Sur https://vercel.com → **Add New… → Project** → importer le dépôt.
3. Framework Preset : **Other**. Aucune commande de build. Répertoire racine : `.`.
4. **Deploy**. Chaque `git push` redéploie automatiquement.

### Option B — via la CLI

```bash
npm i -g vercel
vercel        # préversion
vercel --prod # production
```

Aucune variable d'environnement ni clé API à configurer.

## Limites connues (v1)

- Recherche à fourchette large sur une très grande commune (Paris, Marseille…) :
  peut dépasser la limite de réponse Vercel → message demandant de resserrer la
  surface. Resserrer la fourchette résout le cas.
- Adresse = géocodage inverse depuis le centre de la parcelle, pas une adresse
  cadastrale officielle.
- Surface = `contenance` cadastrale officielle (peut différer d'un relevé réel).
- Pas de persistance / comptes / partage d'URL (prévu pour une itération suivante).

## Évolutions prévues

- Export CSV / GeoJSON des résultats.
- Partage d'une recherche via URL (commune + surfaces encodées).
- Surface habitable estimée (DVF + BDNB) via le proxy.
- Filtres additionnels (bâti présent ou non, zonage PLU).

## Sources de données

- Parcelles : [cadastre.data.gouv.fr](https://cadastre.data.gouv.fr) (Etalab) /
  [API Carto IGN](https://apicarto.ign.fr).
- Communes : [geo.api.gouv.fr](https://geo.api.gouv.fr).
- Adresses : [Base Adresse Nationale](https://adresse.data.gouv.fr).
- Fonds de carte : OpenStreetMap, IGN Géoplateforme, Esri World Imagery.

Vérifier les conditions d'utilisation de chaque API avant un usage à fort volume
(attribution, quotas — notamment IGN et Base Adresse Nationale).

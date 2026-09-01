// Service worker minimal : présent uniquement pour rendre l'app installable
// (« Ajouter à l'écran d'accueil »). Aucune mise en cache — l'app s'appuie
// sur des données live (parcelles, cartes, adresses).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // pass-through : on laisse le réseau gérer chaque requête
});

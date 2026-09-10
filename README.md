# 🐍 Neon Serpents

Arène multijoueur temps réel, jouable dans le navigateur : tu diriges un serpent de néon,
tu avales des orbes pour grandir, et tu fais mourir les autres en leur coupant la route.
Le tout en **temps réel via WebSocket**, avec un **serveur autoritatif** (impossible de tricher
côté client) et des **bots** pour que l'arène ne soit jamais vide.

- Node.js + Express + Socket.IO côté serveur (boucle de jeu à 20 ticks/s)
- Canvas 2D natif côté client (aucun framework, aucun build, aucune dépendance front)
- Prêt pour un déploiement **Render — Web Service** (WebSocket obligatoire, donc pas un site statique)

---

## 1. Lancer en local

```bash
npm install
npm start
# → http://localhost:3000
```

Autres commandes :

```bash
npm run dev     # redémarrage auto à chaque modification (node --watch)
npm test        # 37 tests (moteur de jeu + serveur HTTP/WebSocket)
npm run lint    # ESLint
```

Ouvre deux onglets pour jouer à plusieurs sur la même machine, ou connecte-toi
depuis ton téléphone sur `http://<ip-locale>:3000`.

## 2. Déployer sur Render (Web Service)

### Option A — via `render.yaml` (Blueprint, le plus simple)

1. Pousse ce dossier sur un nouveau dépôt GitHub.
2. Sur Render : **New + → Blueprint**, choisis le dépôt, valide.
   Le fichier [`render.yaml`](./render.yaml) fait le reste.

### Option B — à la main

1. **New + → Web Service**, connecte le dépôt GitHub.
2. Renseigne :
   - **Runtime / Language** : `Node`
   - **Build Command** : `npm ci --omit=dev`
   - **Start Command** : `npm start`
   - **Health Check Path** : `/healthz`
   - **Instance Type** : Free (suffisant)
3. Déploie. Render fournit la variable `PORT`, le serveur l'utilise automatiquement.

Rien d'autre à configurer : aucune variable d'environnement n'est obligatoire.

> ℹ️ **Plan gratuit Render** : l'instance s'endort après ~15 min sans trafic et le disque est
> éphémère. Le *hall of fame* est donc conservé en mémoire (et écrit dans `data/` en
> best-effort) : il repart à zéro après une mise en veille. Pour le rendre permanent,
> ajoute un disque persistant Render et pointe `DATA_FILE` dessus, ou branche une base.

### Variables d'environnement (toutes optionnelles)

| Variable    | Défaut                        | Rôle                                   |
| ----------- | ----------------------------- | -------------------------------------- |
| `PORT`      | `3000` (fourni par Render)    | port d'écoute HTTP/WebSocket           |
| `DATA_FILE` | `./data/hall-of-fame.json`    | fichier des meilleurs scores           |
| `NODE_ENV`  | —                             | `production` sur Render                |

## 3. Comment on joue

| Action        | Clavier / souris                 | Mobile                      |
| ------------- | -------------------------------- | --------------------------- |
| Diriger       | la souris                        | glisser le doigt            |
| Accélérer     | clic maintenu ou `Espace`        | double appui / deux doigts  |
| Rejouer       | `Entrée` ou le bouton « Rejouer »| bouton « Rejouer »          |

Règles :

- Les orbes donnent 1 à 4 points de masse ; plus tu es gros, plus tu es lent à tourner et large.
- **Ta tête** est ta seule zone fragile : si elle touche le corps d'un autre serpent ou la
  barrière de l'arène, tu exploses et ta masse est redistribuée en orbes.
- Une élimination rapporte **+25 points**.
- L'accélération consomme de la masse et laisse une traînée d'orbes derrière toi.
- 2,5 s d'invulnérabilité (serpent translucide) après chaque réapparition.

## 4. Architecture

```
server/
  index.js        Express + Socket.IO + boucle de jeu + arrêt propre (SIGTERM Render)
  game.js         moteur autoritatif : déplacement, collisions, bots, snapshots
  config.js       toutes les constantes de gameplay
  names.js        générateur de pseudos pour les bots
  hall-of-fame.js top 10 all-time, persistance best-effort
public/
  index.html      menu, HUD, écran de mort
  styles.css      thème néon, responsive, mobile-first
  main.js         rendu Canvas, interpolation réseau, entrées clavier/souris/tactile
test/
  game.test.js    moteur (collisions, boost, invariants sur 1200 ticks…)
  server.test.js  bout en bout : HTTP, WebSocket, join/mort/respawn, persistance
```

Points clés d'implémentation :

- **Serveur autoritatif** : le client n'envoie qu'un angle et un booléen « boost ». Toute la
  simulation (positions, collisions, score) vit sur le serveur ; une entrée invalide (`NaN`,
  type inattendu) est filtrée sans jamais corrompre l'état.
- **Snapshots par joueur** avec culling de zone d'intérêt : chaque client ne reçoit que ce qui
  est visible autour de lui (≈ 1250 px), coordonnées arrondies pour limiter la bande passante.
- **Interpolation client** : rendu avec 110 ms de retard entre deux snapshots → mouvement
  fluide à 60 fps malgré un flux réseau à 20 Hz.
- **Hash spatial** pour la nourriture : la détection « manger » reste O(cellules) même avec
  1800 orbes.
- **Bots** : évitement du mur, esquive des corps proches, recherche de nourriture, respawn.

## 5. Endpoints utiles

| Route              | Réponse                                          |
| ------------------ | ------------------------------------------------ |
| `GET /healthz`     | `{ ok, uptime, players, food }` (health check)   |
| `GET /api/leaderboard` | classement live + hall of fame               |
| `GET /api/config`  | constantes de gameplay (pratique pour débugger)  |

## 6. Licence

MIT — fais-en ce que tu veux.

# ⚽ elfutbolistico

Jeu de football multijoueur temps réel, jouable à plusieurs — **chacun sur son propre téléphone** — via un serveur central autoritaire.

- **Backend** : Node.js + Express + Socket.io (physique, collisions, règles, IA, anti-triche).
- **Frontend** : page unique HTML/Canvas 2D responsive (portrait & paysage), connectée en Socket.io.
- **Serveur autoritaire** : il simule tout le monde à 30 ticks/s et diffuse l'état ; le client interpole pour un affichage fluide.

## Lancer le projet

```bash
npm install
npm start
```

Puis ouvrir **http://localhost:3000** sur chaque téléphone (les téléphones doivent être sur le même réseau que le serveur ; remplacer `localhost` par l'IP de la machine, ex. `http://192.168.1.20:3000`).

`npm run dev` relance automatiquement à chaque modification.

## Déploiement (VPS + nom de domaine)

- `PORT` : port d'écoute (défaut `3000`).
- `PUBLIC_URL` : URL publique complète (ex. `https://elfutbolistico.mondomaine.com`) affichée dans le QR code et le lien de partage à la place de l'IP LAN auto-détectée. À définir en prod.
- Le serveur écoute sur `0.0.0.0` : à mettre derrière un reverse proxy (Nginx/Caddy) qui gère TLS et **transmet l'upgrade WebSocket** (obligatoire pour Socket.io), et à garder vivant avec un gestionnaire de process (pm2, systemd…).

```bash
PORT=3000 PUBLIC_URL=https://elfutbolistico.mondomaine.com npm start
```

## Boucle de jeu

1. **Accueil** : créer une partie (code à 5 caractères) ou rejoindre avec un code.
2. **Salon** : choisir son camp (A/B). L'hôte choisit le **format** (1v1 vs IA, 1v1, 2v1, 2v2, 3v2, 3v3) et la **difficulté de l'IA** (facile/moyen/difficile). Chacun se met « prêt », l'hôte lance.
3. **Match** : chaque humain reçoit un joueur ; les postes libres sont gérés par l'IA.

### Contrôles (tactiles)
- **Joystick** (bas-gauche) : déplacer le joueur contrôlé.
- **Boutons** : Passe · Centre · Longue · **Tir** (jauge de puissance selon la durée d'appui) · Tacle. **Sprint** à gauche (jauge d'endurance).
- Gardien contrôlé : le bouton devient **Plongeon** (avec cooldown).
- **Changer de joueur** : taper sur n'importe quel joueur de **son** équipe pour en prendre le contrôle. Refusé si un autre humain le contrôle déjà (feedback visuel).

## Mécaniques implémentées

Physique du ballon (inertie, friction, axe vertical/cloche, rebonds bords & poteaux) · possession au contact · passes courtes avec assistance de ciblage · passes longues · centres en cloche · tirs (puissance/précision) · reprises de volée · têtes sur ballon aérien · tacles avec risque de faute et cooldown · collisions joueur-joueur sans superposition · buts (franchissement de ligne entre poteaux) · touches, corners et dégagements automatiques selon le dernier toucher · engagement, mi-temps, fin de match.

**IA** : formation dynamique (repli défensif / soutien offensif / pressing / marquage), décision du porteur (dribble/passe/tir/centre), gardien réactif (placement selon l'angle, sorties, plongeons sur tir cadré).

## Structure

```
server/
  index.js    Express + Socket.io, salons (lobby), boucle de tick, routage inputs/actions/contrôle
  match.js    Moteur autoritaire : état du monde, physique, possession, mécaniques, règles
  ai.js       IA des postes non contrôlés (déplacement, décisions, gardien)
public/
  index.html  Écrans accueil / lobby / jeu / fin
  style.css   Interface responsive mobile
  client.js   Socket.io, interpolation, rendu Canvas, contrôles tactiles
  shared.js   Constantes & helpers partagés serveur/client (UMD)
```

## Robustesse

- **Déconnexion** : les joueurs contrôlés par le partant repassent automatiquement en IA.
- **Anti-conflit** : le serveur valide chaque prise de contrôle (un même joueur ne peut être pris par deux humains).
- Toute la logique de jeu est calculée côté serveur ; le client n'envoie que des intentions (inputs/actions).

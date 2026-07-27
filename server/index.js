/*
 * index.js — Serveur Express + Socket.io.
 * Sert le client, gère les salons (lobby), les connexions/déconnexions, la boucle
 * de tick des matchs et le routage des inputs / actions / changements de contrôle.
 */
'use strict';

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const S = require('../public/shared');
const { Match } = require('./match');
const { FORMATS, DIFFICULTY, PHYS } = S;

// Détecte la première adresse IPv4 du réseau local (pour se connecter au tel).
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));
// Three.js servi en local (module ESM) — pas de CDN, fonctionne hors-ligne
app.use('/vendor/three', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));
// Addons Three.js (FBXLoader, SkeletonUtils…) pour le personnage Mixamo
app.use('/vendor/three-addons', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm')));

const PORT = Number(process.env.PORT) || 3000;
const LAN_IP = getLanIp();
// En production (VPS + nom de domaine, souvent derrière un reverse proxy sur
// 80/443), PUBLIC_URL fixe l'URL externe affichée (QR code, lien de partage) —
// sinon on retombe sur l'IP LAN + port, pratique en dev sur réseau local.
const PUBLIC_URL = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : null;
let ACTIVE_PORT = PORT;                              // port réellement utilisé (peut changer si occupé)
const gameUrl = () => PUBLIC_URL || `http://${LAN_IP}:${ACTIVE_PORT}`;

// Page /qr : affiche le QR code en grand pour scanner avec un téléphone.
app.get('/qr', async (req, res) => {
  try {
    const GAME_URL = gameUrl();
    const dataUrl = await QRCode.toDataURL(GAME_URL, { width: 320, margin: 2 });
    res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Scanner pour jouer</title>
      <style>body{font-family:system-ui,sans-serif;background:#0d1b12;color:#f2f5f2;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        height:100vh;margin:0;text-align:center}
        img{background:#fff;padding:14px;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
        h1{font-size:22px} a{color:#ffd23f;font-size:20px;font-weight:700;text-decoration:none;margin-top:14px}
        p{opacity:.6}</style></head>
      <body><h1>⚽ Scanne pour rejoindre</h1>
      <img src="${dataUrl}" alt="QR code">
      <a href="${GAME_URL}">${GAME_URL}</a>
      <p>Le téléphone doit être sur le même réseau Wi-Fi</p></body></html>`);
  } catch (e) { res.status(500).send('Erreur QR'); }
});

// -----------------------------------------------------------------------------
// Salons
// -----------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

// Jetons de session : permettent à un joueur qui recharge la page (nouveau
// socketId) de retrouver son salon et le joueur qu'il pilotait. Le client
// génère un jeton persistant (localStorage) envoyé à la connexion. On garde
// une correspondance jeton -> code de salon pour retrouver le membre.
/** @type {Map<string, { code: string }>} */
const sessions = new Map();
// Fenêtre pendant laquelle un membre déconnecté reste réservé (rechargement,
// coupure réseau brève). Passé ce délai, il est retiré pour de bon.
const GRACE_MS = 45000;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.members = new Map(); // socketId -> { name, team, ready }
    this.format = '1v1-ai';
    this.difficulty = 'medium';
    this.state = 'lobby';     // lobby | playing | ended
    this.match = null;
    this.loop = null;
  }

  addMember(socketId, name, token) {
    this.members.set(socketId, {
      name: name || 'Joueur', team: null, ready: false,
      token: token || null, connected: true, controlPid: null, graceTimer: null,
    });
    if (!this.hostId || !this.members.has(this.hostId)) this.hostId = socketId;
  }

  removeMember(socketId) {
    this.members.delete(socketId);
    if (socketId === this.hostId) {
      // Nouveau host = premier membre restant
      this.hostId = this.members.keys().next().value || null;
    }
  }

  lobbyState() {
    return {
      code: this.code,
      hostId: this.hostId,
      format: this.format,
      difficulty: this.difficulty,
      state: this.state,
      formats: Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v.label])),
      members: Array.from(this.members.entries()).map(([id, m]) => ({
        id, name: m.name, team: m.team, ready: m.ready, host: id === this.hostId,
      })),
    };
  }

  onMatchEnd() {
    this.state = 'ended';
    this.stopLoop();
  }

  stopLoop() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', room.lobbyState());
}

function getRoomOf(socket) {
  const code = socket.data.room;
  return code ? rooms.get(code) : null;
}

// Retrait définitif d'un membre (grâce expirée ou départ volontaire) : libère
// son joueur, oublie sa session et supprime le salon s'il devient vide.
function finalizeLeave(room, socketId) {
  const m = room.members.get(socketId);
  if (m) {
    if (m.graceTimer) clearTimeout(m.graceTimer);
    if (m.token) sessions.delete(m.token);
  }
  if (room.match) room.match.releaseControl(socketId);
  room.removeMember(socketId);
  if (room.members.size === 0) {
    room.stopLoop();
    rooms.delete(room.code);
  } else {
    broadcastLobby(room);
  }
}

// Tente de reprendre une session existante à la connexion (page rechargée ou
// reconnexion réseau). Retourne true si le joueur a été rebranché sur son salon.
function attemptResume(socket, token) {
  if (!token) return false;
  const rec = sessions.get(token);
  if (!rec) return false;
  const room = rooms.get(rec.code);
  if (!room) { sessions.delete(token); return false; }

  // Retrouve le membre (encore indexé sous son ancien socketId) via son jeton.
  let oldSid = null;
  for (const [sid, m] of room.members) { if (m.token === token) { oldSid = sid; break; } }
  if (oldSid == null) return false;

  const m = room.members.get(oldSid);
  if (m.graceTimer) { clearTimeout(m.graceTimer); m.graceTimer = null; }
  m.connected = true;

  // Ré-indexe le membre sous le nouveau socketId.
  room.members.delete(oldSid);
  room.members.set(socket.id, m);
  if (room.hostId === oldSid) room.hostId = socket.id;

  socket.join(room.code);
  socket.data.room = room.code;
  socket.data.token = token;

  // Match en cours : on reprend le joueur piloté avant la coupure (repassé en
  // IA pendant l'absence) s'il est libre, sinon un autre joueur de l'équipe.
  if (room.match && m.team && m.controlPid != null) {
    m.controlPid = room.match.reclaim(socket.id, m.team, m.controlPid);
  }

  socket.emit('resumed', {
    code: room.code, state: room.state,
    format: room.format, difficulty: room.difficulty,
  });
  broadcastLobby(room);
  return true;
}

// -----------------------------------------------------------------------------
// Boucle de match
// -----------------------------------------------------------------------------
function startMatch(room) {
  room.match = new Match(room, room.format, room.difficulty);
  room.state = 'playing';

  // Assignation initiale : chaque humain d'une équipe prend un joueur libre
  const teamCount = { A: 0, B: 0 };
  for (const [sid, m] of room.members) {
    if (!m.team) continue;
    // En 1v1-ai, seule l'équipe A est humaine
    if (room.format === '1v1-ai' && m.team === 'B') continue;
    const pid = room.match.autoAssign(sid, m.team);
    m.controlPid = pid;
    teamCount[m.team]++;
  }

  io.to(room.code).emit('matchStart', { format: room.format, difficulty: room.difficulty });

  const interval = 1000 / PHYS.TICK_HZ;
  room.stopLoop();
  room.loop = setInterval(() => {
    if (!room.match) return;
    const snap = room.match.tick();
    io.to(room.code).emit('state', snap);
  }, interval);
}

// -----------------------------------------------------------------------------
// Connexions Socket.io
// -----------------------------------------------------------------------------
io.on('connection', (socket) => {
  // Jeton de session envoyé par le client (persisté côté navigateur).
  const token = (socket.handshake.auth && socket.handshake.auth.token) || null;
  socket.data.token = token;
  // Si une session est encore active, on rebranche le joueur sur son salon.
  attemptResume(socket, token);

  socket.on('createRoom', ({ name } = {}, cb) => {
    const code = genCode();
    const room = new Room(code, socket.id);
    rooms.set(code, room);
    joinRoom(socket, room, name);
    cb && cb({ ok: true, code });
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: 'Salon introuvable' });
    if (room.state === 'playing') return cb && cb({ ok: false, error: 'Match déjà en cours' });
    joinRoom(socket, room, name);
    cb && cb({ ok: true, code });
  });

  function joinRoom(socket, room, name) {
    socket.join(room.code);
    socket.data.room = room.code;
    room.addMember(socket.id, name, socket.data.token);
    if (socket.data.token) sessions.set(socket.data.token, { code: room.code });
    broadcastLobby(room);
  }

  socket.on('chooseTeam', ({ team } = {}) => {
    const room = getRoomOf(socket);
    if (!room || room.state !== 'lobby') return;
    if (team !== 'A' && team !== 'B') return;
    // En 1v1-ai, équipe B réservée à l'IA
    if (room.format === '1v1-ai' && team === 'B') return;
    const m = room.members.get(socket.id);
    if (m) { m.team = team; m.ready = false; }
    broadcastLobby(room);
  });

  socket.on('setFormat', ({ format } = {}) => {
    const room = getRoomOf(socket);
    if (!room || room.state !== 'lobby' || socket.id !== room.hostId) return;
    if (!FORMATS[format]) return;
    room.format = format;
    // Si on passe en 1v1-ai, retire les joueurs de l'équipe B
    if (format === '1v1-ai') {
      for (const m of room.members.values()) if (m.team === 'B') m.team = null;
    }
    broadcastLobby(room);
  });

  socket.on('setDifficulty', ({ difficulty } = {}) => {
    const room = getRoomOf(socket);
    if (!room || room.state !== 'lobby' || socket.id !== room.hostId) return;
    if (!DIFFICULTY[difficulty]) return;
    room.difficulty = difficulty;
    broadcastLobby(room);
  });

  socket.on('toggleReady', () => {
    const room = getRoomOf(socket);
    if (!room || room.state !== 'lobby') return;
    const m = room.members.get(socket.id);
    if (m && m.team) { m.ready = !m.ready; broadcastLobby(room); }
  });

  socket.on('startMatch', () => {
    const room = getRoomOf(socket);
    if (!room || room.state !== 'lobby' || socket.id !== room.hostId) return;
    // Vérifie qu'au moins un joueur humain est prêt et a une équipe
    const withTeam = Array.from(room.members.values()).filter(m => m.team);
    if (withTeam.length === 0) return;
    const allReady = withTeam.every(m => m.ready);
    if (!allReady) return;
    startMatch(room);
  });

  socket.on('backToLobby', () => {
    const room = getRoomOf(socket);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    room.stopLoop();
    room.match = null;
    room.state = 'lobby';
    for (const m of room.members.values()) m.ready = false;
    io.to(room.code).emit('returnLobby');
    broadcastLobby(room);
  });

  // ---- Jeu ------------------------------------------------------------------
  socket.on('input', (data) => {
    const room = getRoomOf(socket);
    if (room && room.match) room.match.setInput(socket.id, data || {});
  });

  socket.on('action', (data) => {
    const room = getRoomOf(socket);
    if (room && room.match) room.match.doAction(socket.id, data || {});
  });

  socket.on('switchPlayer', ({ pid } = {}) => {
    const room = getRoomOf(socket);
    if (!room || !room.match) return;
    const m = room.members.get(socket.id);
    if (!m || !m.team) return;
    const res = room.match.requestSwitch(socket.id, m.team, pid);
    if (res.ok) { m.controlPid = res.pid; }
    else socket.emit('switchDenied', res);
  });

  // ---- Départ volontaire (bouton Quitter) -----------------------------------
  // Retrait immédiat + oubli de la session : recharger ne fera PAS revenir.
  socket.on('leaveRoom', () => {
    const room = getRoomOf(socket);
    if (!room) return;
    socket.leave(room.code);
    socket.data.room = null;
    finalizeLeave(room, socket.id);
  });

  // ---- Déconnexion ----------------------------------------------------------
  socket.on('disconnect', () => {
    const room = getRoomOf(socket);
    if (!room) return;
    const m = room.members.get(socket.id);
    if (!m) return;
    // Le(s) joueur(s) contrôlé(s) repasse(nt) en IA le temps de l'absence…
    if (room.match) room.match.releaseControl(socket.id);
    m.connected = false;
    // …mais le membre reste réservé (grâce) pour permettre une reconnexion.
    m.graceTimer = setTimeout(() => finalizeLeave(room, socket.id), GRACE_MS);
  });
});

// Démarre l'écoute ; si le port est occupé, tente automatiquement le suivant.
function startListening(port, attemptsLeft = 10) {
  ACTIVE_PORT = port;
  server.listen(port, '0.0.0.0');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && ACTIVE_PORT - PORT < 10) {
    console.log(`   ⚠ Port ${ACTIVE_PORT} déjà utilisé, tentative sur ${ACTIVE_PORT + 1}…`);
    setTimeout(() => startListening(ACTIVE_PORT + 1), 150);
  } else {
    console.error('Erreur serveur :', err.message);
    process.exit(1);
  }
});

server.on('listening', async () => {
  const GAME_URL = gameUrl();
  console.log('\n⚽  elfutbolistico');
  console.log('   Sur cet ordinateur : http://localhost:' + ACTIVE_PORT);
  console.log('   Depuis un téléphone : ' + GAME_URL + '   (page QR : ' + GAME_URL + '/qr)\n');
  // QR code directement dans le terminal — scanne-le avec l'appareil photo du tel.
  try {
    const qr = await QRCode.toString(GAME_URL, { type: 'terminal', small: true });
    console.log(qr);
  } catch (e) { /* pas bloquant */ }
});

startListening(PORT);

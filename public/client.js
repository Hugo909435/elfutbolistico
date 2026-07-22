/*
 * client.js — Client de jeu (module ES).
 * Écrans (accueil/lobby/jeu/fin), connexion Socket.io, réception de l'état avec
 * interpolation, rendu 3D délégué à Scene3D (Three.js), contrôles tactiles
 * (joystick + boutons relatifs à la caméra 3e personne, tap = changement de
 * joueur contrôlé via raycast 3D).
 */
import { Scene3D } from './scene3d.js';

const { PHYS, clamp, lerp, len, norm, angleLerp } = window.SHARED;
const socket = window.io();
const $ = (id) => document.getElementById(id);

// État local
let myName = 'Joueur', myTeam = null, roomCode = null, isHost = false;

// Tampon de snapshots pour interpolation bufferisée : on rend le jeu avec un
// léger retard fixe (~2 ticks), ce qui absorbe la gigue réseau et rend le
// ballon/joueurs parfaitement fluides.
const TICK_MS = 1000 / PHYS.TICK_HZ;
const INTERP_DELAY = TICK_MS * 2.2;
let snapBuf = [];            // [{ t: heure de réception, s: snapshot }]
let curState = null;         // dernier snapshot brut (HUD, tap, fin de match)

// Scène 3D (créée à l'entrée en jeu)
let scene = null, gameActive = false;

// Mode visée (remise en jeu figée) : le joystick fait tourner la caméra
// autour du tireur pour choisir à qui passer.
let aimMode = false, aimAngle = 0;

function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + screen).classList.add('active');
  gameActive = (screen === 'game');
  if (gameActive) ensureScene();
}

function ensureScene() {
  if (!scene) scene = new Scene3D($('game-canvas'));
  scene.resize();
}

// ==========================================================================
// ACCUEIL
// ==========================================================================
$('btn-create').onclick = () => {
  myName = ($('input-name').value || 'Joueur').trim();
  socket.emit('createRoom', { name: myName }, (res) => { if (res.ok) { roomCode = res.code; show('lobby'); } });
};
$('btn-join').onclick = () => {
  myName = ($('input-name').value || 'Joueur').trim();
  const code = ($('input-code').value || '').toUpperCase().trim();
  if (!code) return;
  socket.emit('joinRoom', { code, name: myName }, (res) => {
    if (res.ok) { roomCode = res.code; show('lobby'); }
    else $('home-error').textContent = res.error || 'Erreur';
  });
};

// ==========================================================================
// LOBBY
// ==========================================================================
document.querySelectorAll('.choose-team').forEach(btn => {
  btn.onclick = () => socket.emit('chooseTeam', { team: btn.dataset.team });
});
$('btn-ready').onclick = () => socket.emit('toggleReady');
$('btn-start').onclick = () => socket.emit('startMatch');
$('btn-leave').onclick = () => { socket.disconnect(); location.reload(); };
$('select-format').onchange = (e) => socket.emit('setFormat', { format: e.target.value });
$('select-difficulty').onchange = (e) => socket.emit('setDifficulty', { difficulty: e.target.value });

socket.on('lobby', (state) => {
  roomCode = state.code;
  isHost = state.members.find(m => m.id === socket.id)?.host || false;
  const me = state.members.find(m => m.id === socket.id);
  myTeam = me ? me.team : null;

  $('lobby-code').textContent = state.code;
  const listA = $('team-a-list'), listB = $('team-b-list');
  listA.innerHTML = ''; listB.innerHTML = '';
  for (const m of state.members) {
    if (!m.team) continue;
    const li = document.createElement('li');
    if (m.ready) li.classList.add('ready');
    const tags = [m.host ? 'hôte' : '', m.ready ? '✓ prêt' : '', m.id === socket.id ? 'toi' : ''].filter(Boolean).join(' · ');
    li.innerHTML = `<span>${escapeHtml(m.name)}</span><span class="tag">${tags}</span>`;
    (m.team === 'A' ? listA : listB).appendChild(li);
  }

  const sel = $('select-format');
  if (sel.options.length !== Object.keys(state.formats).length) {
    sel.innerHTML = '';
    for (const [k, label] of Object.entries(state.formats)) {
      const o = document.createElement('option'); o.value = k; o.textContent = label; sel.appendChild(o);
    }
  }
  sel.value = state.format;
  $('select-difficulty').value = state.difficulty;

  $('host-controls').style.display = isHost ? 'flex' : 'none';
  $('config-readonly').textContent = isHost ? '' : `Format : ${state.formats[state.format]} · IA : ${state.difficulty}`;
  $('btn-start').style.display = isHost ? 'block' : 'none';
  document.querySelector('.choose-team.team-b').disabled = (state.format === '1v1-ai');
});

socket.on('returnLobby', () => show('lobby'));

// ==========================================================================
// MATCH
// ==========================================================================
socket.on('matchStart', () => { snapBuf = []; curState = null; show('game'); });

socket.on('state', (snap) => {
  curState = snap;
  snapBuf.push({ t: performance.now(), s: snap });
  if (snapBuf.length > 40) snapBuf.shift();
  updateHud(snap);
  if (snap.phase === 'fulltime') showEnd(snap);
});

socket.on('switchDenied', (res) => { if (res.reason === 'taken') flashFeedback('Joueur déjà contrôlé !'); });

$('btn-return').onclick = () => { socket.emit('backToLobby'); show('lobby'); };

function showEnd(snap) {
  $('end-score').textContent = `${snap.score.a} - ${snap.score.b}`;
  let res = 'Match nul';
  if (snap.score.a > snap.score.b) res = 'Victoire équipe A';
  else if (snap.score.b > snap.score.a) res = 'Victoire équipe B';
  $('end-result').textContent = res;
  $('btn-return').style.display = isHost ? 'block' : 'none';
  setTimeout(() => show('end'), 1500);
}

// ---- HUD ------------------------------------------------------------------
function updateHud(snap) {
  $('hud-score').textContent = `${snap.score.a} - ${snap.score.b}`;
  const mm = String(Math.floor(snap.time / 60)).padStart(2, '0');
  const ss = String(snap.time % 60).padStart(2, '0');
  $('hud-time').textContent = `${mm}:${ss}` + (snap.half === 2 ? ' (2e)' : '');

  const mine = snap.players.find(p => p.c === socket.id);
  // Entrée/sortie du mode visée (remise en jeu figée)
  const nowAim = !!(mine && mine.fz);
  if (nowAim && !aimMode) aimAngle = mine.f;   // départ : direction actuelle du tireur
  aimMode = nowAim;
  $('hud-ctrl').textContent = aimMode
    ? '🎯 Joystick : tourner la vue · bouton : passer'
    : (mine ? `Tu contrôles : ${mine.id}${mine.gk ? ' (GB)' : ''}` : 'Tape un joueur pour le contrôler');

  const msgEl = $('hud-message');
  if (snap.message) { msgEl.textContent = snap.message; msgEl.classList.add('show'); }
  else msgEl.classList.remove('show');

  setupActionButtons(mine && mine.gk);
  if (mine) $('sprint-gauge').querySelector('i').style.width = (mine.sp || 0) + '%';
}

function flashFeedback(text) {
  const el = $('switch-feedback');
  el.textContent = text; el.classList.remove('show');
  void el.offsetWidth; el.classList.add('show');
}

// ==========================================================================
// INTERPOLATION + BOUCLE DE RENDU
// ==========================================================================
function interpState() {
  if (!snapBuf.length) return curState;
  const rt = performance.now() - INTERP_DELAY;   // heure de rendu (décalée)
  // Trouve les deux snapshots qui encadrent l'heure de rendu
  let a = snapBuf[0], b = snapBuf[0];
  for (let i = snapBuf.length - 1; i >= 0; i--) {
    if (snapBuf[i].t <= rt) { a = snapBuf[i]; b = snapBuf[i + 1] || snapBuf[i]; break; }
    b = snapBuf[i];
  }
  const span = b.t - a.t;
  const t = span > 0 ? clamp((rt - a.t) / span, 0, 1) : 1;
  return blendSnaps(a.s, b.s, t);
}

function blendSnaps(pa, pb, t) {
  const map = new Map(pa.players.map(p => [p.i, p]));
  const players = pb.players.map(cp => {
    const pp = map.get(cp.i) || cp;
    return { ...cp, x: lerp(pp.x, cp.x, t), y: lerp(pp.y, cp.y, t), f: angleLerp(pp.f, cp.f, t) };
  });
  const ball = {
    ...pb.ball,
    x: lerp(pa.ball.x, pb.ball.x, t),
    y: lerp(pa.ball.y, pb.ball.y, t),
    z: lerp(pa.ball.z, pb.ball.z, t),
  };
  return { ...pb, players, ball };
}

function loop() {
  requestAnimationFrame(loop);
  if (gameActive && scene) scene.update(interpState(), { myTeam, mySocket: socket.id, aim: aimMode ? aimAngle : null });
}
loop();
window.addEventListener('resize', () => { if (scene) scene.resize(); });

// ==========================================================================
// CONTRÔLES TACTILES
// ==========================================================================
// ---- Joystick (valeurs écran brutes, converties au repère caméra) ----------
const joy = $('joystick'), knob = $('joystick-knob');
let joyId = null, joyCenter = { x: 0, y: 0 }, joyRaw = { x: 0, y: 0 };
let lastDir = { x: 1, y: 0 }, sprintHeld = false;

function joyStart(e) {
  const t = e.changedTouches ? e.changedTouches[0] : e;
  joyId = e.changedTouches ? t.identifier : 'mouse';
  const rect = joy.getBoundingClientRect();
  joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  joyMove(e);
}
function joyMove(e) {
  if (joyId === null) return;
  const t = getTouch(e, joyId); if (!t) return;
  let dx = t.clientX - joyCenter.x, dy = t.clientY - joyCenter.y;
  const max = 52, d = len(dx, dy);
  if (d > max) { dx = dx / d * max; dy = dy / d * max; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  joyRaw = { x: dx / max, y: dy / max };
  sendInput();
}
function joyEnd(e) {
  if (!hasTouch(e, joyId)) return;
  joyId = null; joyRaw = { x: 0, y: 0 };
  knob.style.transform = 'translate(0,0)';
  sendInput();
}
joy.addEventListener('touchstart', (e) => { e.preventDefault(); joyStart(e); }, { passive: false });
joy.addEventListener('touchmove', (e) => { e.preventDefault(); joyMove(e); }, { passive: false });
joy.addEventListener('touchend', joyEnd);
joy.addEventListener('mousedown', joyStart);
window.addEventListener('mousemove', (e) => { if (joyId === 'mouse') joyMove(e); });
window.addEventListener('mouseup', (e) => { if (joyId === 'mouse') joyEnd(e); });

function getTouch(e, id) {
  if (id === 'mouse') return e;
  const list = (e.touches && e.touches.length) ? e.touches : e.changedTouches;
  if (!list) return null;
  for (const t of list) if (t.identifier === id) return t;
  return null;
}
function hasTouch(e, id) {
  if (id === 'mouse') return true;
  if (!e.changedTouches) return false;
  for (const t of e.changedTouches) if (t.identifier === id) return true;
  return false;
}

// Convertit le joystick (repère écran) en vecteur monde relatif à la caméra.
function joyToWorld() {
  if (!scene) return { x: joyRaw.x, y: joyRaw.y };
  const b = scene.cameraBasis();
  const x = b.fwd.x * (-joyRaw.y) + b.right.x * joyRaw.x;
  const z = b.fwd.z * (-joyRaw.y) + b.right.z * joyRaw.x;
  return { x, y: z };   // y monde = axe Z de la scène
}

// Envoi d'input à cadence fixe (30 Hz), qu'il y ait mouvement ou non :
// le serveur a toujours un état d'input frais, aucun "trou" de commande.
function sendInput() {
  if (aimMode) {
    // Mode visée : joystick horizontal = rotation de la vue autour du tireur.
    // On envoie la direction visée (le serveur oriente le tireur sans le bouger).
    aimAngle += joyRaw.x * 2.4 * 0.033;
    socket.emit('input', { mx: Math.cos(aimAngle), my: Math.sin(aimAngle), sprint: false });
    return;
  }
  const w = joyToWorld();
  if (len(w.x, w.y) > 0.15) lastDir = norm(w.x, w.y);
  socket.emit('input', { mx: w.x, my: w.y, sprint: sprintHeld });
}
setInterval(sendInput, 33);

// ---- Boutons d'action (direction visée = joystick, sinon dernière direction)
function actionDir() {
  if (aimMode) return { x: Math.cos(aimAngle), y: Math.sin(aimAngle) };
  if (joyRaw.x || joyRaw.y) { const w = joyToWorld(); return norm(w.x, w.y); }
  return lastDir;
}

let shootStart = 0, shootTimer = null;
const MAX_CHARGE = 900;

function bindAction(btn) {
  const getAct = () => btn.dataset.act;
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(getAct()); }, { passive: false });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); onUp(getAct()); }, { passive: false });
  btn.addEventListener('mousedown', () => onDown(getAct()));
  btn.addEventListener('mouseup', () => onUp(getAct()));
}
function onDown(act) {
  if (act !== 'shoot') return;
  shootStart = performance.now();
  $('power-gauge').classList.add('show');
  const fill = $('power-gauge').querySelector('i');
  shootTimer = setInterval(() => {
    const p = clamp((performance.now() - shootStart) / MAX_CHARGE, 0, 1);
    fill.style.width = (p * 100) + '%';
  }, 30);
}
function onUp(act) {
  const d = actionDir();
  if (act === 'shoot') {
    clearInterval(shootTimer);
    $('power-gauge').classList.remove('show');
    $('power-gauge').querySelector('i').style.width = '0%';
    const power = clamp((performance.now() - shootStart) / MAX_CHARGE, 0.15, 1);
    socket.emit('action', { type: 'shoot', dx: d.x, dy: d.y, power });
  } else {
    socket.emit('action', { type: act, dx: d.x, dy: d.y });
  }
}
document.querySelectorAll('.action-buttons .act-btn').forEach(bindAction);

// Bascule Tacle <-> Plongeon selon si on contrôle le gardien
let gkMode = null;
function setupActionButtons(isGK) {
  if (gkMode === isGK) return;
  gkMode = isGK;
  const btn = document.querySelector('[data-act="tackle"], [data-act="dive"]');
  if (!btn) return;
  if (isGK) { btn.dataset.act = 'dive'; btn.textContent = 'Plongeon'; btn.classList.add('gk-dive'); }
  else { btn.dataset.act = 'tackle'; btn.textContent = 'Tacle'; btn.classList.remove('gk-dive'); }
}

// ---- Sprint ---------------------------------------------------------------
const sprintBtn = $('btn-sprint');
sprintBtn.addEventListener('touchstart', (e) => { e.preventDefault(); sprintHeld = true; sendInput(); }, { passive: false });
sprintBtn.addEventListener('touchend', () => { sprintHeld = false; sendInput(); });
sprintBtn.addEventListener('mousedown', () => { sprintHeld = true; sendInput(); });
sprintBtn.addEventListener('mouseup', () => { sprintHeld = false; sendInput(); });

// ---- Tap sur le terrain : changer de joueur contrôlé (raycast 3D) ---------
let tapStart = null;
$('game-canvas').addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0]; tapStart = { x: t.clientX, y: t.clientY, id: t.identifier };
});
$('game-canvas').addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (tapStart && t.identifier === tapStart.id) {
      if (Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) < 20) handleTap(t.clientX, t.clientY);
      tapStart = null;
    }
  }
});
$('game-canvas').addEventListener('mousedown', (e) => handleTap(e.clientX, e.clientY));

function handleTap(cx, cy) {
  if (!scene || !curState || !myTeam) return;
  const pid = scene.pick(cx, cy);
  if (pid == null) return;
  const target = curState.players.find(p => p.i === pid);
  if (target && target.t === myTeam && target.c !== socket.id) socket.emit('switchPlayer', { pid });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

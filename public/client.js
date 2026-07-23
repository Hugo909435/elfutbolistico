/*
 * client.js — Client de jeu (module ES).
 * Écrans (accueil/lobby/jeu/fin), connexion Socket.io, réception de l'état avec
 * interpolation, rendu 3D délégué à Scene3D (Three.js), contrôles tactiles
 * (joystick + boutons relatifs à la caméra 3e personne, tap = changement de
 * joueur contrôlé via raycast 3D).
 */
import { Scene3D, preloadCharacter } from './scene3d.js';

const { FIELD, PHYS, clamp, lerp, len, norm, angleLerp } = window.SHARED;
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

// --------------------------------------------------------------------------
// Préchargement du personnage 3D (~50 Mo) dès l'ouverture de la page, pour que
// les joueurs soient là AU COUP D'ENVOI : le bouton « Lancer le match » reste
// désactivé tant que ce n'est pas prêt, et si un autre hôte lance le match
// avant la fin de notre téléchargement, un voile de chargement couvre le jeu.
// --------------------------------------------------------------------------
let charReady = false;
preloadCharacter((p) => {
  const pct = Math.round(p * 100) + ' %';
  $('lobby-loading-pct').textContent = pct;
  $('load-overlay-pct').textContent = pct;
}).then(() => {
  charReady = true;
  $('lobby-loading').style.display = 'none';
  $('load-overlay').classList.remove('show');
  updateStartBtn();
});

function updateStartBtn() {
  const b = $('btn-start');
  b.disabled = !charReady;
  b.textContent = charReady ? 'Lancer le match' : 'Chargement des joueurs…';
}
updateStartBtn();

// Mode visée (remise en jeu figée) : le joystick fait tourner la caméra
// autour du tireur pour choisir à qui passer.
let aimMode = false, aimAngle = 0;
// Contrôlais-je déjà le gardien au tick précédent ? (feedback de prise de GB)
let wasGk = false;

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
  updateStartBtn();
  document.querySelector('.choose-team.team-b').disabled = (state.format === '1v1-ai');
});

socket.on('returnLobby', () => show('lobby'));

// ==========================================================================
// MATCH
// ==========================================================================
socket.on('matchStart', () => {
  snapBuf = []; curState = null; wasGk = false; show('game');
  if (!charReady) $('load-overlay').classList.add('show');
});

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
  // Prise de gardien (bascule auto sur frappe adverse, ou choisie au tap) :
  // gros feedback pour que le joueur comprenne qu'il doit faire l'arrêt.
  const isGkNow = !!(mine && mine.gk);
  if (isGkNow && !wasGk) flashFeedback('🧤 Tu contrôles le gardien — arrête le tir !');
  wasGk = isGkNow;
  // Entrée/sortie du mode visée (remise en jeu figée)
  const nowAim = !!(mine && mine.fz);
  if (nowAim && !aimMode) aimAngle = mine.f;   // départ : direction actuelle du tireur
  aimMode = nowAim;
  // Sync autoritaire de la visée slow-mo : si le serveur y met fin (timeout de
  // maintien, faute, but…), on referme le réticule même si le bouton est tenu.
  if (shotAimMode) {
    if (mine && mine.sa) shotConfirmed = true;
    else if (shotConfirmed) {
      // Le serveur a mis fin à la visée (tir auto, faute…) : on referme et on
      // ignore le relâchement du bouton encore tenu.
      swallowShootUp = true;
      exitShotAim(); resetPowerGauge();
    }
  }
  // On n'affiche que le joueur contrôlé (info, pas de tutoriel).
  $('hud-ctrl').textContent = mine ? `${mine.id}${mine.gk ? ' (GB)' : ''}` : '';

  const msgEl = $('hud-message');
  if (snap.message) { msgEl.textContent = snap.message; msgEl.classList.add('show'); }
  else msgEl.classList.remove('show');

  setupActionButtons(mine && mine.gk);
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
  if (!gameActive || !scene) return;
  // Frappe chronométrée : la flèche au sol balaie autour de l'axe du but, la
  // caméra se cale derrière le tireur face au but (angle stable).
  let aim = aimMode ? aimAngle : null, shotArrow = null;
  if (shotAimMode && curState) {
    const base = shotBaseAngle();
    // Pendant la charge : flèche fixe plein axe ; pendant la visée : balayage
    shotArrow = shotPhase === 'aim' ? base + shotSweep(shotAge()) : base;
    aim = base;
  }
  scene.update(interpState(), {
    myTeam, mySocket: socket.id,
    aim, shotArrow,
    corner: !!(curState && curState.rst === 'corner'),
  });
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
  if (shotAimMode) {
    // Frappe chronométrée : le tireur reste posté, le joystick est ignoré.
    socket.emit('input', { mx: 0, my: 0, sprint: false });
    return;
  }
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

// ---- Boutons d'action : la direction visée = la VUE (caméra), pas le
// déplacement. On peut donc courir tout droit (joystick) et passer/tirer sur le
// côté en tournant la vue (glissé). En remise en jeu figée, c'est l'angle visé.
function actionDir() {
  if (aimMode) return { x: Math.cos(aimAngle), y: Math.sin(aimAngle) };
  if (scene) { const b = scene.cameraBasis(); return norm(b.fwd.x, b.fwd.z); }
  return lastDir;
}

let shootStart = 0, shootTimer = null;
const MAX_CHARGE = 900;

// ---- Tacle : clic bref = tacle DEBOUT · maintien = tacle GLISSÉ ------------
// Un simple appui pique le ballon sur place (sûr, récupération rapide). Garder
// le bouton enfoncé au-delà du seuil déclenche la glissade (plus de portée,
// plus risqué). Le glissé part dès le seuil atteint, sans attendre le relâché.
const TACKLE_HOLD_MS = 200;
let tackleHoldTimer = null, tackleFired = false, tackleDownAt = 0;

// ---- Frappe chronométrée en DEUX TEMPS (un seul bouton) -------------------
// 1. MAINTENIR Tir : la jauge de puissance se charge. RELÂCHER = puissance
//    verrouillée — on choisit d'abord la force, sans stress.
// 2. La FLÈCHE au sol devant le tireur balaie alors autour de l'axe du but,
//    compte à rebours de 3 s. RÉAPPUYER = frappe dans la direction de la
//    flèche ; à zéro, elle part toute seule là où pointe la flèche.
// Trop fort près du but = au-dessus ; pas assez chargé = n'atteint pas la cage.
// Le serveur calcule le même balayage (fonctions partagées dans shared.js).
const { SHOT, shotSweep, shotCharge } = window.SHARED;
let shotAimMode = false, shotPhase = null;     // 'charge' | 'aim'
let shotConfirmed = false, shotT0 = 0, shotPower = 0, shotUiTimer = null;
let swallowShootUp = false;    // relâchement à ignorer (le tir est déjà parti)
const shotTargetEl = $('shot-target'), stCountEl = $('st-count');

function haveBall() {
  const mine = curState && curState.players.find(p => p.c === socket.id);
  return !!(mine && curState.ball.owner === mine.i);
}
// On ne peut TIRER (visée slow-mo) qu'une fois la ligne médiane franchie, dans
// le camp adverse. Dans son propre camp, le bouton Tir se contente d'un
// dégagement long (cf. onDown/onUp). L'équipe A attaque vers +X, la B vers -X.
function pastMidfield() {
  if (!curState) return false;
  const bx = curState.ball.x;
  return myTeam === 'A' ? bx > FIELD.W / 2 : bx < FIELD.W / 2;
}
function shotAge() { return (performance.now() - shotT0) / 1000; }
// Axe du but adverse depuis le ballon (angle monde) : la flèche balaie autour.
function shotBaseAngle() {
  if (!curState) return 0;
  const gx = myTeam === 'A' ? FIELD.W : 0;
  return Math.atan2(FIELD.H / 2 - curState.ball.y, gx - curState.ball.x);
}
function enterShotAim() {
  shotAimMode = true; shotPhase = 'charge';
  shotConfirmed = false; swallowShootUp = false; shotPower = 0;
  shotT0 = performance.now();
  shotTargetEl.classList.add('show');
  clearInterval(shootTimer);            // la jauge est pilotée par la charge du tir
  const fill = $('power-gauge').querySelector('i');
  shotUiTimer = setInterval(() => {
    const age = shotAge();
    if (shotPhase === 'charge') {
      shotPower = shotCharge(age);
      fill.style.width = (shotPower * 100) + '%';
      stCountEl.textContent = Math.round(shotPower * 100) + '%';
      if (age >= SHOT.CHARGE_HOLD_MAX) lockPower();   // maintien interminable
    } else {
      stCountEl.textContent = Math.max(0, SHOT.TIME_MAX - age).toFixed(1);
      if (age >= SHOT.TIME_MAX) {
        // Temps écoulé : le serveur tire tout seul là où pointe la flèche. Si
        // la visée n'a jamais été confirmée (remise figée), c'est nous qui tirons.
        if (!shotConfirmed) socket.emit('action', { type: 'shoot', timed: 1, off: shotSweep(age), power: shotPower });
        swallowShootUp = true;
        exitShotAim(); resetPowerGauge();
      }
    }
  }, 25);
  socket.emit('action', { type: 'shootStart' });
}
// Relâchement pendant la charge : la puissance est verrouillée, le balayage
// de la flèche commence.
function lockPower() {
  if (!shotAimMode || shotPhase !== 'charge') return;
  shotPower = shotCharge(shotAge());
  shotPhase = 'aim';
  shotT0 = performance.now();
  socket.emit('action', { type: 'shootLock', power: shotPower });
}
// Deuxième appui : frappe dans la direction actuelle de la flèche.
function fireTimedShot() {
  if (!shotAimMode || shotPhase !== 'aim') return;
  socket.emit('action', { type: 'shoot', timed: 1, off: shotSweep(shotAge()), power: shotPower });
  swallowShootUp = true;       // le relâchement du 2e appui ne doit rien faire
  exitShotAim(); resetPowerGauge();
}
function exitShotAim() {
  shotAimMode = false; shotPhase = null; shotConfirmed = false;
  clearInterval(shotUiTimer);
  shotTargetEl.classList.remove('show');
}
function resetPowerGauge() {
  clearInterval(shootTimer);
  $('power-gauge').classList.remove('show');
  $('power-gauge').querySelector('i').style.width = '0%';
}

function bindAction(btn) {
  const getAct = () => btn.dataset.act;
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(getAct()); }, { passive: false });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); onUp(getAct()); }, { passive: false });
  btn.addEventListener('mousedown', () => onDown(getAct()));
  btn.addEventListener('mouseup', () => onUp(getAct()));
}
// Jauge de puissance simple (maintien) partagée par le ballon long (Longue) et
// le dégagement (Tir dans son propre camp). Contrairement à la visée slow-mo,
// pas de flèche ni de ralenti : on dose juste la distance, puis on relâche.
let longCharge = false;              // true = on charge un ballon long / dégagement
function startPowerCharge() {
  shootStart = performance.now();
  $('power-gauge').classList.add('show');
  const fill = $('power-gauge').querySelector('i');
  clearInterval(shootTimer);
  shootTimer = setInterval(() => {
    const p = clamp((performance.now() - shootStart) / MAX_CHARGE, 0, 1);
    fill.style.width = (p * 100) + '%';
  }, 30);
}
function chargedPower() {
  return clamp((performance.now() - shootStart) / MAX_CHARGE, 0.15, 1);
}

function onDown(act) {
  if (act === 'tackle') {
    // Appui : on arme le maintien. S'il dépasse le seuil, la glissade part.
    tackleFired = false;
    tackleDownAt = performance.now();
    clearTimeout(tackleHoldTimer);
    tackleHoldTimer = setTimeout(() => {
      tackleFired = true;
      socket.emit('action', { type: 'tackle' });      // maintien = tacle glissé
    }, TACKLE_HOLD_MS);
    return;
  }
  if (act === 'long') {
    // Ballon long dosé : dégager loin / centrer vers une zone (pas de cible).
    if (!haveBall()) return;
    longCharge = true; startPowerCharge();
    return;
  }
  if (act !== 'shoot') return;
  // Deuxième appui pendant le balayage = FRAPPE
  if (shotAimMode && shotPhase === 'aim') { fireTimedShot(); return; }
  // Balle au pied dans son propre camp : pas de tir avant le milieu de terrain,
  // le bouton Tir se comporte en dégagement long dosé (ni ralenti ni flèche).
  if (haveBall() && !pastMidfield()) { longCharge = true; startPowerCharge(); return; }
  startPowerCharge();
  if (haveBall()) enterShotAim();      // balle au pied dans le camp adverse -> visée
}
function onUp(act) {
  if (act === 'tackle') {
    clearTimeout(tackleHoldTimer);
    if (tackleFired) { tackleFired = false; return; }  // le glissé est déjà parti (timer)
    // Secours : si le maintien a dépassé le seuil mais que le timer n'a pas
    // tiré (onglet ralenti, etc.), on déclenche quand même le glissé au relâché.
    if (performance.now() - tackleDownAt >= TACKLE_HOLD_MS) {
      socket.emit('action', { type: 'tackle' });       // maintien = tacle glissé
    } else {
      socket.emit('action', { type: 'standtackle' });  // clic bref = tacle debout
    }
    return;
  }
  const d = actionDir();
  // Relâchement d'un ballon long / dégagement (bouton Longue, ou Tir en défense)
  if (longCharge && (act === 'long' || act === 'shoot')) {
    const power = chargedPower();
    longCharge = false;
    resetPowerGauge();
    socket.emit('action', { type: 'long', dx: d.x, dy: d.y, power });
    return;
  }
  if (act === 'shoot') {
    if (swallowShootUp) { swallowShootUp = false; resetPowerGauge(); return; }
    if (shotAimMode) {
      // Relâcher pendant la charge = verrouille la puissance, le balayage
      // commence. (La jauge reste affichée au niveau choisi.)
      if (shotPhase === 'charge') lockPower();
      return;
    }
    const power = chargedPower();
    resetPowerGauge();
    socket.emit('action', { type: 'shoot', dx: d.x, dy: d.y, power });   // volée
  } else if (act === 'dive') {
    // Plongeon : direction du joystick s'il est tenu (plonger à droite ou à
    // gauche le long de la cage), sinon la direction de la vue.
    const w = joyToWorld();
    const dd = len(w.x, w.y) > 0.2 ? norm(w.x, w.y) : d;
    socket.emit('action', { type: 'dive', dx: dd.x, dy: dd.y });
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

// ---- Terrain : glisser = tourner la caméra · tap = changer de joueur -------
// Le glissé horizontal fait orbiter la caméra 3e personne autour du joueur
// contrôlé (scene.camYaw). Comme les passes/tirs sont calculés relativement à
// la caméra, on peut ainsi viser une passe dans n'importe quelle direction.
// Un simple tap (sans déplacement) garde son rôle : sélectionner un joueur.
const CAM_SENS = 0.012;              // rad par pixel glissé
let canvasDrag = null;               // { id, x0, y0, lastX, moved }
function canvasDown(cx, cy, id) {
  canvasDrag = { id, x0: cx, y0: cy, lastX: cx, moved: false };
  if (scene) scene.camYawActive = true;
}
function canvasMoveTo(cx, cy) {
  if (!canvasDrag) return;
  if (!canvasDrag.moved && Math.hypot(cx - canvasDrag.x0, cy - canvasDrag.y0) > 8) canvasDrag.moved = true;
  if (scene && canvasDrag.moved && !aimMode) scene.camYaw += (cx - canvasDrag.lastX) * CAM_SENS;
  canvasDrag.lastX = cx;
}
function canvasUp(cx, cy) {
  if (!canvasDrag) return;
  if (scene) scene.camYawActive = false;
  if (!canvasDrag.moved) handleTap(cx, cy);   // tap franc = changer de joueur
  canvasDrag = null;
}
const gameCanvas = $('game-canvas');
gameCanvas.addEventListener('touchstart', (e) => {
  if (canvasDrag) return;
  const t = e.changedTouches[0]; canvasDown(t.clientX, t.clientY, t.identifier);
});
gameCanvas.addEventListener('touchmove', (e) => {
  if (!canvasDrag) return;
  for (const t of e.changedTouches) if (t.identifier === canvasDrag.id) { e.preventDefault(); canvasMoveTo(t.clientX, t.clientY); break; }
}, { passive: false });
gameCanvas.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) if (canvasDrag && t.identifier === canvasDrag.id) { canvasUp(t.clientX, t.clientY); break; }
});
gameCanvas.addEventListener('mousedown', (e) => canvasDown(e.clientX, e.clientY, 'mouse'));
window.addEventListener('mousemove', (e) => { if (canvasDrag && canvasDrag.id === 'mouse') canvasMoveTo(e.clientX, e.clientY); });
window.addEventListener('mouseup', (e) => { if (canvasDrag && canvasDrag.id === 'mouse') canvasUp(e.clientX, e.clientY); });

function handleTap(cx, cy) {
  if (!scene || !curState || !myTeam) return;
  const pid = scene.pick(cx, cy, myTeam);
  if (pid == null) return;
  const target = curState.players.find(p => p.i === pid);
  if (target && target.t === myTeam && target.c !== socket.id) socket.emit('switchPlayer', { pid });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

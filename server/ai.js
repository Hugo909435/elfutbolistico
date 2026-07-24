/*
 * ai.js — Intelligence artificielle des joueurs non contrôlés par un humain.
 *
 * Architecture (refonte complète) :
 *   1. RÔLES affinés (CB/FB/CM/FW) + HOME DYNAMIQUE qui coulisse avec le ballon.
 *   2. DIRECTOR d'équipe : une passe par tick calcule QUI presse (un seul),
 *      qui marque qui, qui soutient — pour éviter que tous fassent la même chose.
 *   3. MACHINE À ÉTATS par bot : chase / recover / support / mark / hold(cover).
 *   4. RÈGLES DE TACLE strictes : distance, angle, proba, surface -> contain.
 *   5. PHASES ARRÊTÉES : slots pré-calculés et RÉPARTIS (espacement garanti),
 *      distance réglementaire respectée par le camp qui défend.
 *
 * Points d'entrée (inchangés, appelés par match.js) :
 *   updateAIPlayer(match, p, dt)  — jeu courant + remise figée
 *   setPieceMove(match, p, dt)    — phase de placement (chrono en pause)
 */
'use strict';

const S = require('../public/shared');
const { FIELD, PHYS } = S;

// ---------------------------------------------------------------------------
// Réglages IA (une seule source de vérité pour équilibrer le comportement)
// ---------------------------------------------------------------------------
const T = {
  MARK_ZONE: 340,       // profondeur (depuis le but) où l'on marque un adversaire
  MARK_TIGHT: 26,       // à quel point on se colle côté but au marquage
  SUPPORT_AHEAD: 160,   // avance du soutien offensif
  CONTAIN_DIST: 34,     // distance de contention (rester entre porteur et but)
  ARRIVE_SLOW: 26,      // rayon de décélération (arrivée douce)
  LEGAL_DIST: 96,       // 9 m réglementaires sur coup de pied arrêté (~9.6 m ici)
  MIN_SPACING: 78,      // espacement mini entre bots sur phase arrêtée
  FK_CLOSE: 340,        // coup franc "à portée" (mur + surface peuplée)
};

// ---------------------------------------------------------------------------
// Helpers de base
// ---------------------------------------------------------------------------
function ballOwner(match) {
  return match.ball.owner != null ? match.players.find(p => p.pid === match.ball.owner) : null;
}
function ownGoalPos(team) { return { x: team === 'A' ? 0 : FIELD.W, y: FIELD.H / 2 }; }

// Déplacement avec ARRIVÉE douce : on ralentit dans le rayon `slow` au lieu de
// piler net — mouvement naturel, et le joueur ne "vibre" pas sur sa cible.
function arriveToward(p, tx, ty, speed, slow = T.ARRIVE_SLOW) {
  const dx = tx - p.x, dy = ty - p.y, d = S.len(dx, dy);
  if (d < 2) { p.vx *= 0.6; p.vy *= 0.6; return; }
  const s = d < slow ? speed * (d / slow) : speed;
  p.vx = (dx / d) * s;
  p.vy = (dy / d) * s;
  if (d > 6) p.facing = Math.atan2(dy, dx);
}

// Rôle affiné à partir du poste + de la position verticale de référence.
//  CB = défenseur central, FB = latéral, CM = milieu, FW = attaquant.
function refinedRole(p) {
  if (p.isGK) return 'GK';
  if (p.role === 'DEF') return Math.abs(p.home.y - FIELD.H / 2) < 0.16 * FIELD.H ? 'CB' : 'FB';
  if (p.role === 'MID') return 'CM';
  return 'FW';
}

// ===========================================================================
// 1) HOME DYNAMIQUE — la zone de référence bouge selon le ballon et la phase.
// ===========================================================================
const K_LAT   = { CB: 0.30, FB: 0.45, CM: 0.40, FW: 0.35 };  // compaction latérale
const PUSH_ATT = { CB: 70, FB: 120, CM: 150, FW: 190 };      // montée en attaque
const PUSH_DEF = { CB: 40, FB: 60,  CM: 90,  FW: 150 };      // repli en défense
const BAND_X   = { CB: 150, FB: 200, CM: 240, FW: 260 };     // amplitude autour du poste

function dynamicHome(match, p, phase) {
  const b = match.ball;
  const dir = match.attackDir(p.team);
  const rr = refinedRole(p);
  const base = p.home;

  // Glissement latéral vers le couloir du ballon (le bloc reste compact).
  let ty = S.lerp(base.y, b.y, K_LAT[rr]);

  // Ligne d'équipe : on monte balle au pied, on descend quand l'adversaire l'a.
  let push = phase === 'attack' ? PUSH_ATT[rr] : phase === 'defend' ? -PUSH_DEF[rr] : 0;
  let tx = base.x + dir * push;

  // Le bloc coulisse aussi en profondeur avec le ballon (sans trahir le poste).
  tx = S.lerp(tx, b.x - dir * 20, 0.12);
  tx = S.clamp(tx, base.x - BAND_X[rr], base.x + BAND_X[rr]);

  return { x: S.clamp(tx, 40, FIELD.W - 40), y: S.clamp(ty, 40, FIELD.H - 40) };
}

// ===========================================================================
// 2) DIRECTOR — coordination d'équipe, recalculée une fois par tick.
//    Sortie par équipe : { phase, presserPid, recoverPid, marks, supportPids }
// ===========================================================================
function buildTeamPlan(match, team) {
  const b = match.ball;
  const owner = ballOwner(match);
  const phase = owner ? (owner.team === team ? 'attack' : 'defend') : 'neutral';

  const mates = match.players.filter(p => p.team === team && !p.isGK && !p.sentOff);
  const opps  = match.players.filter(p => p.team !== team && !p.isGK && !p.sentOff);
  const plan = { phase, presserPid: null, recoverPid: null, marks: new Map(), supportPids: new Set() };

  if (phase === 'attack') {
    // Deux coéquipiers les plus proches DEVANT le porteur créent des lignes de passe.
    const dir = match.attackDir(team);
    const ahead = mates
      .filter(p => p !== owner && dir * (p.x - owner.x) > -30)
      .sort((a, c) => S.dist2(a.x, a.y, owner.x, owner.y) - S.dist2(c.x, c.y, owner.x, owner.y));
    ahead.slice(0, 2).forEach(p => plan.supportPids.add(p.pid));
    return plan;
  }

  // Défense / ballon libre : UN SEUL joueur va au ballon (le plus proche).
  let closest = null, cd = Infinity;
  for (const p of mates) {
    const d = S.dist2(p.x, p.y, b.x, b.y);
    if (d < cd) { cd = d; closest = p; }
  }
  if (closest) {
    if (phase === 'defend') plan.presserPid = closest.pid;
    else plan.recoverPid = closest.pid;   // ballon libre : un seul récupérateur
  }

  // Marquage individuel : chaque adversaire dangereux dans notre camp est pris
  // par le défenseur/milieu LIBRE le plus proche — jamais deux sur le même.
  if (phase === 'defend') {
    const goal = ownGoalPos(team);
    const danger = opps
      .filter(o => o !== owner && S.dist(o.x, o.y, goal.x, goal.y) < T.MARK_ZONE + 220)
      .sort((a, c) => S.dist2(a.x, a.y, goal.x, goal.y) - S.dist2(c.x, c.y, goal.x, goal.y));
    const markers = mates.filter(p => p.pid !== plan.presserPid);
    const used = new Set();
    for (const o of danger) {
      let m = null, md = Infinity;
      for (const p of markers) {
        if (used.has(p.pid)) continue;
        const d = S.dist2(p.x, p.y, o.x, o.y);
        if (d < md) { md = d; m = p; }
      }
      if (m) { plan.marks.set(m.pid, o.pid); used.add(m.pid); }
    }
  }
  return plan;
}

// Mémoïsation : le plan est recalculé une fois par tick. On détecte le début
// d'un nouveau tick quand un pid déjà servi se represente (l'ordre de
// traitement des joueurs est stable et chacun est traité une fois par tick).
function getPlan(match, p) {
  let brain = match._aiBrain;
  if (!brain || brain.served.has(p.pid)) {
    brain = match._aiBrain = {
      served: new Set(),
      plans: { A: buildTeamPlan(match, 'A'), B: buildTeamPlan(match, 'B') },
    };
  }
  brain.served.add(p.pid);
  return brain.plans[p.team];
}

// ===========================================================================
// 3) MACHINE À ÉTATS — sélection d'état puis exécution.
// ===========================================================================
function decideState(match, p, plan) {
  const owner = ballOwner(match);
  if (plan.presserPid === p.pid && owner && owner.team !== p.team) return 'chase';
  if (plan.recoverPid === p.pid && !owner) return 'recover';
  if (plan.marks.has(p.pid)) return 'mark';
  if (plan.supportPids.has(p.pid)) return 'support';
  return 'hold';                        // couverture / tenue de ligne
}

// -- POURSUITE / PRESSING (un seul joueur y est autorisé via le director) ----
function stateChase(match, p, speed) {
  const carrier = ballOwner(match);
  if (!carrier) return stateRecover(match, p, speed);         // ballon relâché entre-temps

  const dec = tackleDecision(match, p, carrier);
  if (dec.action === 'slide') { match.tryTackle(p); return; }
  if (dec.action === 'stand') { match.tryStandTackle(p); return; }
  if (dec.action === 'contain') {
    // Se placer côté but, à distance, pour empêcher la progression sans se jeter.
    const g = ownGoalPos(p.team);
    const gs = S.norm(g.x - carrier.x, g.y - carrier.y);
    arriveToward(p, carrier.x + gs.x * T.CONTAIN_DIST, carrier.y + gs.y * T.CONTAIN_DIST, speed);
    return;
  }
  // 'approach' : foncer sur le point d'interception (anticipe le déplacement).
  arriveToward(p, carrier.x + carrier.vx * 0.12, carrier.y + carrier.vy * 0.12, speed * 1.05, 8);
}

// -- RÉCUPÉRATION D'UN BALLON LIBRE ------------------------------------------
function stateRecover(match, p, speed) {
  const b = match.ball;
  arriveToward(p, b.x + b.vx * 0.18, b.y + b.vy * 0.18, speed * 1.05, 8);
}

// -- SOUTIEN OFFENSIF : proposer une VRAIE ligne de passe --------------------
function stateSupport(match, p, speed) {
  const owner = ballOwner(match);
  const dir = match.attackDir(p.team);
  const base = dynamicHome(match, p, 'attack');
  const side = p.home.y < FIELD.H / 2 ? -1 : 1;      // écartement selon le côté du poste
  let tx = base.x + dir * T.SUPPORT_AHEAD * 0.4;
  let ty = base.y + side * 40;
  // Trop près du porteur = fausse solution : on décale devant pour ouvrir l'angle.
  if (owner && S.dist(tx, ty, owner.x, owner.y) < 90) tx += dir * 70;
  arriveToward(p, S.clamp(tx, 40, FIELD.W - 40), S.clamp(ty, 40, FIELD.H - 40), speed);
}

// -- MARQUAGE INDIVIDUEL : se placer côté but de l'adversaire assigné ---------
function stateMark(match, p, plan, speed) {
  const opp = match.players.find(q => q.pid === plan.marks.get(p.pid));
  if (!opp || opp.sentOff) return stateHold(match, p, 'defend', speed);
  const g = ownGoalPos(p.team);
  const gs = S.norm(g.x - opp.x, g.y - opp.y);        // vecteur adversaire -> notre but
  arriveToward(p, opp.x + gs.x * T.MARK_TIGHT, opp.y + gs.y * T.MARK_TIGHT, speed * 1.02, 10);
}

// -- TENUE DE LIGNE / COUVERTURE : home dynamique + micro-mouvement vivant ----
function stateHold(match, p, phase, speed) {
  const h = dynamicHome(match, p, phase);
  const t = Date.now() * 0.001;
  const err = match.diff.error * 22;                 // léger flottement (jamais figé)
  arriveToward(p,
    h.x + Math.sin(t * 0.7 + p.aiState.jitter) * err,
    h.y + Math.cos(t * 0.6 + p.aiState.jitter) * err,
    speed * 0.9);
}

// ===========================================================================
// 4) RÈGLES DE TACLE — distance, angle, proba de réussite, risque de carton.
//    Renvoie { action: 'approach' | 'contain' | 'stand' | 'slide' }.
// ===========================================================================
function tackleDecision(match, p, carrier) {
  if (p.tackleCd > 0 || p.stunned > 0 || p.slideT > 0) return { action: 'approach' };
  // Remise en jeu / protection : on ne tacle jamais, on contient.
  if (match.pendingRestart || match.restartFrozen || match.restartProtect > 0) return { action: 'contain' };

  const d = S.dist(p.x, p.y, carrier.x, carrier.y);
  if (d > PHYS.TACKLE_RANGE * 1.4) return { action: 'approach' };

  // Angle d'approche : suis-je devant le porteur (bien) ou dans son dos (faute) ?
  const face = { x: Math.cos(carrier.facing), y: Math.sin(carrier.facing) };
  const toMe = S.norm(p.x - carrier.x, p.y - carrier.y);
  const frontness = -(face.x * toMe.x + face.y * toMe.y);   // +1 pile devant, -1 dans le dos
  if (frontness < -0.15) return { action: 'contain' };      // par derrière -> jamais de tacle

  // Dans MA surface : un tacle glissé raté = penalty. On temporise/pique seulement.
  const gx = match.ownGoalX(p.team);
  const inMyBox = (gx === 0 ? carrier.x < FIELD.PENALTY_W : carrier.x > FIELD.W - FIELD.PENALTY_W)
    && Math.abs(carrier.y - FIELD.H / 2) < FIELD.PENALTY_H / 2;

  // Proba de réussite estimée : alignement + proximité - vitesse relative.
  const align = S.clamp((frontness + 0.15) / 1.15, 0, 1);
  const prox  = S.clamp(1 - d / (PHYS.TACKLE_RANGE * 1.4), 0, 1);
  const rel   = S.len(carrier.vx - p.vx, carrier.vy - p.vy);
  const success = S.clamp(align * 0.6 + prox * 0.5 - S.clamp(rel / 300, 0, 0.5), 0, 1) * match.diff.speed;

  // Très proche, frontal, sûr, hors surface : tacle DEBOUT (récup immédiate, peu de risque).
  if (d < PHYS.STAND_TACKLE_REACH * 0.9 && align > 0.5 && !inMyBox && success > 0.45)
    return { action: 'stand' };
  // Tacle GLISSÉ seulement si bonne proba, hors surface, à portée de contact.
  if (!inMyBox && success > 0.62 && d < PHYS.TACKLE_RANGE)
    return { action: 'slide' };
  // Sinon on contient (on garde le porteur devant soi, on attend le renfort).
  return { action: 'contain' };
}

// ===========================================================================
// 5) PHASES ARRÊTÉES — slots RÉPARTIS avec espacement garanti.
// ===========================================================================
function isWallPlayer(p) { return p.role === 'DEF'; }

// Génère `count` points en éventail (rings x lanes) : espacement garanti par
// construction (alongStep entre anneaux, across entre couloirs).
function fan(ox, oy, dir, count, along0, alongStep, across) {
  const lanes = [0, 1, -1, 2, -2, 3, -3];
  const out = [];
  for (let ring = 0; out.length < count; ring++) {
    for (const lane of lanes) {
      out.push({
        x: S.clamp(ox + dir * (along0 + ring * alongStep), 30, FIELD.W - 30),
        y: S.clamp(oy + lane * across, 45, FIELD.H - 45),
      });
      if (out.length >= count) break;
    }
  }
  return out;
}

// Pousse un slot hors du rayon réglementaire autour du ballon (camp qui défend).
function legalize(slot, spX, spY) {
  if (S.dist(slot.x, slot.y, spX, spY) < T.LEGAL_DIST) {
    const n = S.norm(slot.x - spX, slot.y - spY);
    return { x: spX + n.x * T.LEGAL_DIST, y: spY + n.y * T.LEGAL_DIST };
  }
  return slot;
}

// Affectation gloutonne : pour chaque slot, le joueur libre le plus proche.
// Minimise la distance parcourue ET garantit qu'aucun slot n'est partagé.
function assignInto(map, players, slots) {
  const used = new Set();
  for (const slot of slots) {
    if (used.size >= players.length) break;
    let best = null, bd = Infinity;
    for (const pl of players) {
      if (used.has(pl.pid)) continue;
      const d = S.dist2(pl.x, pl.y, slot.x, slot.y);
      if (d < bd) { bd = d; best = pl; }
    }
    if (best) { map.set(best.pid, { x: slot.x, y: slot.y }); used.add(best.pid); }
  }
  for (const pl of players) if (!map.has(pl.pid)) map.set(pl.pid, { x: pl.home.x, y: pl.home.y });
}

// Défense sur coup franc : mur (les DEF) à 9 m + reste en ligne entre balle/but.
function assignFreekickDef(map, match, spTeam, spX, spY, def) {
  const defTeam = spTeam === 'A' ? 'B' : 'A';
  const g = ownGoalPos(defTeam);
  const n = S.norm(g.x - spX, g.y - spY);
  const perp = { x: -n.y, y: n.x };
  const distGoal = S.dist(spX, spY, match.oppGoalX(spTeam), FIELD.H / 2);

  let line = def;
  if (distGoal < T.FK_CLOSE) {
    const wall = def.filter(isWallPlayer);
    wall.forEach((p, i) => {
      const s = i - (wall.length - 1) / 2;
      map.set(p.pid, {
        x: spX + n.x * T.LEGAL_DIST + perp.x * s * 17,
        y: spY + n.y * T.LEGAL_DIST + perp.y * s * 17,
      });
    });
    line = def.filter(p => !isWallPlayer(p));
  }
  const defDir = g.x < spX ? -1 : 1;
  const slots = fan(S.lerp(spX, g.x, 0.25), S.lerp(spY, FIELD.H / 2, 0.3), defDir, line.length, 60, 85, 80)
    .map(sl => legalize(sl, spX, spY));
  assignInto(map, line, slots);
}

// Contexte de la phase arrêtée en cours (placement OU ballon figé).
function setPieceContext(match) {
  if (match.setPiece && match.setPiece.takerPid != null) {
    const sp = match.setPiece;
    return { type: sp.type, team: sp.team, takerPid: sp.takerPid, x: sp.x, y: sp.y };
  }
  if (match.restartFrozen) {
    const rf = match.restartFrozen;
    const t = match.players.find(q => q.pid === rf.takerPid);
    return { type: rf.type, team: t ? t.team : 'A', takerPid: rf.takerPid, x: rf.x, y: rf.y };
  }
  return null;
}

// Construit la carte pid -> {x,y} de TOUTES les positions de la phase arrêtée.
function buildSetPiecePlan(match, ctx) {
  const { type, team: spTeam, takerPid, x: spX, y: spY } = ctx;
  const dir = match.attackDir(spTeam);
  const gxAtt = match.oppGoalX(spTeam);
  const map = new Map();

  const att = match.players.filter(p => p.team === spTeam && !p.isGK && !p.sentOff && p.pid !== takerPid);
  const def = match.players.filter(p => p.team !== spTeam && !p.isGK && !p.sentOff);
  const distGoal = S.dist(spX, spY, gxAtt, FIELD.H / 2);

  let attSlots, defSlots, freekick = false;

  if (type === 'throwin') {
    // Remetteur : éventail LARGE vers l'avant (fini l'effet boule devant lui).
    attSlots = fan(spX, spY, dir, att.length, 40, 95, 85);
    const g = ownGoalPos(spTeam === 'A' ? 'B' : 'A');
    const dDir = g.x < spX ? -1 : 1;
    defSlots = fan(S.lerp(spX, g.x, 0.25), S.lerp(spY, FIELD.H / 2, 0.3), dDir, def.length, 60, 88, 80);
  } else if (type === 'corner') {
    const into = -dir;                                   // vers l'intérieur du terrain
    attSlots = fan(gxAtt, FIELD.H / 2, into, att.length, 60, 60, 70);
    defSlots = fan(gxAtt, FIELD.H / 2, into, def.length, 35, 48, 55);   // pas de 9 m sur corner
  } else if (type === 'freekick') {
    attSlots = distGoal < T.FK_CLOSE
      ? fan(gxAtt, FIELD.H / 2, -dir, att.length, 90, 55, 70)           // peupler la surface
      : fan(spX, spY, dir, att.length, 80, 90, 90);                     // relance vers l'avant
    freekick = true;
  } else if (type === 'penalty') {
    // Tout le monde hors surface, en arc derrière le point de penalty.
    attSlots = fan(gxAtt - dir * (FIELD.PENALTY_W + 30), FIELD.H / 2, -dir, att.length, 0, 40, 62);
    defSlots = fan(gxAtt - dir * (FIELD.PENALTY_W + 60), FIELD.H / 2, -dir, def.length, 0, 40, 62);
  } else {
    // Engagement / six mètres : postes (demi-terrain respecté ailleurs).
    for (const p of [...att, ...def]) map.set(p.pid, { x: p.home.x, y: p.home.y });
    return map;
  }

  assignInto(map, att, attSlots);
  if (freekick) assignFreekickDef(map, match, spTeam, spX, spY, def);
  else assignInto(map, def, type === 'corner' ? defSlots : defSlots.map(sl => legalize(sl, spX, spY)));
  return map;
}

// Cache : le plan de phase arrêtée est stable tant que la phase ne change pas.
function getSetPiecePlan(match) {
  const ctx = setPieceContext(match);
  if (!ctx) return null;
  const key = `${ctx.type}:${ctx.takerPid}:${Math.round(ctx.x)}:${Math.round(ctx.y)}`;
  if (!match._spPlan || match._spPlan.key !== key) {
    match._spPlan = { key, map: buildSetPiecePlan(match, ctx) };
  }
  return match._spPlan.map;
}

// Positionnement d'un bot vers son slot de phase arrêtée (partagé placement/figé).
function setPieceStand(match, p, speed) {
  const map = getSetPiecePlan(match);
  const slot = map && map.get(p.pid);
  if (slot) arriveToward(p, slot.x, slot.y, speed);
  else arriveToward(p, p.home.x, p.home.y, speed);
}

// ===========================================================================
// POINTS D'ENTRÉE
// ===========================================================================
function updateAIPlayer(match, p, dt) {
  if (p.sentOff || p.stunned > 0 || p.diving > 0 || p.slideT > 0) return;
  const speed = (p.isGK ? PHYS.GK_SPEED : PHYS.PLAYER_SPEED) * match.diff.speed;

  if (p.isGK) return goalkeeper(match, p, speed);

  // Remise en jeu figée : chacun tient sa position de phase arrêtée (répartie).
  const rf = match.restartFrozen;
  if (rf && p.pid !== rf.takerPid) return setPieceStand(match, p, speed);

  // Porteur du ballon : décision offensive.
  if (ballOwner(match) === p) {
    p.aiState.kick = (p.aiState.kick || 0) - dt;
    const canDecide = p.aiState.kick <= 0;
    if (canDecide) p.aiState.kick = match.diff.reaction + Math.random() * 0.15;
    return ownerDecision(match, p, canDecide);
  }

  // Sélection d'état cadencée (hystérésis selon la difficulté). Le tacle, lui,
  // est réévalué CHAQUE tick dans stateChase — donc la réaction reste vive.
  const plan = getPlan(match, p);
  p.aiState.react -= dt;
  if (p.aiState.react <= 0) {
    p.aiState.react = match.diff.reaction * 0.5 + Math.random() * 0.1;
    p.aiState.state = decideState(match, p, plan);
  }
  switch (p.aiState.state || 'hold') {
    case 'chase':   return stateChase(match, p, speed);
    case 'recover': return stateRecover(match, p, speed);
    case 'support': return stateSupport(match, p, speed);
    case 'mark':    return stateMark(match, p, plan, speed);
    default:        return stateHold(match, p, plan.phase, speed);
  }
}

// Phase de placement (chrono en pause) — appelée par match.js.
function setPieceMove(match, p, dt) {
  if (p.sentOff || p.stunned > 0 || p.diving > 0 || p.slideT > 0) return;
  const sp = match.setPiece;
  if (!sp) return;
  const speed = (p.isGK ? PHYS.GK_SPEED : PHYS.PLAYER_SPEED) * match.diff.speed;

  if (p.pid === sp.takerPid) {                 // le tireur reste posté sur le ballon
    p.vx *= 0.5; p.vy *= 0.5;
    p.facing = Math.atan2(FIELD.H / 2 - p.y, match.oppGoalX(p.team) - p.x);
    return;
  }
  if (p.isGK) {                                // gardien sur sa ligne
    const gx = match.ownGoalX(p.team) + match.attackDir(p.team) * 26;
    return arriveToward(p, gx, FIELD.H / 2, speed);
  }
  setPieceStand(match, p, speed);
}

// ---------------------------------------------------------------------------
// Décision du porteur (dribble / passe / tir) — logique offensive conservée.
// ---------------------------------------------------------------------------
function ownerDecision(match, p, canDecide) {
  if ((match.pendingRestart && match.pendingRestart.takerPid === p.pid) ||
      (match.restartFrozen && match.restartFrozen.takerPid === p.pid)) {
    p.vx *= 0.5; p.vy *= 0.5;
    return;
  }
  const dir = match.attackDir(p.team);
  const goalX = match.oppGoalX(p.team);
  const goalY = FIELD.H / 2;
  const distGoal = S.dist(p.x, p.y, goalX, goalY);

  // Dribble vers le but par défaut.
  const toGoal = S.norm(goalX - p.x, goalY - p.y);
  p.vx = toGoal.x * PHYS.PLAYER_SPEED * match.diff.speed * 0.92;
  p.vy = toGoal.y * PHYS.PLAYER_SPEED * match.diff.speed * 0.92;
  p.facing = Math.atan2(toGoal.y, toGoal.x);

  if (!canDecide || p.kickCd > 0) return;

  const presser = match.players.find(o => o.team !== p.team && S.dist(o.x, o.y, p.x, p.y) < 46);

  if (distGoal < 300 && Math.abs(p.y - goalY) < FIELD.GOAL_WIDTH * 1.6) {
    match.tryShoot(p, S.norm(goalX - p.x, goalY - p.y), S.clamp(distGoal / 320, 0.45, 1));
    return;
  }
  if (presser) {
    const fwd = { x: dir, y: (Math.random() - 0.5) * 0.8 };
    if (match._aimTeammate(p, fwd, 360)) { match.tryPass(p, fwd, distGoal > 500 ? 'long' : 'short'); return; }
    if ((p.y < 140 || p.y > FIELD.H - 140) && distGoal < 420) { match.tryPass(p, fwd, 'long'); return; }
  }
  if (Math.random() < 0.25) {
    const fwd = { x: dir, y: 0 };
    const mate = match._aimTeammate(p, fwd, 340);
    if (mate && dir * (mate.x - p.x) > 40) match.tryPass(p, S.norm(mate.x - p.x, mate.y - p.y), 'short');
  }
}

// ---------------------------------------------------------------------------
// Gardien (réactif : suit l'angle, sort sur ballon proche, plonge sur tir cadré)
// ---------------------------------------------------------------------------
function goalkeeper(match, p, speed) {
  const b = match.ball;
  const goalX = match.ownGoalX(p.team);
  const dir = match.attackDir(p.team);
  const lineX = goalX + dir * 26;

  if (match.hasBall(p)) {
    if (p.kickCd <= 0) match.tryPass(p, { x: dir, y: (Math.random() - 0.5) * 0.6 }, 'long');
    return;
  }
  const targetY = S.clamp(S.lerp(FIELD.H / 2, b.y, 0.8), FIELD.GOAL_Y1 - 20, FIELD.GOAL_Y2 + 20);
  arriveToward(p, lineX, targetY, speed, 8);

  const dBall = S.dist(p.x, p.y, b.x, b.y);
  if (!b.owner && dBall < 70 && Math.abs(b.x - goalX) < FIELD.PENALTY_W) {
    arriveToward(p, b.x, b.y, speed * 1.1, 8);
  }
  const shotComingToMe = (dir === 1 ? b.vx < -80 : b.vx > 80);
  if (!b.owner && shotComingToMe && Math.abs(b.x - goalX) < 260 && p.diveCd <= 0) {
    const t = Math.abs((lineX - b.x) / (b.vx || 1));
    const predY = b.y + b.vy * t;
    if (predY > FIELD.GOAL_Y1 - 40 && predY < FIELD.GOAL_Y2 + 40) {
      const dy = predY - p.y;
      if (Math.abs(dy) > 24 && Math.random() < match.diff.speed) {
        match.tryDive(p, S.norm(b.x - p.x, dy));
      }
    }
  }
}

module.exports = { updateAIPlayer, setPieceMove };

/*
 * ai.js — Intelligence artificielle des joueurs non contrôlés par un humain.
 * Chaque appel positionne la vitesse (p.vx, p.vy) du joueur et déclenche
 * éventuellement une action (passe/tir/tacle/plongeon) via les méthodes du Match.
 * Comportements : formation dynamique, pressing, soutien, décision du porteur,
 * gardien réactif. Le niveau (facile/moyen/difficile) module vitesse/erreur/réaction.
 */
'use strict';

const S = require('../public/shared');
const { FIELD, PHYS } = S;

function ballOwner(match) {
  return match.ball.owner != null ? match.players.find(p => p.pid === match.ball.owner) : null;
}

function closestTeammateToBall(match, team) {
  let best = null, bd = Infinity;
  for (const p of match.players) {
    if (p.team !== team || p.isGK || p.sentOff) continue;
    const d = S.dist2(p.x, p.y, match.ball.x, match.ball.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function moveToward(p, tx, ty, speed) {
  const dx = tx - p.x, dy = ty - p.y;
  const d = S.len(dx, dy);
  if (d < 3) { p.vx *= 0.5; p.vy *= 0.5; return; }
  p.vx = (dx / d) * speed;
  p.vy = (dy / d) * speed;
  p.facing = Math.atan2(dy, dx);
}

// Placement pendant un coup de pied arrêté (corner, touche, six mètres, coup
// franc) : chaque IA rejoint une position dédiée pendant que le chrono est en
// pause — attaquants dans la surface sur corner, défenseurs qui marquent, etc.
function setPieceMove(match, p, dt) {
  if (p.sentOff || p.stunned > 0 || p.diving > 0 || p.slideT > 0) return;
  const sp = match.setPiece;
  if (!sp) return;
  const speed = (p.isGK ? PHYS.GK_SPEED : PHYS.PLAYER_SPEED) * match.diff.speed;

  // Le tireur reste posté sur le ballon
  if (p.pid === sp.takerPid) {
    p.vx *= 0.5; p.vy *= 0.5;
    p.facing = Math.atan2(FIELD.H / 2 - p.y, match.oppGoalX(p.team) - p.x);
    return;
  }

  // Gardien : sur sa ligne
  if (p.isGK) {
    const gx = match.ownGoalX(p.team) + match.attackDir(p.team) * 26;
    return moveToward(p, gx, FIELD.H / 2, speed);
  }

  let tx, ty;
  if (sp.type === 'corner') {
    // Surface concernée = celle du côté du corner
    const gx = sp.x < FIELD.W / 2 ? 0 : FIELD.W;
    const dir = gx === 0 ? 1 : -1;
    const off = (p.index % 3) - 1;                       // -1, 0, 1 : éventail
    if (p.team === sp.team) {
      // Attaquants : dans la surface, autour du point de penalty
      tx = gx + dir * (95 + Math.abs(off) * 35);
      ty = FIELD.H / 2 + off * 60;
    } else {
      // Défenseurs : entre le but et les attaquants (marquage de zone)
      tx = gx + dir * (55 + Math.abs(off) * 20);
      ty = FIELD.H / 2 + off * 45;
    }
  } else if (sp.type === 'penalty') {
    // Tout le monde hors de la surface, en arc derrière le ballon
    const gx = sp.x < FIELD.W / 2 ? 0 : FIELD.W;
    const dir = gx === 0 ? 1 : -1;
    const off = (p.index % 5) - 2;                       // -2..2 : arc
    tx = gx + dir * (FIELD.PENALTY_W + 30 + Math.abs(off) * 12);
    ty = FIELD.H / 2 + off * 62;
  } else if (sp.type === 'kickoff') {
    // Engagement : chacun rejoint sa moitié de terrain
    tx = p.home.x; ty = p.home.y;
    if (p.team === 'A') tx = Math.min(tx, FIELD.W / 2 - 35);
    else tx = Math.max(tx, FIELD.W / 2 + 35);
  } else if (sp.type === 'throwin' && p.team === sp.team) {
    // Coéquipiers du remetteur : proposer une solution courte
    tx = S.lerp(p.home.x, sp.x, 0.6);
    ty = S.lerp(p.home.y, sp.y, 0.6);
  } else {
    // Défense / autres cas : positions de formation
    tx = p.home.x;
    ty = S.lerp(p.home.y, sp.y, 0.25);
  }

  // Les adversaires respectent la distance réglementaire (9 m)
  if (p.team !== sp.team && S.dist(tx, ty, sp.x, sp.y) < 95) {
    const n = S.norm(tx - sp.x, ty - sp.y);
    tx = sp.x + n.x * 95; ty = sp.y + n.y * 95;
  }
  tx = S.clamp(tx, 25, FIELD.W - 25);
  ty = S.clamp(ty, 25, FIELD.H - 25);
  moveToward(p, tx, ty, speed);
}

function updateAIPlayer(match, p, dt) {
  if (p.sentOff || p.stunned > 0 || p.diving > 0 || p.slideT > 0) return;
  const diff = match.diff;
  const baseSpeed = (p.isGK ? PHYS.GK_SPEED : PHYS.PLAYER_SPEED) * diff.speed;

  if (p.isGK) return goalkeeper(match, p, baseSpeed);

  const owner = ballOwner(match);
  const myTeam = p.team;
  const chaser = closestTeammateToBall(match, myTeam);
  const attackX = match.oppGoalX(myTeam);
  const dir = match.attackDir(myTeam);

  // Décision cadencée (réactivité selon difficulté)
  p.aiState.react -= dt;
  const canDecide = p.aiState.react <= 0;
  if (canDecide) p.aiState.react = diff.reaction + Math.random() * 0.15;

  // ---- Le joueur porteur du ballon décide -----------------------------------
  if (owner === p) return ownerDecision(match, p, canDecide);

  // ---- Ballon libre : le plus proche va le chercher -------------------------
  if (!owner) {
    if (p === chaser) {
      // Anticipe la trajectoire du ballon
      const b = match.ball;
      const lead = 0.18;
      moveToward(p, b.x + b.vx * lead, b.y + b.vy * lead, baseSpeed * 1.05);
      return;
    }
    return holdFormation(match, p, baseSpeed, 'neutral');
  }

  // ---- Mon équipe a le ballon : soutien offensif ----------------------------
  if (owner.team === myTeam) {
    return holdFormation(match, p, baseSpeed, 'attack');
  }

  // ---- L'adversaire a le ballon : pressing / repli --------------------------
  // Remise en jeu en attente (penalty, corner, engagement…) : on ne presse pas
  // le tireur, on tient sa position.
  if (match.pendingRestart) return holdFormation(match, p, baseSpeed, 'defend');
  if (p === chaser || S.dist(p.x, p.y, owner.x, owner.y) < 90) {
    // Suis-je dans le dos du porteur ? (tacle par derrière = faute assurée)
    const face = { x: Math.cos(owner.facing), y: Math.sin(owner.facing) };
    const toMe = S.norm(p.x - owner.x, p.y - owner.y);
    const behind = (face.x * toMe.x + face.y * toMe.y) < -0.2;
    if (behind) {
      // Déborde le porteur : vise un point devant lui pour revenir à hauteur
      moveToward(p, owner.x + face.x * 55, owner.y + face.y * 55, baseSpeed * 1.1);
      return;
    }
    // De face/côté : presse le porteur, tente le tacle à portée
    moveToward(p, owner.x + owner.vx * 0.1, owner.y + owner.vy * 0.1, baseSpeed * 1.05);
    if (S.dist(p.x, p.y, owner.x, owner.y) < PHYS.TACKLE_RANGE * 0.8 && p.tackleCd <= 0) {
      match.tryTackle(p);
    }
    return;
  }
  return holdFormation(match, p, baseSpeed, 'defend');
}

// Position cible en formation dynamique, décalée selon la phase et le ballon.
function holdFormation(match, p, speed, mode) {
  const b = match.ball;
  const dir = match.attackDir(p.team);
  let tx = p.home.x, ty = p.home.y;

  // Glissement latéral vers le couloir du ballon
  ty = S.lerp(p.home.y, b.y, 0.35);

  if (mode === 'attack') {
    // Monte vers le but adverse
    tx = p.home.x + dir * 150;
  } else if (mode === 'defend') {
    // Se replie vers son but, entre le ballon et la cage
    tx = S.lerp(p.home.x, match.ownGoalX(p.team) + dir * 120, 0.4);
    tx = S.clamp(tx, Math.min(p.home.x, tx), Math.max(p.home.x, tx));
  } else {
    // Neutre : suit doucement le ballon en X
    tx = S.lerp(p.home.x, b.x, 0.12);
  }

  // Reste dans une zone raisonnable autour du home
  tx = S.clamp(tx, 40, FIELD.W - 40);
  ty = S.clamp(ty, 40, FIELD.H - 40);

  // Bruit léger pour un rendu naturel (erreur selon difficulté)
  const err = match.diff.error * 30;
  tx += Math.sin(p.aiState.jitter + performance_now() * 0.001) * err;

  moveToward(p, tx, ty, speed * 0.85);
}

function ownerDecision(match, p, canDecide) {
  // Tireur d'une remise en jeu : il attend son heure (gérée par le match)
  if ((match.pendingRestart && match.pendingRestart.takerPid === p.pid) ||
      (match.restartFrozen && match.restartFrozen.takerPid === p.pid)) {
    p.vx *= 0.5; p.vy *= 0.5;
    return;
  }
  const dir = match.attackDir(p.team);
  const goalX = match.oppGoalX(p.team);
  const goalY = FIELD.H / 2;
  const distGoal = S.dist(p.x, p.y, goalX, goalY);

  // Se dirige vers le but en dribble par défaut
  const toGoal = S.norm(goalX - p.x, goalY - p.y);
  p.vx = toGoal.x * PHYS.PLAYER_SPEED * match.diff.speed * 0.92;
  p.vy = toGoal.y * PHYS.PLAYER_SPEED * match.diff.speed * 0.92;
  p.facing = Math.atan2(toGoal.y, toGoal.x);

  if (!canDecide || p.kickCd > 0) return;

  // Pression adverse ?
  const presser = match.players.find(o => o.team !== p.team &&
    S.dist(o.x, o.y, p.x, p.y) < 46);

  // Tir si assez proche du but et dans un angle correct
  if (distGoal < 300 && Math.abs(p.y - goalY) < FIELD.GOAL_WIDTH * 1.6) {
    const power = S.clamp(distGoal / 320, 0.45, 1);
    match.tryShoot(p, S.norm(goalX - p.x, goalY - p.y), power);
    return;
  }

  // Sous pression : cherche une passe vers l'avant
  if (presser) {
    const fwd = { x: dir, y: (Math.random() - 0.5) * 0.8 };
    const mate = match._aimTeammate(p, fwd, 360);
    if (mate) { match.tryPass(p, fwd, distGoal > 500 ? 'long' : 'short'); return; }
    // Sinon centre si sur l'aile
    if ((p.y < 140 || p.y > FIELD.H - 140) && distGoal < 420) { match.tryCross(p, fwd); return; }
  }

  // Passe opportuniste vers un coéquipier mieux placé (parfois)
  if (Math.random() < 0.25) {
    const fwd = { x: dir, y: 0 };
    const mate = match._aimTeammate(p, fwd, 340);
    if (mate && match.attackDir(p.team) * (mate.x - p.x) > 40) {
      match.tryPass(p, S.norm(mate.x - p.x, mate.y - p.y), 'short');
    }
  }
}

function goalkeeper(match, p, speed) {
  const b = match.ball;
  const goalX = match.ownGoalX(p.team);
  const dir = match.attackDir(p.team);
  const lineX = goalX + dir * 26;               // reste sur sa ligne (légèrement avancé)

  // Si le GK a le ballon : dégage vers l'avant
  if (match.hasBall(p)) {
    if (p.kickCd <= 0) match.tryPass(p, { x: dir, y: (Math.random() - 0.5) * 0.6 }, 'long');
    return;
  }

  // Suit l'angle du ballon en Y, borné à la largeur de la cage élargie
  const targetY = S.clamp(
    S.lerp(FIELD.H / 2, b.y, 0.8),
    FIELD.GOAL_Y1 - 20, FIELD.GOAL_Y2 + 20
  );
  moveToward(p, lineX, targetY, speed);

  // Sortie sur ballon proche non possédé
  const dBall = S.dist(p.x, p.y, b.x, b.y);
  if (!b.owner && dBall < 70 && Math.abs(b.x - goalX) < FIELD.PENALTY_W) {
    moveToward(p, b.x, b.y, speed * 1.1);
  }

  // Plongeon si tir cadré dangereux
  const shotComingToMe = (dir === 1 ? b.vx < -80 : b.vx > 80);
  if (!b.owner && shotComingToMe && Math.abs(b.x - goalX) < 260 && p.diveCd <= 0) {
    // Point d'interception prévu sur la ligne
    const t = Math.abs((lineX - b.x) / (b.vx || 1));
    const predY = b.y + b.vy * t;
    if (predY > FIELD.GOAL_Y1 - 40 && predY < FIELD.GOAL_Y2 + 40) {
      const dy = predY - p.y;
      if (Math.abs(dy) > 24 && Math.random() < match.diff.speed) {
        match.tryDive(p, S.norm((b.x - p.x), dy));
      }
    }
  }
}

// Petit helper temps (évite d'importer perf_hooks partout)
function performance_now() { return Date.now(); }

module.exports = { updateAIPlayer, setPieceMove };

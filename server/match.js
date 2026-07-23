/*
 * match.js — Moteur de match autoritaire (serveur).
 * Contient l'état du monde, la boucle de tick, la physique du ballon, les
 * collisions, la possession, toutes les mécaniques (passes/tirs/têtes/volées/
 * tacles) et les règles (but, touche, corner, dégagement). L'IA des postes
 * libres est déléguée à ./ai.js.
 */
'use strict';

const S = require('../public/shared');
const AI = require('./ai');
const { FIELD, PHYS, AIR, FORMATS, DIFFICULTY, MATCH } = S;

// Formation 3-2-2 (équipe attaquant vers +X). fx = fraction de longueur depuis
// son propre but, fy = fraction de hauteur. Miroir appliqué pour l'équipe B.
// Tous les matchs alignent gardien + 7 joueurs de champ par équipe (8v8).
const FORMATION_7 = [
  { fx: 0.16, fy: 0.24, role: 'DEF' },
  { fx: 0.13, fy: 0.50, role: 'DEF' },
  { fx: 0.16, fy: 0.76, role: 'DEF' },
  { fx: 0.36, fy: 0.32, role: 'MID' },
  { fx: 0.36, fy: 0.68, role: 'MID' },
  { fx: 0.54, fy: 0.38, role: 'FWD' },
  { fx: 0.54, fy: 0.62, role: 'FWD' },
];

let PID = 0;

class Match {
  constructor(room, format, difficulty) {
    this.room = room;              // référence au salon (pour émettre)
    this.format = FORMATS[format] ? format : '1v1-ai';
    this.cfg = FORMATS[this.format];
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'medium';
    this.diff = DIFFICULTY[this.difficulty];

    this.dt = 1 / PHYS.TICK_HZ;
    this.players = [];
    this.ball = { x: FIELD.W / 2, y: FIELD.H / 2, z: 0, vx: 0, vy: 0, vz: 0,
      px: FIELD.W / 2, py: FIELD.H / 2, pz: 0,   // position au tick précédent (franchissements)
      curve: 0,                                  // effet Magnus (rotation de la trajectoire, rad/s)
      owner: null, lastTouch: null, lastTouchTeam: null };
    this.score = { a: 0, b: 0 };
    this.half = 1;
    this.time = MATCH.DURATION;        // temps restant dans la mi-temps
    this.phase = 'kickoff';            // kickoff|playing|goal|throwin|corner|goalkick|halftime|fulltime|freekick
    this.message = '';
    this.messageTtl = 0;
    this.events = [];                  // événements transitoires (son/anim côté client)
    this.restartProtect = 0;          // délai de protection sur balle arrêtée
    this.restartTaker = null;         // joueur devant remettre en jeu
    this.setPiece = null;             // { type, team, takerPid, x, y, timer } pendant la phase de placement
    this.pendingRestart = null;       // exécution différée du coup par l'IA après la reprise
    this.restartFrozen = null;        // { type, takerPid, x, y } : ballon figé jusqu'à la passe
    this.shotAim = null;              // { pid, age } : tireur en visée slow-mo (ballon collé au pied)
    this.switchCd = {};               // anti-rebond de la bascule auto (par socketId)
    this.gkTakeover = null;           // { sid, prevPid, gkPid, timer } : humain basculé sur son gardien pendant une frappe
    this.freezeAfter = 0;             // délai avant reprise (but, mi-temps)
    this.pendingKickoffTeam = 'A';

    this._buildTeams();
    this._kickoff('A');               // A engage
  }

  // ---------------------------------------------------------------------------
  // Construction des équipes
  // ---------------------------------------------------------------------------
  _buildTeams() {
    for (const team of ['A', 'B']) {
      // Gardien
      this.players.push(this._mkPlayer(team, 'GK', 0, { fx: 0.045, fy: 0.5, role: 'GK' }, true));
      // 7 joueurs de champ (les postes sans humain sont tenus par l'IA)
      for (let i = 0; i < FORMATION_7.length; i++) {
        this.players.push(this._mkPlayer(team, FORMATION_7[i].role, i + 1, FORMATION_7[i], false));
      }
    }
  }

  _mkPlayer(team, role, index, form, isGK) {
    const attackRight = team === 'A';
    // Position "home" en coordonnées absolues selon le sens d'attaque
    const hx = attackRight ? form.fx * FIELD.W : (1 - form.fx) * FIELD.W;
    const hy = form.fy * FIELD.H;
    return {
      id: `${team}${index}`,
      pid: PID++,
      team, role, index, isGK,
      x: hx, y: hy, vx: 0, vy: 0,
      facing: attackRight ? 0 : Math.PI,
      home: { x: hx, y: hy },
      form,
      controlledBy: null,
      sprint: PHYS.SPRINT_MAX,
      tackleCd: 0, diveCd: 0, kickCd: 0, stunned: 0,
      slideT: 0, slideHit: false,            // glissade en cours / contact déjà résolu
      standT: 0,                             // minuterie d'animation du tacle debout (diffusée)
      kickAnimT: 0, volleyT: 0,              // minuteries d'animation (diffusées)
      yellows: 0, sentOff: false,            // discipline (cartons)
      input: { mx: 0, my: 0, sprint: false },   // dernier input humain
      aiState: { react: 0, jitter: Math.random() * Math.PI * 2 },
      diveDir: 0, diving: 0,
      flash: 0,
    };
  }

  attackDir(team) { return team === 'A' ? 1 : -1; }            // sens d'attaque en X
  ownGoalX(team) { return team === 'A' ? 0 : FIELD.W; }
  oppGoalX(team) { return team === 'A' ? FIELD.W : 0; }

  activePlayers() { return this.players; }
  teamPlayers(team) { return this.players.filter(p => p.team === team); }

  // ---------------------------------------------------------------------------
  // Placement des joueurs (engagement / remise en jeu)
  // ---------------------------------------------------------------------------
  _resetPositions(kickoffTeam) {
    for (const p of this.players) {
      if (p.sentOff) continue;   // l'expulsé ne revient pas
      p.vx = p.vy = 0; p.stunned = 0; p.diving = 0;
      let { x, y } = p.home;
      // Tout le monde dans sa moitié pour l'engagement
      if (!p.isGK) {
        if (p.team === 'A') x = Math.min(x, FIELD.W / 2 - 20);
        else x = Math.max(x, FIELD.W / 2 + 20);
      }
      p.x = x; p.y = y;
    }
    this.ball.x = FIELD.W / 2; this.ball.y = FIELD.H / 2;
    this.ball.z = 0; this.ball.vx = this.ball.vy = this.ball.vz = 0;
    this.ball.owner = null;
    this.pendingKickoffTeam = kickoffTeam;
  }

  // ---------------------------------------------------------------------------
  // API réseau (appelée depuis index.js)
  // ---------------------------------------------------------------------------
  setInput(socketId, input) {
    const p = this.players.find(pl => pl.controlledBy === socketId);
    if (!p) return;
    p.input.mx = S.clamp(input.mx || 0, -1, 1);
    p.input.my = S.clamp(input.my || 0, -1, 1);
    p.input.sprint = !!input.sprint;
  }

  // Prise de contrôle dynamique d'un joueur en tapant dessus.
  requestSwitch(socketId, team, targetPid) {
    const target = this.players.find(p => p.pid === targetPid);
    if (!target || target.team !== team || target.sentOff) return { ok: false, reason: 'invalid' };
    if (target.controlledBy && target.controlledBy !== socketId) {
      // Déjà pris par un autre humain -> refus + feedback
      target.flash = 0.4;
      return { ok: false, reason: 'taken', pid: targetPid };
    }
    // Libère l'ancien joueur de cet humain
    const prev = this.players.find(p => p.controlledBy === socketId);
    if (prev && prev !== target) { prev.controlledBy = null; prev.input = { mx: 0, my: 0, sprint: false }; }
    target.controlledBy = socketId;
    return { ok: true, pid: targetPid };
  }

  // Assignation automatique au démarrage : chaque humain prend un joueur libre de son équipe.
  autoAssign(socketId, team) {
    const taken = new Set(this.players.filter(p => p.controlledBy).map(p => p.pid));
    // Préférence : joueur de champ le plus avancé encore libre
    const candidates = this.players
      .filter(p => p.team === team && !p.isGK && !p.sentOff && !taken.has(p.pid))
      .sort((a, b) => (this.attackDir(team) * (b.x - a.x)));
    const pick = candidates[0] || this.players.find(p => p.team === team && !p.controlledBy && !p.sentOff);
    if (pick) { pick.controlledBy = socketId; return pick.pid; }
    return null;
  }

  releaseControl(socketId) {
    for (const p of this.players) {
      if (p.controlledBy === socketId) { p.controlledBy = null; p.input = { mx: 0, my: 0, sprint: false }; }
    }
  }

  humanControls(team) {
    return this.players.filter(p => p.team === team && p.controlledBy);
  }

  // ---------------------------------------------------------------------------
  // Actions du joueur contrôlé (déclenchées par des événements réseau)
  // ---------------------------------------------------------------------------
  doAction(socketId, msg) {
    if (this.phase === 'setpiece') return;   // placement en cours : pas d'action
    const p = this.players.find(pl => pl.controlledBy === socketId);
    if (!p || p.stunned > 0) return;
    const dir = this._actionDir(p, msg);
    // Ballon aérien à portée : Tir ou Passe déclenchent une tête (redirection)
    const aerial = !this.ball.owner && this.ball.z >= 20 &&
      S.dist(p.x, p.y, this.ball.x, this.ball.y) <= PHYS.POSSESS_RADIUS + 14;
    switch (msg.type) {
      case 'shootStart':
        // Entrée en visée slow-mo : seulement balle au pied, hors coup de pied arrêté.
        if (this.hasBall(p) && !this.restartFrozen && !this.pendingRestart) this.startShotAim(p);
        break;
      case 'shootCancel':
        if (this.shotAim && this.shotAim.pid === p.pid) this.shotAim = null;
        break;
      case 'shootLock':
        // Relâchement du bouton pendant la charge : puissance verrouillée
        // (celle que le client affichait), la phase de visée commence.
        this.lockShotPower(p, msg.power);
        break;
      case 'shoot':
        if (msg.timed) {
          // Frappe chronométrée : le client envoie l'angle de la flèche et la
          // charge QU'IL AFFICHAIT au relâchement (ce que le joueur a vu),
          // bornés aux valeurs possibles du balayage.
          const off = (typeof msg.off === 'number')
            ? S.clamp(msg.off, -S.SHOT.SWEEP_ANG, S.SHOT.SWEEP_ANG)
            : S.shotSweep(this.shotAim ? this.shotAim.age : 0);
          const pw = (typeof msg.power === 'number')
            ? S.clamp(msg.power, 0, 1)
            : (this.shotAim ? this.shotAim.power : 0.6);
          if (this.shotAim && this.shotAim.pid === p.pid) {
            this.tryShootTimed(p, off, pw);
            this.shotAim = null;
          } else if (this.hasBall(p)) {
            // Remise figée (penalty, coup franc) : frappe chronométrée directe
            this.tryShootTimed(p, off, pw);
          }
          // Sinon : le tir auto est déjà parti — on ignore (pas de volée fantôme)
        } else if (aerial) {
          this.tryHeader(p, dir);
        } else {
          this.tryShoot(p, dir, S.clamp(msg.power || 0.6, 0, 1));
        }
        break;
      case 'pass':
        if (aerial) this.tryHeader(p, dir);
        else this.tryPass(p, dir, 'short');
        break;
      case 'long': this._tryLongBall(p, dir, msg.power); break;
      case 'tackle': this.tryTackle(p); break;
      case 'standtackle': this.tryStandTackle(p); break;
      case 'dive': this.tryDive(p, dir); break;
    }
  }

  _actionDir(p, msg) {
    // Direction visée : joystick fourni sinon orientation actuelle
    if (msg && (msg.dx || msg.dy)) return S.norm(msg.dx, msg.dy);
    return { x: Math.cos(p.facing), y: Math.sin(p.facing) };
  }

  hasBall(p) { return this.ball.owner === p.pid; }

  // Tir : puissance selon jauge, précision selon direction. Volée auto si sans ballon.
  // Assistance de visée façon FIFA : si le joueur regarde grossièrement vers la
  // cage, la frappe est recadrée vers le point du CADRE le plus proche de son
  // intention (on projette sa visée sur la ligne de but et on la borne entre
  // les poteaux) — un tir voulu croisé reste croisé, un tir mal aligné rentre
  // dans le cadre au lieu de fuir en touche de but.
  _shotAssist(p, dir) {
    const b = this.ball;
    const gx = this.oppGoalX(p.team);
    const dxg = gx - b.x;
    if (S.dist(b.x, b.y, gx, FIELD.H / 2) > 500) return dir;      // trop loin : dégagement
    if (Math.abs(dir.x) < 0.15 || Math.sign(dir.x) !== Math.sign(dxg)) return dir;
    const tyRaw = b.y + (dir.y / dir.x) * dxg;                    // impact visé sur la ligne
    const ty = S.clamp(tyRaw, FIELD.GOAL_Y1 + 12, FIELD.GOAL_Y2 - 12);
    if (Math.abs(tyRaw - ty) > 200) return dir;                   // visée franchement à côté : voulue
    const assist = S.norm(dxg, ty - b.y);
    return S.norm(S.lerp(dir.x, assist.x, 0.75), S.lerp(dir.y, assist.y, 0.75));
  }

  tryShoot(p, dir, power01) {
    if (this.hasBall(p)) {
      dir = this._shotAssist(p, dir);
      const power = S.lerp(PHYS.MIN_SHOT_POWER, PHYS.MAX_SHOT_POWER, power01);
      // Frappe TENDUE et précise : peu d'imprécision latérale, et surtout une
      // élévation faible — le tir reste bas / à mi-hauteur au lieu de s'envoler
      // par-dessus la cage. La puissance donne de la vitesse, pas de la hauteur.
      const spread = 0.02 + 0.05 * power01;                 // plus fort = un peu moins précis
      const lift = 0.05 + 0.12 * power01;                   // ras du sol -> mi-hauteur
      this._kick(p, dir, power, spread, lift);
      this._emit('shot', p);
    } else if (this._nearMovingBall(p)) {
      // Reprise de volée : bonus puissance, précision réduite — le joueur
      // exécute une retournée acrobatique (animation diffusée à tous).
      const power = PHYS.MAX_SHOT_POWER * 0.95;
      this._kick(p, dir, power, 0.22, 0.6, true);
      p.volleyT = 0.85;
      p.kickAnimT = 0;
      this._emit('volley', p);
    }
  }

  // Entre en visée slow-mo : le ballon reste collé au pied du tireur, la
  // simulation passe au ralenti (cf. tick) jusqu'à la frappe ou l'expiration.
  // Deux phases : 'charge' (maintien = jauge de puissance) puis 'aim' (la
  // flèche balaie, compte à rebours, réappui = frappe).
  startShotAim(p) {
    if (this.shotAim) return;
    if (this.phase !== 'playing' && this.phase !== 'kickoff') return;
    if (!this.hasBall(p) || !p.controlledBy || p.stunned > 0) return;
    this.shotAim = { pid: p.pid, phase: 'charge', age: 0, power: 0 };
    // Un humain de l'équipe qui défend prend le gardien pour tenter l'arrêt
    this._beginGKTakeover(p.team === 'A' ? 'B' : 'A');
  }

  // Fin de la charge (relâchement du bouton) : verrouille la puissance et
  // lance la phase de visée (balayage de la flèche + compte à rebours).
  lockShotPower(p, power) {
    const sa = this.shotAim;
    if (!sa || sa.pid !== p.pid || sa.phase !== 'charge') return;
    sa.power = (typeof power === 'number') ? S.clamp(power, 0, 1) : S.shotCharge(sa.age);
    sa.phase = 'aim';
    sa.age = 0;
  }

  // Frappe du système chronométré : off = décalage angulaire de la flèche (rad)
  // autour de la direction du but, power01 = charge de la jauge. La puissance
  // fait tout : plus c'est chargé, plus le ballon part VITE et S'ÉLÈVE — pleine
  // puissance près de la cage = au-dessus de la barre ; presque pas chargé de
  // loin = la frappe meurt avant d'atteindre le but.
  tryShootTimed(p, off, power01) {
    const b = this.ball;
    const gx = this.oppGoalX(p.team);
    const base = Math.atan2(FIELD.H / 2 - b.y, gx - b.x);
    const sp = S.lerp(S.SHOT.MIN_SPEED, PHYS.MAX_SHOT_POWER, S.clamp(power01, 0, 1));
    const ang = base + S.clamp(off, -S.SHOT.SWEEP_ANG, S.SHOT.SWEEP_ANG)
      + (Math.random() - 0.5) * 0.02;
    b.vx = Math.cos(ang) * sp;
    b.vy = Math.sin(ang) * sp;
    b.vz = S.SHOT.RISE * Math.pow(S.clamp(power01, 0, 1), 1.7);
    b.curve = 0;
    b.owner = null;
    b.lastTouch = p.pid; b.lastTouchTeam = p.team;
    p.kickCd = PHYS.POSSESS_COOLDOWN;
    p.facing = ang;
    p.kickAnimT = 0.32;
    // Une frappe sur remise figée (penalty, coup franc) libère le ballon
    if (this.restartFrozen && this.restartFrozen.takerPid === p.pid) this.restartFrozen = null;
    this._emit('shot', p);
  }

  // Puissance d'une passe DOSÉE selon la distance : le ballon doit ARRIVER à
  // une vitesse contrôlable (PASS_ARRIVE), pas partir toujours à fond. La
  // friction au sol est exponentielle : v perd -ln(f) unités par unité de
  // distance, d'où puissance = arrivée + (-ln f)·D.
  _passPower(D) {
    return S.clamp(PHYS.PASS_ARRIVE + (-Math.log(PHYS.BALL_FRICTION)) * D,
      PHYS.PASS_MIN, PHYS.PASS_MAX);
  }

  tryPass(p, dir, kind) {
    if (!this.hasBall(p)) return;
    if (kind === 'long') return this._tryLongCross(p, dir);
    // Passe courte : tendue, au sol, dosée selon la distance de la cible.
    const mate = this._aimTeammate(p, dir, 300);
    let aim = dir, power = PHYS.PASS_POWER;
    if (mate) {
      let D = S.dist(this.ball.x, this.ball.y, mate.x, mate.y);
      power = this._passPower(D);
      // Anticipation avec la vitesse moyenne réelle du ballon (il décélère)
      const avg = (power + PHYS.PASS_ARRIVE) / 2;
      const lead = this._lead(p, mate, avg);
      D = S.dist(this.ball.x, this.ball.y, lead.x, lead.y);
      power = this._passPower(D);
      aim = S.norm(lead.x - this.ball.x, lead.y - this.ball.y);
    }
    this._kick(p, aim, power, 0.03, 0.0);
    this._emit('pass', p);
  }

  // Passe longue = CENTRE : ballon en cloche qui retombe sur la cible VISÉE
  // (coéquipier dans l'axe de la vue, sinon un point loin devant), dans la
  // direction de la flèche/vue. Il arrive aérien -> reprise de volée / tête
  // réellement jouable. Portée d'un tir en cloche : D = 2·lift·v² / g.
  _tryLongCross(p, dir) {
    const mate = this._aimTeammate(p, dir, 620);
    let tx, ty;
    if (mate) {
      const lead = this._lead(p, mate, PHYS.CROSS_POWER * 0.85);
      tx = lead.x; ty = lead.y;
    } else {
      const R = 470;                                        // portée par défaut sans cible
      tx = this.ball.x + dir.x * R;
      ty = this.ball.y + dir.y * R;
    }
    const dx = tx - this.ball.x, dy = ty - this.ball.y;
    const D = S.len(dx, dy) || 1;
    const aim = { x: dx / D, y: dy / D };
    const lift = 0.5;                                        // cloche : retombe dans la zone
    let v = Math.sqrt(D * AIR.GRAVITY / (2 * lift)) * 1.06;  // +6 % : compense la traînée
    v = S.clamp(v, PHYS.CROSS_POWER * 0.6, PHYS.CROSS_POWER * 1.6);
    this._kick(p, aim, v, 0.05, lift);
    // Effet enroulé : le centre s'incurve vers le but (Magnus), comme un
    // vrai centre brossé — visible surtout sur les corners.
    const gDir = S.norm(this.oppGoalX(p.team) - this.ball.x, FIELD.H / 2 - this.ball.y);
    const side = aim.x * gDir.y - aim.y * gDir.x;
    this.ball.curve = S.clamp(side, -1, 1) * 0.55;
    this._emit('cross', p);
  }

  // Ballon long DIRECTIONNEL (bouton Longue / dégagement depuis son camp) :
  // contrairement à une passe, il NE se verrouille PAS sur un coéquipier — le
  // ballon part en cloche vers la ZONE visée (direction de la vue), la distance
  // étant DOSÉE par la jauge (maintien). Sert à dégager loin ou à centrer vers
  // un endroit choisi. Il retombe aérien -> tête/volée réellement jouable.
  _tryLongBall(p, dir, power01) {
    if (!this.hasBall(p)) return;
    const pw = S.clamp(typeof power01 === 'number' ? power01 : 0.6, 0, 1);
    const R = S.lerp(PHYS.LONG_MIN_RANGE, PHYS.LONG_MAX_RANGE, pw);
    // Point d'arrivée = zone visée, bornée au terrain (on ne dégage pas dehors)
    const tx = S.clamp(this.ball.x + dir.x * R, 0, FIELD.W);
    const ty = S.clamp(this.ball.y + dir.y * R, 0, FIELD.H);
    const dx = tx - this.ball.x, dy = ty - this.ball.y;
    const D = S.len(dx, dy) || 1;
    const aim = { x: dx / D, y: dy / D };
    const lift = 0.5;                                        // cloche : retombe dans la zone
    let v = Math.sqrt(D * AIR.GRAVITY / (2 * lift)) * 1.06;  // +6 % : compense la traînée
    v = S.clamp(v, PHYS.CROSS_POWER * 0.55, PHYS.CROSS_POWER * 1.7);
    this._kick(p, aim, v, 0.06, lift);
    // Léger effet enroulé vers le but (centre brossé), plus discret qu'un centre
    const gDir = S.norm(this.oppGoalX(p.team) - this.ball.x, FIELD.H / 2 - this.ball.y);
    const side = aim.x * gDir.y - aim.y * gDir.x;
    this.ball.curve = S.clamp(side, -1, 1) * 0.35;
    this._emit('cross', p);
  }

  tryHeader(p, dir) {
    // Tête : ballon aérien proche -> redirection
    if (this.ball.z < 20 || this.ball.owner) return;
    if (S.dist(p.x, p.y, this.ball.x, this.ball.y) > PHYS.POSSESS_RADIUS + 14) return;
    this._kick(p, dir, PHYS.HEADER_POWER, 0.12, 0.25, true);
    this._emit('header', p);
  }

  tryTackle(p) {
    // Pas de tacle pendant/juste après une remise en jeu (respect de la reprise),
    // ni tant que le ballon d'une remise n'a pas été joué
    if (this.phase === 'setpiece' || this.restartProtect > 0 || this.restartFrozen) return;
    if (p.tackleCd > 0 || p.stunned > 0 || p.slideT > 0) return;
    p.tackleCd = PHYS.TACKLE_COOLDOWN;
    p.flash = 0.2;
    // Tacle glissé : élan vers l'avant, incontrôlable pendant la glissade.
    // RIEN n'est résolu ici : la récupération (ou la faute) se joue au CONTACT
    // réel pendant la glissade, dans _resolveSlides — un tacle peut donc
    // passer dans le vide s'il ne touche jamais le ballon.
    p.slideT = 0.55;
    p.slideHit = false;
    p.vx = Math.cos(p.facing) * 280;
    p.vy = Math.sin(p.facing) * 280;
  }

  // Tacle DEBOUT : contest rapide et sûr, sans glissade ni élan (clic bref sur
  // le bouton Tacle ; le maintien déclenche le tacle glissé). Le joueur pique le
  // ballon d'un adversaire proche DEVANT lui : récupération immédiate (pas de
  // chute), petit risque de faute, et faute systématique s'il l'attrape dans le
  // dos. À portée courte seulement — sinon le geste passe dans le vide.
  tryStandTackle(p) {
    if (this.phase === 'setpiece' || this.restartProtect > 0 || this.restartFrozen) return;
    if (p.tackleCd > 0 || p.stunned > 0 || p.slideT > 0) return;
    p.tackleCd = PHYS.STAND_TACKLE_COOLDOWN;
    p.standT = 0.35;              // geste de pique visible même si le ballon n'est pas atteint
    p.flash = 0.2;
    const b = this.ball;
    const face = { x: Math.cos(p.facing), y: Math.sin(p.facing) };
    const carrier = b.owner != null ? this.players.find(q => q.pid === b.owner) : null;
    if (carrier) {
      if (carrier.team === p.team) return;                                   // jamais sur un coéquipier
      if (this.shotAim && this.shotAim.pid === carrier.pid) return;          // tireur en visée protégé
      if (b.z > 24) return;                                                  // ballon en l'air : hors d'atteinte
      const d = S.dist(p.x, p.y, carrier.x, carrier.y);
      if (d > PHYS.STAND_TACKLE_REACH) return;                               // hors de portée : le pique passe dans le vide
      // Par derrière = faute (le porteur protège le ballon de son corps).
      // (Si les deux se superposent, on considère que ce n'est pas dans le dos.)
      const cFace = { x: Math.cos(carrier.facing), y: Math.sin(carrier.facing) };
      const toTackler = d > 0.01 ? S.norm(p.x - carrier.x, p.y - carrier.y) : { x: -cFace.x, y: -cFace.y };
      const fromBehind = (cFace.x * toTackler.x + cFace.y * toTackler.y) < -0.35;
      if (fromBehind || Math.random() < PHYS.STAND_TACKLE_FOUL_CHANCE) {
        this._foul(p, carrier, fromBehind);
        return;
      }
      // Récupération propre : le ballon est piqué vers l'avant du tacleur
      b.owner = null; b.z = 0; b.vz = 0; b.curve = 0;
      b.vx = face.x * 180; b.vy = face.y * 180;
      b.lastTouch = p.pid; b.lastTouchTeam = p.team;
      p.kickCd = 0.25;
      carrier.stunned = 0.35; carrier.kickCd = 0.4;
      this._emit('tackle', p);
    } else if (b.owner == null && b.z < 24 && S.dist(p.x, p.y, b.x, b.y) < PHYS.STAND_TACKLE_REACH) {
      // Ballon libre à portée : petite touche de contrôle
      this._giveBall(p);
      this._emit('tackle', p);
    }
  }

  // Résolution des tacles par CONTACT (appelée à chaque tick) :
  //  · le tacleur ne gagne le ballon que si sa glissade ATTEINT le ballon ;
  //  · toucher le porteur sans avoir joué le ballon = faute ;
  //  · par derrière = toujours faute (le porteur protège son ballon) ;
  //  · un tacle propre POUSSE le ballon dans le sens de la glissade (pas de
  //    téléportation du ballon au pied du tacleur).
  _resolveSlides() {
    const b = this.ball;
    for (const p of this.players) {
      if (p.slideT <= 0 || p.slideHit || p.sentOff) continue;
      const carrier = b.owner != null ? this.players.find(q => q.pid === b.owner) : null;
      if (carrier && carrier.team === p.team) continue;                          // jamais sur un coéquipier
      if (carrier && this.shotAim && this.shotAim.pid === carrier.pid) continue; // tireur en visée protégé
      const slideDir = S.len(p.vx, p.vy) > 20 ? S.norm(p.vx, p.vy)
        : { x: Math.cos(p.facing), y: Math.sin(p.facing) };
      const ballReachable = b.z < 24 && S.dist(p.x, p.y, b.x, b.y) < PHYS.TACKLE_REACH;
      if (carrier) {
        const face = { x: Math.cos(carrier.facing), y: Math.sin(carrier.facing) };
        const toTackler = S.norm(p.x - carrier.x, p.y - carrier.y);
        const fromBehind = (face.x * toTackler.x + face.y * toTackler.y) < -0.35;
        if (ballReachable) {
          p.slideHit = true;
          if (fromBehind || Math.random() < PHYS.TACKLE_FOUL_CHANCE) {
            this._foul(p, carrier, fromBehind);
          } else {
            b.owner = null; b.z = 0; b.vz = 0; b.curve = 0;
            b.vx = slideDir.x * 260; b.vy = slideDir.y * 260;
            b.lastTouch = p.pid; b.lastTouchTeam = p.team;
            p.kickCd = 0.3;
            carrier.stunned = 0.4; carrier.kickCd = 0.45;
            this._emit('tackle', p);
          }
        } else if (S.dist(p.x, p.y, carrier.x, carrier.y) < PHYS.BODY_RADIUS * 2 + 4) {
          // Fauche l'homme sans avoir touché le ballon
          p.slideHit = true;
          this._foul(p, carrier, fromBehind);
        }
      } else if (ballReachable) {
        // Ballon libre touché pendant la glissade : dégagé dans le sens du tacle
        p.slideHit = true;
        b.vx = slideDir.x * 220; b.vy = slideDir.y * 220;
        b.z = 0; b.vz = 0; b.curve = 0;
        b.lastTouch = p.pid; b.lastTouchTeam = p.team;
        p.kickCd = 0.3;
        this._emit('tackle', p);
      }
    }
  }

  // Récupération SANS tacle : un défenseur qui COURT sur le ballon dribblé par
  // un adversaire le lui arrache au contact — mais jamais par derrière (le
  // porteur protège son ballon de son corps). Complète le tacle glissé : on
  // peut donc reprendre la balle simplement en passant dessus en pleine course.
  _resolveContactSteal() {
    const b = this.ball;
    if (b.owner == null) return;
    if (this.restartFrozen || this.shotAim) return;                 // remise figée / tireur en visée protégés
    const carrier = this.players.find(q => q.pid === b.owner);
    if (!carrier) { b.owner = null; return; }
    for (const p of this.players) {
      if (p.team === carrier.team || p.sentOff) continue;
      if (p.stunned > 0 || p.slideT > 0 || p.kickCd > 0) continue;
      const sp = S.len(p.vx, p.vy);
      if (sp < PHYS.STEAL_MIN_SPEED) continue;                      // il faut vraiment courir
      if (S.dist(p.x, p.y, b.x, b.y) > PHYS.STEAL_REACH) continue;  // doit atteindre le ballon
      // Doit se déplacer VERS le ballon (il lui passe dessus, il ne s'en éloigne pas)
      const toBall = S.norm(b.x - p.x, b.y - p.y);
      if ((p.vx * toBall.x + p.vy * toBall.y) <= 0) continue;
      // Jamais par derrière : le porteur fait écran de son corps
      const face = { x: Math.cos(carrier.facing), y: Math.sin(carrier.facing) };
      const toStealer = S.norm(p.x - carrier.x, p.y - carrier.y);
      if ((face.x * toStealer.x + face.y * toStealer.y) < -0.35) continue;
      // Récupération propre : le ballon change de camp
      this._giveBall(p);
      carrier.stunned = 0.25; carrier.kickCd = 0.4;
      p.flash = 0.2;
      this._emit('tackle', p);
      return;
    }
  }

  tryDive(p, dir) {
    if (!p.isGK || p.diveCd > 0) return;
    p.diveCd = PHYS.DIVE_COOLDOWN;
    p.diving = 0.45;
    p.diveDir = Math.atan2(dir.y, dir.x);
    // Impulsion de plongeon
    p.vx = Math.cos(p.diveDir) * PHYS.DIVE_SPEED;
    p.vy = Math.sin(p.diveDir) * PHYS.DIVE_SPEED;
    // Capte le ballon s'il est à portée pendant le plongeon (bras levés : un
    // peu au-dessus de la barre, pas les ballons qui passent 6 m au-dessus)
    if (!this.ball.owner && S.dist(p.x, p.y, this.ball.x, this.ball.y) < PHYS.DIVE_RANGE && this.ball.z < PHYS.GOAL_TOP_Z + 6) {
      this._giveBall(p);
    }
    this._emit('dive', p);
  }

  // ---------------------------------------------------------------------------
  // Cœur du "coup de pied" : applique une vitesse au ballon
  // ---------------------------------------------------------------------------
  _kick(p, dir, power, spread, lift, fromMoving = false) {
    // Erreur de visée (imprécision)
    const ang = Math.atan2(dir.y, dir.x) + (Math.random() - 0.5) * spread * 2;
    const b = this.ball;
    let sp = power;
    if (fromMoving) sp += S.len(b.vx, b.vy) * 0.3;   // reprise : conserve un peu d'inertie
    b.vx = Math.cos(ang) * sp;
    b.vy = Math.sin(ang) * sp;
    b.vz = lift * sp;                                // composante verticale (cloche)
    b.curve = 0;                                     // sans effet par défaut (le centre en ajoute)
    b.owner = null;
    b.lastTouch = p.pid; b.lastTouchTeam = p.team;
    p.kickCd = PHYS.POSSESS_COOLDOWN;
    p.facing = ang;
    p.kickAnimT = 0.32;                              // animation de frappe (jambe)
    // La passe/le tir libère la remise en jeu figée
    if (this.restartFrozen && this.restartFrozen.takerPid === p.pid) this.restartFrozen = null;
  }

  _giveBall(p) {
    this.ball.owner = p.pid;
    this.ball.z = 0; this.ball.vz = 0; this.ball.curve = 0;
    this.ball.lastTouch = p.pid; this.ball.lastTouchTeam = p.team;
    this._autoSwitchOnReceive(p);
  }

  // Bascule automatique du contrôle (style FIFA) : quand le ballon arrive sur
  // un coéquipier géré par l'IA, un humain de l'équipe bascule dessus (et sa
  // caméra suit). Règle multijoueur : c'est l'humain dont le joueur est LE
  // PLUS LOIN du receveur qui prend le contrôle — jamais si un humain est
  // déjà sur le receveur. Un petit anti-rebond évite les bascules en rafale.
  _autoSwitchOnReceive(receiver) {
    if (receiver.controlledBy || receiver.isGK || receiver.sentOff) return;
    let best = null, bestD = -1;
    for (const q of this.players) {
      if (q.team !== receiver.team || !q.controlledBy || q.isGK) continue;
      if ((this.switchCd[q.controlledBy] || 0) > 0) continue;
      const d = S.dist2(q.x, q.y, receiver.x, receiver.y);
      if (d > bestD) { bestD = d; best = q; }
    }
    if (!best) return;
    const sid = best.controlledBy;
    best.controlledBy = null;
    receiver.controlledBy = sid;
    receiver.input = { ...best.input };     // continuité du joystick
    best.input = { mx: 0, my: 0, sprint: false };
    this.switchCd[sid] = 0.8;
  }

  // ---------------------------------------------------------------------------
  // Prise de gardien automatique : quand l'adversaire s'apprête à frapper
  // (visée slow-mo, penalty, coup franc proche), un humain de l'équipe qui
  // défend est basculé sur SON gardien — il peut se déplacer le long de la
  // cage et plonger pour l'arrêt. S'il n'y a aucun humain dans l'équipe, le
  // gardien IA gère l'arrêt (modulé par la difficulté choisie).
  // ---------------------------------------------------------------------------
  _beginGKTakeover(defTeam) {
    if (this.gkTakeover) return;
    const gk = this.players.find(p => p.team === defTeam && p.isGK);
    if (!gk || gk.controlledBy) return;                 // déjà tenu par un humain
    // Humain de l'équipe dont le joueur est le plus proche de son but
    const gx = this.ownGoalX(defTeam);
    let best = null, bestD = Infinity;
    for (const q of this.players) {
      if (q.team !== defTeam || !q.controlledBy || q.isGK) continue;
      const d = S.dist2(q.x, q.y, gx, FIELD.H / 2);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best) return;                                  // équipe 100 % IA : gardien IA
    const sid = best.controlledBy;
    best.controlledBy = null;
    best.input = { mx: 0, my: 0, sprint: false };
    gk.controlledBy = sid;
    gk.input = { mx: 0, my: 0, sprint: false };
    gk.flash = 0.4;
    this.gkTakeover = { sid, prevPid: best.pid, gkPid: gk.pid, timer: 4 };
  }

  // Rend le gardien à l'IA et restitue à l'humain son joueur de champ.
  _endGKTakeover() {
    const tk = this.gkTakeover;
    if (!tk) return;
    this.gkTakeover = null;
    const gk = this.players.find(p => p.pid === tk.gkPid);
    if (!gk || gk.controlledBy !== tk.sid) return;      // contrôle déjà changé entre-temps
    gk.controlledBy = null;
    gk.input = { mx: 0, my: 0, sprint: false };
    const prev = this.players.find(p => p.pid === tk.prevPid);
    if (prev && !prev.controlledBy && !prev.sentOff) prev.controlledBy = tk.sid;
    else this.autoAssign(tk.sid, gk.team);
  }

  // Suivi de la prise : tant que la menace dure (visée en cours, remise en
  // attente, gardien ballon en main), l'humain garde le gardien ; sinon un
  // court délai couvre le vol du ballon, puis chacun reprend son poste.
  _updateGKTakeover(dt) {
    const tk = this.gkTakeover;
    if (!tk) return;
    const gk = this.players.find(p => p.pid === tk.gkPid);
    // Contrôle perdu (déconnexion, tap sur un autre joueur) : on abandonne
    if (!gk || gk.controlledBy !== tk.sid) { this.gkTakeover = null; return; }
    const b = this.ball;
    const threat = this.shotAim || this.setPiece || this.restartFrozen || this.pendingRestart
      || b.owner === gk.pid;      // le gardien a capté : il relance lui-même
    if (threat) { tk.timer = 4; return; }
    tk.timer -= dt;
    if (tk.timer <= 0 || (b.owner != null && b.owner !== gk.pid)) this._endGKTakeover();
  }

  _foul(fouler, victim, fromBehind = false) {
    fouler.stunned = 0.8;
    fouler.tackleCd = PHYS.TACKLE_COOLDOWN * 1.5;
    this._emit('foul', fouler);

    // ---- Discipline : cartons -----------------------------------------------
    // Par derrière : jaune systématique, rouge direct si tacle très dangereux.
    // Faute normale : jaune 1 fois sur 4. Deux jaunes = rouge.
    // (Le gardien ne peut pas être expulsé — pas de remplaçant.)
    let cardMsg = '';
    if (!fouler.isGK) {
      const straightRed = fromBehind && Math.random() < 0.2;
      const yellow = fromBehind || Math.random() < 0.25;
      if (straightRed) {
        this._sendOff(fouler);
        cardMsg = ' — 🟥 ROUGE DIRECT !';
      } else if (yellow) {
        fouler.yellows++;
        if (fouler.yellows >= 2) {
          this._sendOff(fouler);
          cardMsg = ' — 🟨🟨 = 🟥 Expulsé !';
        } else {
          cardMsg = ' — 🟨 Carton jaune';
        }
        this._emit('card', fouler);
      }
    }

    // PENALTY si la faute est commise dans la surface de réparation du fautif
    const gx = this.ownGoalX(fouler.team);
    const inBox = (gx === 0 ? victim.x < FIELD.PENALTY_W : victim.x > FIELD.W - FIELD.PENALTY_W)
      && Math.abs(victim.y - FIELD.H / 2) < FIELD.PENALTY_H / 2;
    if (inBox) {
      const spotX = gx === 0 ? 110 : FIELD.W - 110;   // point de penalty
      this._startSetPiece('penalty', victim.team, spotX, FIELD.H / 2, '⚽ PENALTY !' + cardMsg);
      return;
    }

    // Sinon : coup franc à l'endroit de la faute, avec phase de placement
    const fx = S.clamp(victim.x, 20, FIELD.W - 20);
    const fy = S.clamp(victim.y, 20, FIELD.H - 20);
    this._startSetPiece('freekick', victim.team, fx, fy, 'Faute ! Coup franc' + cardMsg);
  }

  // Expulsion : le joueur quitte le terrain pour le reste du match.
  _sendOff(p) {
    p.sentOff = true;
    p.stunned = 0; p.slideT = 0; p.diving = 0;
    p.vx = p.vy = 0;
    // Placé hors du terrain (bande de la ligne de touche)
    p.x = S.clamp(p.x, 60, FIELD.W - 60);
    p.y = FIELD.H + 40;
    if (this.ball.owner === p.pid) this.ball.owner = null;
    // Si un humain le contrôlait, il bascule automatiquement sur un coéquipier
    if (p.controlledBy) {
      const sid = p.controlledBy;
      p.controlledBy = null;
      this.autoAssign(sid, p.team);
    }
    this._emit('redcard', p);
  }

  _aimTeammate(p, dir, maxDist) {
    let best = null, bestScore = -Infinity;
    const dAng = Math.atan2(dir.y, dir.x);
    for (const m of this.players) {
      if (m.team !== p.team || m === p || m.isGK || m.sentOff) continue;
      const dx = m.x - p.x, dy = m.y - p.y;
      const d = S.len(dx, dy);
      if (d > maxDist || d < 20) continue;
      const a = Math.atan2(dy, dx);
      let diff = Math.abs(a - dAng);
      while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
      if (diff > 1.1) continue;                    // hors du cône de passe
      const score = (1 - diff / 1.1) * 2 - d / maxDist;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  // Anticipation : vise devant le coéquipier en mouvement
  _lead(p, mate, power) {
    const d = S.dist(p.x, p.y, mate.x, mate.y);
    const t = d / power;
    return { x: mate.x + mate.vx * t, y: mate.y + mate.vy * t };
  }

  _nearMovingBall(p) {
    const b = this.ball;
    return !b.owner && S.dist(p.x, p.y, b.x, b.y) < PHYS.POSSESS_RADIUS + 18 && S.len(b.vx, b.vy) > 60;
  }

  // ---------------------------------------------------------------------------
  // Boucle principale
  // ---------------------------------------------------------------------------
  tick() {
    // Ralenti global pendant la visée d'un tir : on ralentit le pas de
    // simulation, donc TOUT (joueurs, ballon, IA, chrono) tourne au ralenti de
    // façon identique pour tous les clients (état autoritaire -> aucune désync).
    const slow = (this.shotAim && (this.phase === 'playing' || this.phase === 'kickoff'))
      ? PHYS.SHOT_SLOWMO : 1;
    const dt = this.dt * slow;

    // Gestion des délais de reprise (but, mi-temps)
    if (this.freezeAfter > 0) {
      this.freezeAfter -= dt;
      if (this.freezeAfter <= 0) this._resumeAfterFreeze();
      this._decayTimers(dt);
      return this._snapshot();
    }

    // ---- Phase de coup de pied arrêté : placement, chrono en pause ----------
    if (this.phase === 'setpiece' && this.setPiece) {
      const sp = this.setPiece;
      sp.timer -= dt;
      if (this.messageTtl > 0) { this.messageTtl -= dt; if (this.messageTtl <= 0) this.message = ''; }
      // Chacun rejoint son poste : humains libres, IA vers positions dédiées
      for (const p of this.players) {
        this._decayPlayer(p, dt);
        if (p.controlledBy) this._humanMove(p, dt);
        else AI.setPieceMove(this, p, dt);
      }
      for (const p of this.players) this._integratePlayer(p, dt);
      this._resolveCollisions();
      this._updateBall(dt);           // ballon collé au tireur
      if (sp.timer <= 0) {
        // Reprise : le ballon reste FIGÉ sur place jusqu'à la passe/le tir du
        // tireur — il ne peut pas dribbler, et l'adversaire ne peut pas le
        // prendre. Un tireur IA joue après un court délai "naturel".
        this.phase = 'playing';
        this.restartProtect = 1.0;
        this.restartFrozen = { type: sp.type, takerPid: sp.takerPid, x: this.ball.x, y: this.ball.y };
        this.pendingRestart = { type: sp.type, takerPid: sp.takerPid, delay: 0.5 + Math.random() * 0.8 };
        this.setPiece = null;
      }
      this._decayTimers(dt);
      return this._snapshot();
    }

    // ---- Sécurité de la remise figée ----------------------------------------
    if (this.restartFrozen) {
      const t = this.players.find(p => p.pid === this.restartFrozen.takerPid);
      if (!t || this.ball.owner !== this.restartFrozen.takerPid) {
        this.restartFrozen = null;      // état incohérent : on libère
      } else if (!t.controlledBy && !this.pendingRestart) {
        // Tireur repassé en IA (déconnexion) : on relance l'exécution auto
        this.pendingRestart = { type: this.restartFrozen.type, takerPid: t.pid, delay: 0.8 };
      }
    }

    // ---- Exécution différée du coup par un tireur IA ------------------------
    if (this.pendingRestart) {
      const pr = this.pendingRestart;
      const taker = this.players.find(p => p.pid === pr.takerPid);
      if (!taker || this.ball.owner !== pr.takerPid || taker.controlledBy) {
        this.pendingRestart = null;   // humain aux commandes ou ballon déjà joué
      } else {
        pr.delay -= dt;
        if (pr.delay <= 0) { this._execRestart(taker, pr); this.pendingRestart = null; }
      }
    }

    // Horloge de jeu
    if (this.phase === 'playing' || this.phase === 'kickoff') {
      this.time -= dt;
      if (this.time <= 0) { this.time = 0; this._endHalf(); }
    }
    if (this.restartProtect > 0) this.restartProtect -= dt;
    if (this.messageTtl > 0) { this.messageTtl -= dt; if (this.messageTtl <= 0) this.message = ''; }

    // ---- Visée de tir (slow-mo) : validité + sécurité ------------------------
    // L'âge se compte en temps RÉEL (this.dt non ralenti) pour que la fenêtre
    // se termine même si le joueur maintient le bouton ou se déconnecte.
    if (this.shotAim) {
      const sh = this.players.find(p => p.pid === this.shotAim.pid);
      if (!sh || this.ball.owner !== this.shotAim.pid || !sh.controlledBy || sh.sentOff || sh.stunned > 0) {
        this.shotAim = null;                       // état incohérent -> on libère
      } else {
        const sa = this.shotAim;
        sa.age += this.dt;
        if (sa.phase === 'charge') {
          sa.power = S.shotCharge(sa.age);
          // Maintien interminable : la puissance se verrouille toute seule
          if (sa.age > S.SHOT.CHARGE_HOLD_MAX) { sa.phase = 'aim'; sa.age = 0; }
        } else if (sa.age > S.SHOT.TIME_MAX) {
          // Compte à rebours écoulé : la frappe part LÀ OÙ EST LA FLÈCHE,
          // avec la puissance verrouillée — ce que le joueur voit à l'écran.
          this.tryShootTimed(sh, S.shotSweep(sa.age), sa.power);
          this.shotAim = null;
        }
      }
    }

    // 1) Mouvement des joueurs (humains + IA)
    for (const p of this.players) {
      this._decayPlayer(p, dt);
      if (p.controlledBy) this._humanMove(p, dt);
      else AI.updateAIPlayer(this, p, dt);
    }

    // 2) Intégration + limites du terrain
    for (const p of this.players) this._integratePlayer(p, dt);

    // 3) Collisions joueur-joueur (pas de superposition)
    this._resolveCollisions();

    // 4) Physique du ballon
    this._updateBall(dt);

    // 4bis) Contacts des tacles glissés
    this._resolveSlides();

    // 4ter) Récupération au contact en courant (sans tacle)
    this._resolveContactSteal();

    // 5) Possession
    this._updatePossession();

    // 6) Règles (buts / sorties)
    this._checkRules();

    // 7) Prise de gardien automatique (fin de menace -> retour au poste)
    this._updateGKTakeover(dt);

    this._decayTimers(dt);
    return this._snapshot();
  }

  _decayTimers(dt) {
    for (const p of this.players) {
      p.flash = Math.max(0, p.flash - dt);
    }
    for (const k in this.switchCd) {
      if (this.switchCd[k] > 0) this.switchCd[k] -= dt;
    }
  }

  _decayPlayer(p, dt) {
    p.tackleCd = Math.max(0, p.tackleCd - dt);
    p.diveCd = Math.max(0, p.diveCd - dt);
    p.kickCd = Math.max(0, p.kickCd - dt);
    p.stunned = Math.max(0, p.stunned - dt);
    p.diving = Math.max(0, p.diving - dt);
    p.slideT = Math.max(0, p.slideT - dt);
    p.standT = Math.max(0, p.standT - dt);
    p.kickAnimT = Math.max(0, p.kickAnimT - dt);
    p.volleyT = Math.max(0, p.volleyT - dt);
    // Jauge de sprint
    if (p.controlledBy && p.input.sprint && (p.input.mx || p.input.my) && p.sprint > 0) {
      p.sprint = Math.max(0, p.sprint - PHYS.SPRINT_DRAIN * dt);
    } else {
      p.sprint = Math.min(PHYS.SPRINT_MAX, p.sprint + PHYS.SPRINT_REGEN * dt);
    }
  }

  _humanMove(p, dt) {
    if (p.stunned > 0) return;
    if (p.diving > 0 || p.slideT > 0) return; // plongeon/glissade : l'impulsion domine
    // Le tireur d'un coup de pied arrêté reste posté sur le ballon
    if (this.phase === 'setpiece' && this.setPiece && this.setPiece.takerPid === p.pid) {
      p.vx *= 0.6; p.vy *= 0.6;
      return;
    }
    // Visée de tir (slow-mo) : le tireur reste posté, le joystick sert au
    // réticule côté client (aucun déplacement envoyé).
    if (this.shotAim && this.shotAim.pid === p.pid) {
      p.vx *= 0.4; p.vy *= 0.4;
      return;
    }
    // Remise figée : le tireur ne bouge pas, le joystick sert uniquement à VISER
    if (this.restartFrozen && this.restartFrozen.takerPid === p.pid) {
      const m = p.input;
      if (S.len(m.mx, m.my) > 0.15) p.facing = Math.atan2(m.my, m.mx);
      p.vx *= 0.5; p.vy *= 0.5;
      return;
    }
    const m = p.input;
    let speed = p.isGK ? PHYS.GK_SPEED : PHYS.PLAYER_SPEED;
    if (m.sprint && p.sprint > 0 && !p.isGK) speed *= PHYS.SPRINT_MULT;
    const mag = S.len(m.mx, m.my);
    // Accélération lissée vers la vitesse cible : pas d'à-coups, et les
    // corrections de collision ne sont plus écrasées d'un tick à l'autre.
    let tvx = 0, tvy = 0;
    if (mag > 0.05) {
      const nx = m.mx / mag, ny = m.my / mag;
      tvx = nx * speed * Math.min(1, mag);
      tvy = ny * speed * Math.min(1, mag);
      p.facing = Math.atan2(ny, nx);
    }
    const k = 1 - Math.exp(-10 * dt);
    p.vx += (tvx - p.vx) * k;
    p.vy += (tvy - p.vy) * k;
  }

  _integratePlayer(p, dt) {
    if (p.sentOff) return;   // l'expulsé reste hors du terrain
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.diving <= 0 && !p.controlledBy) { /* IA gère sa vitesse */ }
    // Amortissement du plongeon / de la glissade de tacle
    if (p.diving > 0 || p.slideT > 0) { p.vx *= 0.9; p.vy *= 0.9; }
    // Limites du terrain (les joueurs peuvent friser la ligne, pas sortir du décor)
    const m = PHYS.PLAYER_RADIUS;
    p.x = S.clamp(p.x, m, FIELD.W - m);
    p.y = S.clamp(p.y, m, FIELD.H - m);
    // Gardien pris en main pour l'arrêt : cantonné devant sa cage (déplacement
    // latéral le long de la ligne + plongeon), pas de sortie en pleine course.
    if (this.gkTakeover && this.gkTakeover.gkPid === p.pid) {
      const gx = this.ownGoalX(p.team);
      p.x = gx === 0 ? S.clamp(p.x, 6, 60) : S.clamp(p.x, FIELD.W - 60, FIELD.W - 6);
      p.y = S.clamp(p.y, FIELD.GOAL_Y1 - 34, FIELD.GOAL_Y2 + 34);
    }
  }

  _resolveCollisions() {
    // Rayon de corps réduit : les joueurs peuvent se frôler épaule contre
    // épaule comme dans FIFA, au lieu de rester à distance.
    const minD = PHYS.BODY_RADIUS * 2;
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i], b = this.players[j];
        if (a.sentOff || b.sentOff) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d === 0) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 0.01; }
        if (d >= minD) continue;
        const overlap = minD - d;
        const nx = dx / d, ny = dy / d;
        // Le porteur du ballon a la priorité : c'est l'autre qui est écarté.
        let wa = 0.5, wb = 0.5;
        if (this.hasBall(a)) { wa = 0.15; wb = 0.85; }
        else if (this.hasBall(b)) { wa = 0.85; wb = 0.15; }
        a.x -= nx * overlap * wa; a.y -= ny * overlap * wa;
        b.x += nx * overlap * wb; b.y += ny * overlap * wb;
        // Amortit seulement la composante d'approche (pas d'impulsion ajoutée,
        // donc pas de tremblement quand deux joueurs restent au contact).
        const avn = a.vx * nx + a.vy * ny;          // a va vers b si > 0
        if (avn > 0) { a.vx -= nx * avn * 0.6; a.vy -= ny * avn * 0.6; }
        const bvn = b.vx * nx + b.vy * ny;          // b va vers a si < 0
        if (bvn < 0) { b.vx -= nx * bvn * 0.6; b.vy -= ny * bvn * 0.6; }
      }
    }
  }

  _updateBall(dt) {
    const b = this.ball;
    b.px = b.x; b.py = b.y; b.pz = b.z;   // mémorise la position pré-mouvement
    if (b.owner != null) {
      // Remise figée : le ballon reste cloué au point de la remise, quel que
      // soit le mouvement/la visée du tireur.
      if (this.restartFrozen && b.owner === this.restartFrozen.takerPid) {
        b.x = this.restartFrozen.x; b.y = this.restartFrozen.y;
        b.z = 0; b.vx = b.vy = b.vz = 0;
        return;
      }
      const p = this.players.find(pl => pl.pid === b.owner);
      if (!p) { b.owner = null; }
      else {
        // Ballon conduit devant le porteur (dribble) — suivi lissé indépendant
        // du framerate pour un rendu fluide.
        const tx = p.x + Math.cos(p.facing) * PHYS.KICK_OFFSET;
        const ty = p.y + Math.sin(p.facing) * PHYS.KICK_OFFSET;
        const k = 1 - Math.exp(-14 * dt);
        b.x += (tx - b.x) * k;
        b.y += (ty - b.y) * k;
        b.z = 0; b.vx = p.vx; b.vy = p.vy; b.vz = 0;
        return;
      }
    }

    // Effet Magnus : la trajectoire s'incurve (centres brossés). L'effet
    // s'estompe vite dès que le ballon roule au sol.
    if (b.curve) {
      const a = b.curve * dt;
      const c = Math.cos(a), s = Math.sin(a);
      const nvx = b.vx * c - b.vy * s;
      b.vy = b.vx * s + b.vy * c;
      b.vx = nvx;
      if (b.z <= 0.5) b.curve *= Math.pow(0.05, dt);
    }

    // Vol / roulement libre
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // Axe vertical
    b.z += b.vz * dt;
    b.vz -= AIR.GRAVITY * dt;
    if (b.z <= 0) {
      b.z = 0;
      if (b.vz < -30) b.vz = -b.vz * 0.45; else b.vz = 0;  // rebond au sol
    }

    // Friction (au sol seulement)
    const fr = b.z <= 0.5 ? PHYS.BALL_FRICTION : PHYS.BALL_AIR_FRICTION;
    const f = Math.pow(fr, dt);
    b.vx *= f; b.vy *= f;

    // Rebonds sur les poteaux
    this._ballPosts(b);

    // Rebonds sur les bords hors-terrain (le décor) — la sortie franche est gérée par les règles
  }

  _ballPosts(b) {
    const minD = PHYS.BALL_RADIUS + 4;
    // Poteaux (verticaux) : collision seulement sous la hauteur de la barre
    const posts = [
      { x: 0, y: FIELD.GOAL_Y1 }, { x: 0, y: FIELD.GOAL_Y2 },
      { x: FIELD.W, y: FIELD.GOAL_Y1 }, { x: FIELD.W, y: FIELD.GOAL_Y2 },
    ];
    for (const post of posts) {
      const d = S.dist(b.x, b.y, post.x, post.y);
      if (d < minD && b.z < PHYS.GOAL_TOP_Z) {
        const nx = (b.x - post.x) / (d || 1), ny = (b.y - post.y) / (d || 1);
        b.x = post.x + nx * minD; b.y = post.y + ny * minD;
        const dot = b.vx * nx + b.vy * ny;
        b.vx = (b.vx - 2 * dot * nx) * PHYS.POST_RESTITUTION;
        b.vy = (b.vy - 2 * dot * ny) * PHYS.POST_RESTITUTION;
        this._emit('post', { x: post.x, y: post.y });
      }
    }
    // Barre transversale : cylindre horizontal au sommet de la cage — un
    // ballon qui la frôle rebondit au lieu de la traverser.
    for (const gx of [0, FIELD.W]) {
      if (b.y <= FIELD.GOAL_Y1 || b.y >= FIELD.GOAL_Y2) continue;
      const dx = b.x - gx, dz = b.z - PHYS.GOAL_TOP_Z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= minD) continue;
      const nx = dx / (d || 1), nz = dz / (d || 1);
      b.x = gx + nx * minD; b.z = PHYS.GOAL_TOP_Z + nz * minD;
      const dot = b.vx * nx + b.vz * nz;
      if (dot < 0) {
        b.vx = (b.vx - 2 * dot * nx) * PHYS.POST_RESTITUTION;
        b.vz = (b.vz - 2 * dot * nz) * PHYS.POST_RESTITUTION;
      }
      this._emit('post', { x: gx, y: b.y });
    }
  }

  _updatePossession() {
    const b = this.ball;
    if (b.owner != null) return;
    if (b.z > 30) return;                  // ballon aérien : pas de contrôle au pied (têtes)
    const r = PHYS.BALL_RADIUS;
    // Ballon entièrement sorti : personne ne le "sauve", les règles trancheront
    if (b.x + r < 0 || b.x - r > FIELD.W || b.y + r < 0 || b.y - r > FIELD.H) return;
    let best = null, bestD = PHYS.POSSESS_RADIUS;
    for (const p of this.players) {
      if (p.kickCd > 0 || p.stunned > 0 || p.sentOff || p.slideT > 0) continue;
      const d = S.dist(p.x, p.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return;
    const sp = S.len(b.vx, b.vy);
    // Ballon trop rapide pour un joueur de champ : contrôle raté, le ballon
    // dévie sur lui et ralentit (le gardien, lui, peut capter).
    if (!best.isGK && sp > PHYS.CAPTURE_MAX_SPEED) {
      const n = S.norm(b.x - best.x, b.y - best.y);
      const dot = b.vx * n.x + b.vy * n.y;
      if (dot < 0) {
        b.vx = (b.vx - 2 * dot * n.x) * 0.35;
        b.vy = (b.vy - 2 * dot * n.y) * 0.35;
      } else { b.vx *= 0.5; b.vy *= 0.5; }
      b.curve = 0;
      b.lastTouch = best.pid; b.lastTouchTeam = best.team;
      best.kickCd = 0.25;
      return;
    }
    // PREMIÈRE TOUCHE (contrôle orienté) : un ballon encore vif n'est pas
    // aspiré au pied — le joueur l'amortit dans le sens de sa course, puis le
    // contrôle vraiment au contact suivant. Rend les réceptions fluides.
    if (!best.isGK && sp > PHYS.CONTROL_SPEED) {
      const run = S.len(best.vx, best.vy) > 30 ? S.norm(best.vx, best.vy)
        : { x: Math.cos(best.facing), y: Math.sin(best.facing) };
      const push = 90 + sp * 0.12;
      b.vx = run.x * push + best.vx * 0.5;
      b.vy = run.y * push + best.vy * 0.5;
      b.z = 0; b.vz = 0; b.curve = 0;
      b.lastTouch = best.pid; b.lastTouchTeam = best.team;
      best.kickCd = 0.12;
      return;
    }
    this._giveBall(best);
  }

  // ---------------------------------------------------------------------------
  // Règles : but, touche, corner, dégagement
  // ---------------------------------------------------------------------------
  _checkRules() {
    if (this.phase === 'goal' || this.freezeAfter > 0) return;
    const b = this.ball;
    if (b.owner != null) return;   // ballon au pied : le porteur est borné au terrain
    const r = PHYS.BALL_RADIUS;

    // Règle du foot : la balle n'est sortie (ou marquée) que si elle a
    // ENTIÈREMENT franchi la ligne — tout le ballon derrière le bord extérieur,
    // pas au premier contact avec la ligne.
    if (b.x + r < 0) return this._goalLineCross('left');
    if (b.x - r > FIELD.W) return this._goalLineCross('right');

    // Sortie sur les lignes de touche -> remise en jeu à la main
    if (b.y + r < 0) return this._throwIn(b.x, 0, b);
    if (b.y - r > FIELD.H) return this._throwIn(b.x, FIELD.H, b);
  }

  // Franchissement complet d'une ligne de but : la position (y, z) est évaluée
  // au POINT EXACT de franchissement (interpolation entre deux ticks), pas au
  // moment de l'échantillonnage — un ballon passé AU-DESSUS de la barre ou à
  // côté des poteaux n'est donc jamais compté but, même à grande vitesse.
  _goalLineCross(side) {
    const b = this.ball;
    const r = PHYS.BALL_RADIUS;
    const plane = side === 'left' ? -r : FIELD.W + r;
    const t = (b.x !== b.px) ? S.clamp((plane - b.px) / (b.x - b.px), 0, 1) : 1;
    const yc = b.py + (b.y - b.py) * t;
    const zc = b.pz + (b.z - b.pz) * t;
    if (yc > FIELD.GOAL_Y1 && yc < FIELD.GOAL_Y2 && zc < PHYS.GOAL_TOP_Z) {
      // BUT : le ballon s'immobilise dans la cage (pas à travers le filet)
      b.x = side === 'left' ? Math.max(b.x, -11) : Math.min(b.x, FIELD.W + 11);
      b.y = yc; b.z = Math.min(zc, PHYS.GOAL_TOP_Z - 10);
      b.vx = b.vy = b.vz = 0;
      return this._goal(side === 'left' ? 'B' : 'A');
    }
    // Sortie en ligne de but : dernier toucher attaquant -> six mètres, sinon corner
    const defTeam = side === 'left' ? 'A' : 'B';
    const attTeam = defTeam === 'A' ? 'B' : 'A';
    if (b.lastTouchTeam === attTeam) this._goalKick(defTeam);
    else this._corner(side, attTeam, yc);
  }

  _corner(side, team, y) {
    const cornerX = side === 'left' ? FIELD.CORNER_R + 4 : FIELD.W - FIELD.CORNER_R - 4;
    const cornerY = y < FIELD.H / 2 ? FIELD.CORNER_R + 4 : FIELD.H - FIELD.CORNER_R - 4;
    this._startSetPiece('corner', team, cornerX, cornerY, 'Corner');
    this._emit('whistle', null);
  }

  _goalKick(team) {
    const gx = team === 'A' ? FIELD.GOALAREA_W : FIELD.W - FIELD.GOALAREA_W;
    this._startSetPiece('goalkick', team, gx, FIELD.H / 2, 'Six mètres', true);
    this._emit('whistle', null);
  }

  _throwIn(x, y, b) {
    const team = b.lastTouchTeam === 'A' ? 'B' : 'A';
    const tx = S.clamp(x, 20, FIELD.W - 20);
    const ty = y === 0 ? 10 : FIELD.H - 10;
    this._startSetPiece('throwin', team, tx, ty, 'Touche');
    this._emit('whistle', null);
  }

  // Coup de pied arrêté à la FIFA : coup de sifflet, phase de placement où
  // chacun rejoint sa position (le chrono est en pause), puis exécution —
  // immédiate pour un humain, différée de ~1s pour l'IA.
  _startSetPiece(type, team, x, y, label, preferGK = false) {
    this.restartFrozen = null;
    this.pendingRestart = null;
    this.shotAim = null;
    this._endGKTakeover();
    const b = this.ball;
    b.x = x; b.y = y; b.z = 0; b.vx = b.vy = b.vz = 0; b.curve = 0; b.owner = null;
    // Choix du tireur
    let taker;
    if (preferGK) taker = this.players.find(p => p.team === team && p.isGK);
    if (!taker) {
      const pool = this.players.filter(p => p.team === team && !p.isGK && !p.sentOff);
      taker = pool.sort((a, c) => S.dist2(a.x, a.y, x, y) - S.dist2(c.x, c.y, x, y))[0];
    }
    if (taker) {
      taker.x = x - this.attackDir(team) * 16; taker.y = S.clamp(y, 14, FIELD.H - 14);
      taker.vx = taker.vy = 0;
      taker.facing = Math.atan2(FIELD.H / 2 - taker.y, this.oppGoalX(team) === 0 ? -1 : 1);
      this._giveBall(taker);
      this.restartTaker = taker.pid;
    }
    this.setPiece = { type, team, takerPid: taker ? taker.pid : null, x, y, timer: 2.8 };
    this.phase = 'setpiece';
    this._setMessage(`${label} — ${team === 'A' ? 'équipe A' : 'équipe B'}`, 2.8);
    // Penalty / coup franc à portée de frappe : un humain de l'équipe qui
    // défend prend le gardien pour tenter l'arrêt.
    if (type === 'penalty' ||
        (type === 'freekick' && S.dist(x, y, this.oppGoalX(team), FIELD.H / 2) < 340)) {
      this._beginGKTakeover(team === 'A' ? 'B' : 'A');
    }
  }

  // Exécution automatique du coup par un tireur IA (corner -> centre, etc.)
  _execRestart(taker, pr) {
    const dir = this.attackDir(taker.team);
    if (pr.type === 'corner') {
      // Corner : centre en cloche vers la surface adverse.
      const gx = this.oppGoalX(taker.team);
      const boxX = gx + (taker.team === 'A' ? -FIELD.PENALTY_W * 0.6 : FIELD.PENALTY_W * 0.6);
      const boxY = FIELD.H / 2 + (taker.y < FIELD.H / 2 ? 1 : -1) * 40;
      this.tryPass(taker, S.norm(boxX - taker.x, boxY - taker.y), 'long');
    } else if (pr.type === 'penalty') {
      // Tir placé vers un côté de la cage
      const gx = this.oppGoalX(taker.team);
      const aimY = FIELD.H / 2 + (Math.random() < 0.5 ? -1 : 1) * (FIELD.GOAL_WIDTH / 2 - 18);
      this.tryShoot(taker, S.norm(gx - taker.x, aimY - taker.y), 0.8);
    } else if (pr.type === 'kickoff') {
      // Passe d'engagement en retrait vers un coéquipier
      const back = { x: -dir, y: (Math.random() - 0.5) * 1.2 };
      const mate = this._aimTeammate(taker, back, 320);
      if (mate) this.tryPass(taker, S.norm(mate.x - taker.x, mate.y - taker.y), 'short');
      else this.tryPass(taker, { x: -dir, y: 0.4 }, 'short');
    } else if (pr.type === 'goalkick') {
      this.tryPass(taker, { x: dir, y: (Math.random() - 0.5) * 0.8 }, 'long');
    } else if (pr.type === 'freekick' &&
               S.dist(taker.x, taker.y, this.oppGoalX(taker.team), FIELD.H / 2) < 320) {
      // Coup franc proche du but : frappe directe
      const g = S.norm(this.oppGoalX(taker.team) - taker.x, FIELD.H / 2 - taker.y);
      this.tryShoot(taker, g, 0.85);
    } else {
      // Touche / coup franc lointain : passe vers un coéquipier disponible
      const fwd = { x: dir, y: (Math.random() - 0.5) * 0.9 };
      const mate = this._aimTeammate(taker, fwd, 420);
      if (mate) {
        const kind = S.dist(taker.x, taker.y, mate.x, mate.y) > 250 ? 'long' : 'short';
        this.tryPass(taker, S.norm(mate.x - taker.x, mate.y - taker.y), kind);
      } else {
        this.tryPass(taker, fwd, 'long');
      }
    }
  }

  _goal(team) {
    this.phase = 'goal';
    this.shotAim = null;
    this._endGKTakeover();
    if (team === 'A') this.score.a++; else this.score.b++;
    this._setMessage(`BUT ! ${team === 'A' ? 'ÉQUIPE A' : 'ÉQUIPE B'}`, 3);
    this._emit('goal', { team });
    this.freezeAfter = 2.5;
    // L'équipe encaissée engage
    this.pendingKickoffTeam = team === 'A' ? 'B' : 'A';
  }

  // Engagement (début de match, après un but, 2e mi-temps) : vrai coup d'envoi
  // posé — un joueur au rond central avec le ballon, chacun dans sa moitié,
  // puis passe d'engagement.
  _kickoff(team) {
    this._resetPositions(team);
    this._startSetPiece('kickoff', team, FIELD.W / 2, FIELD.H / 2, 'Engagement');
  }

  _resumeAfterFreeze() {
    if (this.phase === 'goal') {
      this._kickoff(this.pendingKickoffTeam);
    } else if (this.phase === 'halftime') {
      this.half = 2;
      this.time = MATCH.DURATION;
      this._kickoff('B');
      this._setMessage('2ème mi-temps — Engagement', 2.8);
    }
  }

  _endHalf() {
    this._endGKTakeover();
    if (this.half >= MATCH.HALVES) {
      this.phase = 'fulltime';
      this._setMessage('Fin du match', 5);
      this._emit('fulltime', { score: this.score });
      if (this.room && this.room.onMatchEnd) this.room.onMatchEnd(this);
    } else {
      this.phase = 'halftime';
      this._setMessage('Mi-temps', 3);
      this.freezeAfter = 3;
    }
  }

  _setMessage(msg, ttl) { this.message = msg; this.messageTtl = ttl; }
  _emit(type, payload) {
    this.events.push({ type, x: payload && payload.x, y: payload && payload.y, team: payload && payload.team });
    if (this.events.length > 12) this.events.shift();
  }

  // ---------------------------------------------------------------------------
  // Snapshot réseau (compact) diffusé à chaque tick
  // ---------------------------------------------------------------------------
  _snapshot() {
    const players = this.players.map(p => ({
      i: p.pid,
      id: p.id,
      t: p.team,
      r: p.role,
      gk: p.isGK ? 1 : 0,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      f: Math.round(p.facing * 100) / 100,
      c: p.controlledBy || null,       // socketId du contrôleur (ou null = IA)
      st: p.stunned > 0 ? 1 : 0,
      dv: p.diving > 0 ? 1 : 0,
      sl: p.slideT > 0 ? 1 : 0,      // tacle glissé
      stk: p.standT > 0 ? 1 : 0,     // tacle debout (pique)
      ka: p.kickAnimT > 0 ? 1 : 0,   // frappe (mouvement de jambe)
      vo: p.volleyT > 0 ? 1 : 0,     // retournée acrobatique
      yc: p.yellows,                 // cartons jaunes
      off: p.sentOff ? 1 : 0,        // expulsé (hors du terrain)
      fz: (this.restartFrozen && this.restartFrozen.takerPid === p.pid) ? 1 : 0, // tireur en visée
      sa: (this.shotAim && this.shotAim.pid === p.pid) ? 1 : 0,     // tireur en visée slow-mo
      fl: p.flash > 0 ? 1 : 0,
      sp: Math.round(p.sprint),
    }));
    const ev = this.events; this.events = [];
    return {
      phase: this.phase,
      // Type de coup de pied arrêté en cours (placement OU ballon figé) : sert
      // au client à choisir la caméra dédiée (ex. vue de corner).
      rst: this.setPiece ? this.setPiece.type : (this.restartFrozen ? this.restartFrozen.type : null),
      time: Math.ceil(this.time),
      half: this.half,
      slowmo: this.shotAim ? 1 : 0,       // ralenti actif (visée de tir)
      score: this.score,
      ball: {
        x: Math.round(this.ball.x * 10) / 10,
        y: Math.round(this.ball.y * 10) / 10,
        z: Math.round(this.ball.z * 10) / 10,
        vx: Math.round(this.ball.vx),
        vy: Math.round(this.ball.vy),
        owner: this.ball.owner,
      },
      players,
      message: this.message,
      events: ev,
      format: this.format,
    };
  }
}

module.exports = { Match };

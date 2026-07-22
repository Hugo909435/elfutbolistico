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
    this.ball = { x: FIELD.W / 2, y: FIELD.H / 2, z: 0, vx: 0, vy: 0, vz: 0, owner: null, lastTouch: null, lastTouchTeam: null };
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
    this.switchCd = {};               // anti-rebond de la bascule auto (par socketId)
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
      slideT: 0, kickAnimT: 0, volleyT: 0,   // minuteries d'animation (diffusées)
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
      case 'shoot':
        if (aerial) this.tryHeader(p, dir);
        else this.tryShoot(p, dir, S.clamp(msg.power || 0.6, 0, 1));
        break;
      case 'pass':
        if (aerial) this.tryHeader(p, dir);
        else this.tryPass(p, dir, 'short');
        break;
      case 'long': this.tryPass(p, dir, 'long'); break;
      case 'cross': this.tryCross(p, dir); break;
      case 'tackle': this.tryTackle(p); break;
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
  tryShoot(p, dir, power01) {
    if (this.hasBall(p)) {
      const power = S.lerp(PHYS.MIN_SHOT_POWER, PHYS.MAX_SHOT_POWER, power01);
      const spread = 0.04 + 0.09 * power01;                 // plus fort = moins précis
      this._kick(p, dir, power, spread, 0.35 + power01 * 0.5);
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

  tryPass(p, dir, kind) {
    if (!this.hasBall(p)) return;
    const power = kind === 'long' ? PHYS.LONG_PASS_POWER : PHYS.PASS_POWER;
    // Assistance de ciblage : cherche un coéquipier dans la direction visée
    const mate = this._aimTeammate(p, dir, kind === 'long' ? 520 : 300);
    let aim = dir;
    if (mate) {
      const lead = this._lead(p, mate, power);
      aim = S.norm(lead.x - this.ball.x, lead.y - this.ball.y);
    }
    const lift = kind === 'long' ? 0.35 : 0.0;              // passe longue semi-aérienne
    this._kick(p, aim, power, 0.03, lift);
    this._emit(kind === 'long' ? 'longpass' : 'pass', p);
  }

  tryCross(p, dir) {
    if (!this.hasBall(p)) return;
    // Centre en cloche vers la surface adverse
    const gx = this.oppGoalX(p.team);
    const targetX = gx + (p.team === 'A' ? -FIELD.PENALTY_W * 0.6 : FIELD.PENALTY_W * 0.6);
    const targetY = FIELD.H / 2 + (p.y < FIELD.H / 2 ? 1 : -1) * 40;
    const aim = S.norm(targetX - this.ball.x, targetY - this.ball.y);
    this._kick(p, aim, PHYS.CROSS_POWER, 0.05, 0.9);        // fort lift = cloche
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
    // Tacle glissé : élan vers l'avant, incontrôlable pendant la glissade
    p.slideT = 0.55;
    p.vx = Math.cos(p.facing) * 280;
    p.vy = Math.sin(p.facing) * 280;
    // Cherche un adversaire porteur du ballon à portée
    const opp = this.players.find(o => o.team !== p.team && this.hasBall(o) &&
      S.dist(p.x, p.y, o.x, o.y) < PHYS.TACKLE_RANGE);
    if (!opp) {
      // Tacle dans le vide : peut quand même récupérer un ballon libre proche
      if (!this.ball.owner && S.dist(p.x, p.y, this.ball.x, this.ball.y) < PHYS.TACKLE_RANGE) {
        this._giveBall(p);
      }
      return;
    }
    // Tacle par derrière : le porteur protège son ballon avec son corps —
    // c'est TOUJOURS une faute, jamais une récupération.
    const face = { x: Math.cos(opp.facing), y: Math.sin(opp.facing) };
    const toTackler = S.norm(p.x - opp.x, p.y - opp.y);
    const fromBehind = (face.x * toTackler.x + face.y * toTackler.y) < -0.35;
    if (fromBehind || Math.random() < PHYS.TACKLE_FOUL_CHANCE) {
      this._foul(p, opp, fromBehind);
    } else {
      this._giveBall(p);
      opp.stunned = 0.4;
      this._emit('tackle', p);
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
    // Capte le ballon s'il est à portée pendant le plongeon
    if (!this.ball.owner && S.dist(p.x, p.y, this.ball.x, this.ball.y) < PHYS.DIVE_RANGE && this.ball.z < 60) {
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
    this.ball.z = 0; this.ball.vz = 0;
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
    const dt = this.dt;

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
        const taker = this.players.find(p => p.pid === sp.takerPid);
        if (taker && taker.controlledBy) this._setMessage('🎯 Vise avec le joystick, puis passe !', 2);
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

    // 5) Possession
    this._updatePossession();

    // 6) Règles (buts / sorties)
    this._checkRules();

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
    const posts = [
      { x: 0, y: FIELD.GOAL_Y1 }, { x: 0, y: FIELD.GOAL_Y2 },
      { x: FIELD.W, y: FIELD.GOAL_Y1 }, { x: FIELD.W, y: FIELD.GOAL_Y2 },
    ];
    for (const post of posts) {
      const d = S.dist(b.x, b.y, post.x, post.y);
      const minD = PHYS.BALL_RADIUS + 4;
      if (d < minD && b.z < 80) {
        const nx = (b.x - post.x) / (d || 1), ny = (b.y - post.y) / (d || 1);
        b.x = post.x + nx * minD; b.y = post.y + ny * minD;
        const dot = b.vx * nx + b.vy * ny;
        b.vx = (b.vx - 2 * dot * nx) * PHYS.POST_RESTITUTION;
        b.vy = (b.vy - 2 * dot * ny) * PHYS.POST_RESTITUTION;
        this._emit('post', { x: post.x, y: post.y });
      }
    }
  }

  _updatePossession() {
    const b = this.ball;
    if (b.owner != null) return;
    if (b.z > 30) return;                  // ballon aérien : pas de contrôle au pied (têtes)
    let best = null, bestD = PHYS.POSSESS_RADIUS;
    for (const p of this.players) {
      if (p.kickCd > 0 || p.stunned > 0 || p.sentOff) continue;
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
      b.lastTouch = best.pid; b.lastTouchTeam = best.team;
      best.kickCd = 0.25;
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
    const r = PHYS.BALL_RADIUS;

    // But ? (franchissement complet de la ligne entre les poteaux, sous la barre)
    if (b.x - r <= 0 && b.y > FIELD.GOAL_Y1 && b.y < FIELD.GOAL_Y2 && b.z < 80) {
      return this._goal('B'); // but pour B (attaque à gauche)
    }
    if (b.x + r >= FIELD.W && b.y > FIELD.GOAL_Y1 && b.y < FIELD.GOAL_Y2 && b.z < 80) {
      return this._goal('A');
    }

    // Sortie sur les lignes de but -> corner ou dégagement
    if (b.x - r <= 0) return this._goalLineOut('left', b);
    if (b.x + r >= FIELD.W) return this._goalLineOut('right', b);

    // Sortie sur les lignes de touche -> remise en jeu à la main
    if (b.y - r <= 0) return this._throwIn(b.x, 0, b);
    if (b.y + r >= FIELD.H) return this._throwIn(b.x, FIELD.H, b);
  }

  _goalLineOut(side, b) {
    // Ligne de gauche = but de A. Dernier toucher défenseur (A) -> corner B, sinon dégagement A.
    const defTeam = side === 'left' ? 'A' : 'B';
    const attTeam = defTeam === 'A' ? 'B' : 'A';
    const lastAtt = b.lastTouchTeam === attTeam;
    if (lastAtt) {
      this._corner(side, attTeam, b.y);
    } else {
      this._goalKick(defTeam);
    }
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
    const b = this.ball;
    b.x = x; b.y = y; b.z = 0; b.vx = b.vy = b.vz = 0; b.owner = null;
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
  }

  // Exécution automatique du coup par un tireur IA (corner -> centre, etc.)
  _execRestart(taker, pr) {
    const dir = this.attackDir(taker.team);
    if (pr.type === 'corner') {
      this.tryCross(taker, { x: dir, y: 0 });
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
      ka: p.kickAnimT > 0 ? 1 : 0,   // frappe (mouvement de jambe)
      vo: p.volleyT > 0 ? 1 : 0,     // retournée acrobatique
      yc: p.yellows,                 // cartons jaunes
      off: p.sentOff ? 1 : 0,        // expulsé (hors du terrain)
      fz: (this.restartFrozen && this.restartFrozen.takerPid === p.pid) ? 1 : 0, // tireur en visée
      fl: p.flash > 0 ? 1 : 0,
      sp: Math.round(p.sprint),
    }));
    const ev = this.events; this.events = [];
    return {
      phase: this.phase,
      time: Math.ceil(this.time),
      half: this.half,
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

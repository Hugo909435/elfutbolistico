/*
 * scene3d.js — Moteur de rendu 3D (Three.js).
 * Construit le stade (pelouse, lignes, cages, tribunes, ciel), des joueurs
 * humanoïdes articulés qui courent réellement (jambes/bras animés), le ballon,
 * et une caméra 3e personne qui suit le joueur contrôlé (derrière l'épaule).
 * Reçoit l'état interpolé du serveur et le restitue en 3D.
 */
import * as THREE from 'three';

const { FIELD, PHYS } = window.SHARED;

const SC = 0.1;                       // facteur monde(dm) -> mètres scène
const HW = (FIELD.W * SC) / 2;        // demi-longueur terrain
const HH = (FIELD.H * SC) / 2;        // demi-largeur terrain
const GOAL_H = 2.6;                   // hauteur des cages

// Monde serveur (x∈[0,W], y∈[0,H]) -> scène (X, Z), terrain centré à l'origine.
function sx(wx) { return (wx - FIELD.W / 2) * SC; }
function sz(wy) { return (wy - FIELD.H / 2) * SC; }

const SKIN = 0xe0ac69;
const JERSEY = { A: 0x2e86ff, B: 0xff4d4d };
const GK_JERSEY = { A: 0x18c39a, B: 0xffa41f };

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.players = new Map();   // pid -> { root, body, ring, parts, phase, last }
    this.clock = new THREE.Clock();
    this._camTarget = new THREE.Vector3(0, 1, 0);
    this._camPos = new THREE.Vector3(0, 6, 14);
    this._initRenderer();
    this._initScene();
    this._buildStadium();
    this._buildBall();
    this.resize();
  }

  // --------------------------------------------------------------------------
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    // Ciel dégradé + brume pour la profondeur
    this.scene.background = this._skyTexture();
    this.scene.fog = new THREE.Fog(0xcfe3ff, 60, 190);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
    this.camera.position.copy(this._camPos);

    // Lumières
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3c6b3c, 1.0);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.1);
    sun.position.set(35, 55, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = 70;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 200;
    this.scene.add(sun);
  }

  _skyTexture() {
    const c = document.createElement('canvas'); c.width = 8; c.height = 256;
    const g = c.getContext('2d').createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#5b9bff'); g.addColorStop(0.55, '#a9cbff'); g.addColorStop(1, '#e8f2ff');
    const cx = c.getContext('2d'); cx.fillStyle = g; cx.fillRect(0, 0, 8, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // --------------------------------------------------------------------------
  // Stade : pelouse + lignes, cages, tribunes
  // --------------------------------------------------------------------------
  _buildStadium() {
    // Pelouse (texture bandes + lignes réglementaires bakée sur un canvas)
    const tex = new THREE.CanvasTexture(this._pitchCanvas());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const M = FIELD.MARGIN;
    const gw = (FIELD.W + M * 2) * SC, gh = (FIELD.H + M * 2) * SC;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(gw, gh),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Cages aux deux extrémités
    this._buildGoal(-HW, 1);
    this._buildGoal(HW, -1);

    // Tribunes autour du terrain
    this._buildStands();
  }

  _pitchCanvas() {
    const M = FIELD.MARGIN, PX = 2;
    const W = (FIELD.W + M * 2) * PX, H = (FIELD.H + M * 2) * PX;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    // Bandes de pelouse
    const stripes = 14;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? '#37a054' : '#2f9149';
      g.fillRect((W / stripes) * i, 0, W / stripes + 1, H);
    }
    // Lignes (repère décalé de la marge)
    g.translate(M * PX, M * PX);
    g.scale(PX, PX);
    g.strokeStyle = 'rgba(255,255,255,0.92)'; g.fillStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 2.2;
    const line = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    const rect = (x, y, w, h) => g.strokeRect(x, y, w, h);
    const circ = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); };
    const dot = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
    // Contour + médiane + rond central
    rect(0, 0, FIELD.W, FIELD.H);
    line(FIELD.W / 2, 0, FIELD.W / 2, FIELD.H);
    circ(FIELD.W / 2, FIELD.H / 2, FIELD.CENTER_R); dot(FIELD.W / 2, FIELD.H / 2, 3);
    // Surfaces des deux côtés
    for (const side of [0, 1]) {
      const gx = side ? FIELD.W : 0, dir = side ? -1 : 1;
      rect(Math.min(gx, gx + dir * FIELD.PENALTY_W), FIELD.H / 2 - FIELD.PENALTY_H / 2, FIELD.PENALTY_W, FIELD.PENALTY_H);
      rect(Math.min(gx, gx + dir * FIELD.GOALAREA_W), FIELD.H / 2 - FIELD.GOALAREA_H / 2, FIELD.GOALAREA_W, FIELD.GOALAREA_H);
      dot(gx + dir * 110, FIELD.H / 2, 2.5);
    }
    return c;
  }

  _buildGoal(gx, dir) {
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const z1 = sz(FIELD.GOAL_Y1), z2 = sz(FIELD.GOAL_Y2);
    const post = 0.12;
    const mkBox = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), white);
      m.position.set(x, y, z); m.castShadow = true; this.scene.add(m); return m;
    };
    mkBox(post, GOAL_H, post, gx, GOAL_H / 2, z1);
    mkBox(post, GOAL_H, post, gx, GOAL_H / 2, z2);
    mkBox(post, post, Math.abs(z2 - z1) + post, gx, GOAL_H, (z1 + z2) / 2);   // barre transversale
    // Filet (planes translucides avec grille)
    const netTex = this._netTexture();
    const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
    const depth = 1.3, bx = gx + dir * depth;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(z2 - z1), GOAL_H), netMat);
    back.position.set(bx, GOAL_H / 2, (z1 + z2) / 2); back.rotation.y = Math.PI / 2; this.scene.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(depth, Math.abs(z2 - z1)), netMat);
    top.position.set(gx + dir * depth / 2, GOAL_H, (z1 + z2) / 2); top.rotation.x = Math.PI / 2; this.scene.add(top);
    for (const z of [z1, z2]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(depth, GOAL_H), netMat);
      s.position.set(gx + dir * depth / 2, GOAL_H / 2, z); this.scene.add(s);
    }
  }

  _netTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1;
    for (let i = 0; i <= 64; i += 6) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.moveTo(0, i); g.lineTo(64, i); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 3); return t;
  }

  _buildStands() {
    const crowd = new THREE.CanvasTexture(this._crowdCanvas());
    crowd.wrapS = crowd.wrapT = THREE.RepeatWrapping; crowd.repeat.set(10, 2);
    const mat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 1 });
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x2a3540, roughness: 1 });
    const standH = 7, standD = 10;
    const mk = (w, h, d, x, y, z, rx = 0) => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), baseMat);
      base.receiveShadow = true; g.add(base);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, Math.hypot(h, d)), mat);
      face.position.set(0, h / 2, d / 2 + 0.05); face.rotation.x = rx; g.add(face);
      g.position.set(x, y, z); this.scene.add(g);
    };
    const M = FIELD.MARGIN * SC;
    // Longs côtés
    mk((FIELD.W + FIELD.MARGIN * 2) * SC, standH, standD, 0, standH / 2, -(HH + M + standD / 2), 0.5);
    mk((FIELD.W + FIELD.MARGIN * 2) * SC, standH, standD, 0, standH / 2, (HH + M + standD / 2), -0.5 + Math.PI);
    // Petits côtés
    const s2 = new THREE.Mesh(new THREE.BoxGeometry((FIELD.H + FIELD.MARGIN * 2) * SC, standH, standD), baseMat);
    s2.position.set(-(HW + M + standD / 2), standH / 2, 0); s2.rotation.y = Math.PI / 2; this.scene.add(s2);
    const s3 = s2.clone(); s3.position.x = (HW + M + standD / 2); this.scene.add(s3);
  }

  _crowdCanvas() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#1b2530'; g.fillRect(0, 0, 128, 64);
    const cols = ['#e0e0e0', '#ffd23f', '#2e86ff', '#ff4d4d', '#37a054', '#ffffff', '#b0b0b0'];
    for (let i = 0; i < 900; i++) {
      g.fillStyle = cols[(Math.random() * cols.length) | 0];
      g.fillRect(Math.random() * 128, Math.random() * 64, 2, 2);
    }
    return c;
  }

  // --------------------------------------------------------------------------
  // Ballon
  // --------------------------------------------------------------------------
  _buildBall() {
    const tex = new THREE.CanvasTexture(this._ballCanvas());
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.33, 20, 16),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 })
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    this._ballPrev = new THREE.Vector3();
  }

  _ballCanvas() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#222';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.arc((i * 13) % 64, (i * 21) % 64, 5, 0, Math.PI * 2); g.fill(); }
    return c;
  }

  // --------------------------------------------------------------------------
  // Joueur humanoïde articulé
  // --------------------------------------------------------------------------
  _makePlayer(team, isGK, label) {
    const jColor = isGK ? GK_JERSEY[team] : JERSEY[team];
    const jersey = new THREE.MeshStandardMaterial({ color: jColor, roughness: 0.55 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x2b1d12, roughness: 0.9 });
    const shortMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
    const sockMat = new THREE.MeshStandardMaterial({ color: jColor, roughness: 0.8 });
    const shoeMat = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.5 });

    const root = new THREE.Group();          // position + orientation (facing)
    const body = new THREE.Group();          // inclinaison (plongeon) + rebond
    root.add(body);

    // Torse (capsule arrondie) + col
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.34, 6, 14), jersey);
    torso.position.y = 1.24; torso.castShadow = true; body.add(torso);
    // Épaules légèrement plus larges
    const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.4, 4, 10), jersey);
    shoulders.rotation.z = Math.PI / 2; shoulders.position.y = 1.5; shoulders.castShadow = true; body.add(shoulders);
    // Short
    const shorts = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.14, 4, 12), shortMat);
    shorts.position.y = 0.95; shorts.castShadow = true; body.add(shorts);
    // Cou
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8), skin);
    neck.position.y = 1.62; body.add(neck);
    // Tête + cheveux
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 14), skin);
    head.position.y = 1.78; head.castShadow = true; body.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.168, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), hairMat);
    hair.position.y = 1.78; hair.castShadow = true; body.add(hair);

    // Numéro dans le dos
    if (label) {
      const numTex = new THREE.CanvasTexture(this._numberCanvas(label));
      const num = new THREE.Mesh(
        new THREE.PlaneGeometry(0.3, 0.3),
        new THREE.MeshBasicMaterial({ map: numTex, transparent: true })
      );
      num.position.set(0, 1.28, -0.255); num.rotation.y = Math.PI; body.add(num);
    }

    // Fabrique un membre articulé (pivot en haut) : segments empilés + accessoire au bout
    const leg = (side) => {
      const grp = new THREE.Group();
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.28, 4, 10), skin);
      thigh.position.y = -0.22; thigh.castShadow = true; grp.add(thigh);
      const sock = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.22, 4, 10), sockMat);
      sock.position.y = -0.55; sock.castShadow = true; grp.add(sock);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.28), shoeMat);
      shoe.position.set(0, -0.72, 0.06); shoe.castShadow = true; grp.add(shoe);
      grp.position.set(side * 0.12, 0.92, 0);
      return grp;
    };
    const arm = () => {
      const grp = new THREE.Group();
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.42, 4, 10), skin);
      upper.position.y = -0.25; upper.castShadow = true; grp.add(upper);
      return grp;
    };
    const legL = leg(-1), legR = leg(1);
    const armL = arm(), armR = arm();
    armL.position.set(-0.32, 1.5, 0); armR.position.set(0.32, 1.5, 0);
    body.add(legL, legR, armL, armR);

    // Anneau au sol (indicateur de contrôle)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.055, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd23f })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
    root.add(ring);

    this.scene.add(root);
    return {
      root, body, ring, parts: { legL, legR, armL, armR },
      phase: Math.random() * 6, last: new THREE.Vector3(), lean: 0, yaw: 0,
      kickT: 0, voT: 0, slideAmt: 0, wasKa: false, wasVo: false,
    };
  }

  _numberCanvas(label) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.font = 'bold 46px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.55)';
    const txt = label.replace(/[^0-9]/g, '') || label.slice(-1);
    g.strokeText(txt, 32, 34); g.fillText(txt, 32, 34);
    return c;
  }

  // --------------------------------------------------------------------------
  // Mise à jour depuis l'état interpolé
  // --------------------------------------------------------------------------
  update(state, ctx) {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!state) { this.render(); return; }

    // Ballon
    const bx = sx(state.ball.x), bz = sz(state.ball.y), by = 0.33 + (state.ball.z || 0) * SC;
    const nb = new THREE.Vector3(bx, by, bz);
    const moved = nb.clone().sub(this._ballPrev);
    this.ball.position.copy(nb);
    // Roulement du ballon
    const md = Math.hypot(moved.x, moved.z);
    if (md > 0.001) {
      const axis = new THREE.Vector3(moved.z, 0, -moved.x).normalize();
      this.ball.rotateOnWorldAxis(axis, md / 0.33);
    }
    this._ballPrev.copy(nb);

    // Joueurs
    let controlled = null;
    for (const p of state.players) {
      let e = this.players.get(p.i);
      if (!e) { e = this._makePlayer(p.t, p.gk, p.gk ? '1' : p.id); this.players.set(p.i, e); }
      // Joueur expulsé : masqué (il a quitté le terrain)
      e.root.visible = !p.off;
      if (p.off) continue;
      const px = sx(p.x), pz = sz(p.y);
      const pos = new THREE.Vector3(px, 0, pz);

      // Orientation lissée vers la direction de déplacement/regard
      const dx = Math.cos(p.f), dz = Math.sin(p.f);
      const targetYaw = Math.atan2(dx, dz);
      let dyaw = targetYaw - e.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      e.yaw += dyaw * (1 - Math.exp(-12 * dt));
      e.root.rotation.y = e.yaw;

      // Vitesse (pour l'animation de course) via déplacement réel
      const step = pos.distanceTo(e.last);
      const speed = step / dt;                        // unités scène/s
      const run = Math.min(1, speed / 11);            // 0 (arrêt) .. 1 (sprint)
      e.phase += step * 4.2 + run * dt * 3;

      // -- Détection des actions serveur (front montant -> anim locale) --
      if (p.ka && !e.wasKa) e.kickT = 0.32;
      e.wasKa = !!p.ka;
      if (p.vo && !e.wasVo) e.voT = 0.85;
      e.wasVo = !!p.vo;
      if (e.kickT > 0) e.kickT -= dt;
      if (e.voT > 0) e.voT -= dt;
      e.slideAmt += ((p.sl ? 1 : 0) - e.slideAmt) * Math.min(1, dt * 10);
      const targetLean = p.dv ? 1.25 : 0;
      e.lean += (targetLean - e.lean) * Math.min(1, dt * 12);

      // Pose de base : balancier de course (bras/jambes)
      const swing = (0.35 + 0.75 * run) * Math.min(1, run * 3);
      const s = Math.sin(e.phase);
      let legL = s * swing, legR = -s * swing;
      let armL = -s * swing * 0.7, armR = s * swing * 0.7;
      let bodyRotX = e.lean;                                        // plongeon GK
      let bodyY = Math.abs(Math.sin(e.phase)) * 0.06 * run - e.lean * 0.35;

      if (e.voT > 0) {
        // RETOURNÉE ACROBATIQUE : saut + rotation arrière complète, jambe fouettée
        const u = 1 - e.voT / 0.85;
        bodyY = Math.sin(u * Math.PI) * 1.05;
        bodyRotX = -u * Math.PI * 2;
        legR = -1.7 * Math.sin(u * Math.PI);
        legL = 0.5 * Math.sin(u * Math.PI);
        armL = 1.2; armR = -1.2;
      } else if (e.slideAmt > 0.03) {
        // TACLE GLISSÉ : corps couché en arrière au ras du sol, jambe tendue
        const a = e.slideAmt;
        bodyRotX = -1.05 * a + e.lean;
        bodyY = -0.52 * a;
        legR = -1.5 * a;
        legL = -0.8 * a;
        armL = 0.9 * a; armR = -0.4 * a;
      } else if (e.kickT > 0) {
        // FRAPPE : jambe armée en arrière puis fouettée vers l'avant
        const u = 1 - e.kickT / 0.32;
        legR = u < 0.3 ? (u / 0.3) * 0.9 : 0.9 - ((u - 0.3) / 0.7) * 2.6;
        armL = -0.6; armR = 0.4;
      }

      e.parts.legL.rotation.x = legL;
      e.parts.legR.rotation.x = legR;
      e.parts.armL.rotation.x = armL;
      e.parts.armR.rotation.x = armR;
      e.body.rotation.x = bodyRotX;
      e.body.position.y = bodyY;

      e.root.position.copy(pos);
      e.last.copy(pos);

      // Anneau de contrôle : jaune = moi, blanc = autre humain de mon équipe
      const isMine = p.c === ctx.mySocket;
      const isHumanMate = p.c && p.t === ctx.myTeam && !isMine;
      e.ring.visible = isMine || isHumanMate;
      if (e.ring.visible) e.ring.material.color.setHex(isMine ? 0xffd23f : 0xffffff);
      if (isMine) controlled = { pos, dir: new THREE.Vector3(dx, 0, dz), team: p.t };

      // Flash (refus de contrôle) : teinte rouge éphémère de l'anneau
      if (p.fl && !e.ring.visible) { e.ring.visible = true; e.ring.material.color.setHex(0xff3030); }
    }

    this._updateCamera(controlled, state, dt, ctx.aim);
    this.render();
  }

  _updateCamera(controlled, state, dt, aim) {
    let desiredPos, lookAt;
    if (controlled && aim != null) {
      // MODE VISÉE (remise en jeu figée) : caméra orbitale derrière le tireur,
      // pilotée par le joystick — on balaye le terrain pour choisir sa passe.
      const p = controlled.pos;
      const dx = Math.cos(aim), dz = Math.sin(aim);   // monde (x,y) -> scène (X,Z)
      desiredPos = new THREE.Vector3(p.x - dx * 8.5, 4.6, p.z - dz * 8.5);
      lookAt = new THREE.Vector3(p.x + dx * 14, 0.8, p.z + dz * 14);
    } else if (controlled) {
      // Caméra 3e personne STABLE, orientée vers le but adverse, qui cadre
      // TOUJOURS le joueur ET le ballon : elle recule derrière le plus en
      // retrait des deux et prend de la hauteur quand ils s'écartent.
      const atk = controlled.team === 'A' ? 1 : -1;    // sens d'attaque en X scène
      const p = controlled.pos;
      const b = this.ball.position;
      // La caméra VISE LE BALLON (priorité absolue : on ne le perd jamais de
      // vue), et recule derrière le plus en retrait des deux pour garder
      // aussi le joueur contrôlé dans le cadre.
      const rearX = atk === 1 ? Math.min(p.x, b.x) : Math.max(p.x, b.x);
      const spread = Math.min(45, Math.hypot(p.x - b.x, p.z - b.z));
      const dist = 9 + spread * 0.55;
      const height = 5.4 + spread * 0.4;
      const midZ = b.z * 0.6 + p.z * 0.4;
      desiredPos = new THREE.Vector3(rearX - atk * dist, height, midZ * 0.9);
      lookAt = new THREE.Vector3(
        b.x * 0.7 + p.x * 0.3,
        0.5,
        b.z * 0.7 + p.z * 0.3
      );
    } else {
      // Caméra de retransmission : suit le ballon en diagonale
      const b = this.ball.position;
      desiredPos = new THREE.Vector3(b.x - 6, 16, b.z - 22);
      lookAt = new THREE.Vector3(b.x, 0, b.z + 4);
    }
    // Amortissement exponentiel indépendant du framerate.
    // La cible (le ballon) est suivie plus vite que la position : même sur un
    // tir puissant, le ballon reste cadré pendant que la caméra recule.
    this._camPos.lerp(desiredPos, 1 - Math.exp(-dt * 4.5));
    this._camTarget.lerp(lookAt, 1 - Math.exp(-dt * 9));
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camTarget);
  }

  // Base caméra projetée au sol (pour des contrôles relatifs à l'écran)
  cameraBasis() {
    const e = this.camera.matrixWorld.elements;
    let fx = -e[8], fz = -e[10]; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    let rx = e[0], rz = e[2]; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    return { fwd: { x: fx, z: fz }, right: { x: rx, z: rz } };
  }

  // Sélection d'un joueur au tap (raycast) -> pid ou null
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const roots = [];
    for (const [pid, e] of this.players) { e.root.userData.pid = pid; roots.push(e.root); }
    const hits = ray.intersectObjects(roots, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && o.userData.pid === undefined) o = o.parent;
    return o ? o.userData.pid : null;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

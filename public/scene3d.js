/*
 * scene3d.js — Moteur de rendu 3D (Three.js).
 * Construit le stade (pelouse, lignes, cages, tribunes, ciel), des joueurs
 * humanoïdes articulés qui courent réellement (jambes/bras animés), le ballon,
 * et une caméra 3e personne qui suit le joueur contrôlé (derrière l'épaule).
 * Reçoit l'état interpolé du serveur et le restitue en 3D.
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const { FIELD, PHYS } = window.SHARED;

const SC = 0.1;                       // facteur monde(dm) -> mètres scène
const HW = (FIELD.W * SC) / 2;        // demi-longueur terrain
const HH = (FIELD.H * SC) / 2;        // demi-largeur terrain
const GOAL_H = 2.6;                   // hauteur des cages
const BALL_R = 0.22;                  // rayon visuel du ballon

// Monde serveur (x∈[0,W], y∈[0,H]) -> scène (X, Z), terrain centré à l'origine.
function sx(wx) { return (wx - FIELD.W / 2) * SC; }
function sz(wy) { return (wy - FIELD.H / 2) * SC; }

// Variations d'apparence (choisies de façon déterministe par joueur)
const SKIN_TONES = [0xf5cba7, 0xe8b184, 0xd29b68, 0xb07b4f, 0x8a5a33, 0x5f3d22];
const HAIR_COLORS = [0x181512, 0x2b1d12, 0x4a2f1b, 0x6b4a2a, 0x9a6b32, 0x30302f];
const JERSEY = { A: 0x2e86ff, B: 0xff4d4d };
const GK_JERSEY = { A: 0x18c39a, B: 0xffa41f };

// Personnage Mixamo + animations du Soccer Game Pack (public/model/)
const MODEL_DIR = 'model/';
const ANIM_DIR = 'model/Soccer Game Pack/';
const CHARACTER = 'Ch38_nonPBR.fbx';
const ANIMS = {
  idle: 'offensive idle.fbx',
  gkIdle: 'goalkeeper idle.fbx',
  run: 'jog forward.fbx',
  kick: 'kick soccerball.fbx',
  slide: 'soccer tackle (2).fbx',   // tacle GLISSÉ au sol (maintien) — variante qui plonge vraiment
  standTackle: 'soccer tackle.fbx', // tacle DEBOUT / pique (clic bref)
  dive: 'goalkeeper diving save.fbx',
  volley: 'scissor kick.fbx',
};

// --------------------------------------------------------------------------
// Chargement (unique, partagé) du personnage + clips d'animation.
// Appelé au plus tôt par client.js dès l'ouverture de la page, pour que tout
// soit téléchargé AVANT le coup d'envoi ; Scene3D réutilise la même promesse.
// onProgress (optionnel) reçoit la progression globale 0..1.
// --------------------------------------------------------------------------
let _charPromise = null;
export function preloadCharacter(onProgress) {
  if (_charPromise) return _charPromise;
  const loader = new FBXLoader();
  const prog = new Map();                  // url -> [octets reçus, attendus]
  const report = () => {
    if (!onProgress) return;
    let loaded = 0, total = 0;
    for (const [l, t] of prog.values()) { loaded += l; total += t; }
    if (total > 0) onProgress(Math.min(1, loaded / total));
  };
  const load = (url) => new Promise((res, rej) => loader.load(
    encodeURI(url), res,
    (ev) => { prog.set(url, [ev.loaded, ev.total || ev.loaded]); report(); },
    rej
  ));
  const keys = Object.keys(ANIMS);
  _charPromise = Promise.all([
    load(MODEL_DIR + CHARACTER),
    ...keys.map(k => load(ANIM_DIR + ANIMS[k]).catch(err => {
      console.warn('Animation manquante :', ANIMS[k], err);
      return null;
    })),
  ]).then(([base, ...animFbx]) => {
    // Échelle : hauteur du modèle (en cm chez Mixamo) -> ~1,83 m
    const box = new THREE.Box3().setFromObject(base);
    const scale = 1.83 / (box.max.y - box.min.y);
    base.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const clips = {};
    keys.forEach((k, i) => {
      const f = animFbx[i];
      if (f && f.animations.length) clips[k] = prepClip(f.animations[0], k);
    });
    // Le clip Mixamo du tacle glissé ne se contente pas de plonger : il finit
    // par un relevé complet (le joueur se redresse debout en ~1,8 s). Joué en
    // entier puis accéléré pour tenir dans la fenêtre serveur (~0,5 s), on
    // voyait donc le joueur plonger PUIS se relever à toute vitesse, ce qui
    // ressemblait à une roulade. On coupe le clip juste après le point bas
    // (le joueur couché au sol) pour que clampWhenFinished fige cette pose
    // au lieu de la pose relevée de fin de clip.
    if (clips.slide) clips.slide = THREE.AnimationUtils.subclip(clips.slide, 'slide', 0, 0.9, 1);
    // Même souci pour le tacle DEBOUT : le clip complet enchaîne pique du pied
    // (le joueur reste sur ses appuis, ~0,75 s) PUIS plonge au sol comme un
    // tacle glissé. Joué en entier et accéléré ~5,5× pour tenir dans la
    // fenêtre serveur (0,35 s), le geste était coupé en pleine chute — trop
    // bref et trop rapide pour être perçu. On ne garde que la phase debout.
    if (clips.standTackle) clips.standTackle = THREE.AnimationUtils.subclip(clips.standTackle, 'standTackle', 0, 0.75, 1);
    return { base, clips, scale };
  }).catch(err => {
    console.warn('Personnage FBX indisponible, joueurs procéduraux en repli :', err);
    return null;
  });
  return _charPromise;
}

// Prépare un clip Mixamo : nom stable + suppression du déplacement horizontal
// du bassin (le serveur déplace déjà le joueur ; on garde le Y pour les sauts).
function prepClip(clip, name) {
  clip.name = name;
  const t = clip.tracks.find(tr => /Hips\.position$/i.test(tr.name))
    || clip.tracks.find(tr => tr.name.endsWith('.position'));
  if (t) {
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
  return clip;
}

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.players = new Map();   // pid -> { root, body, ring, parts, phase, last }
    this.clock = new THREE.Clock();
    this._camTarget = new THREE.Vector3(0, 1, 0);
    this._camPos = new THREE.Vector3(0, 6, 14);
    // Orbite manuelle de la caméra 3e personne (glissé sur le terrain) :
    // camYaw = décalage d'angle autour du joueur, camYawActive = doigt posé.
    this.camYaw = 0;
    this.camYawActive = false;
    // Vecteurs scratch réutilisés chaque frame (voir update()/_updateCamera) :
    // éviter d'allouer des THREE.Vector3 à 60 Hz supprime les saccades GC.
    this._ballNow = new THREE.Vector3();
    this._vMoved = new THREE.Vector3();
    this._vAxis = new THREE.Vector3();
    this._vPos = new THREE.Vector3();
    this._desiredPos = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._controlled = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), team: null };
    this._initRenderer();
    this._initScene();
    this._buildStadium();
    this._buildBall();
    this._buildAimArrow();
    this._loadCharacter();
    this.resize();
  }

  // --------------------------------------------------------------------------
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    // Sur écran haute densité (téléphones), plafonner le pixelRatio à 1.5 divise
    // le nombre de pixels à calculer par ~1,8 vs 2.0 — c'est le plus gros levier
    // fps sur mobile, pour une différence de netteté quasi imperceptible.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    // PCFShadowMap (au lieu de PCFSoftShadowMap) : ombres à peine moins douces
    // mais nettement moins coûteuses à chaque frame.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
      new THREE.SphereGeometry(BALL_R, 20, 16),
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
  // Flèche de visée : indique, au sol depuis les pieds du joueur contrôlé, la
  // direction du regard = là où la balle sera envoyée (passe / tir). Posée à
  // plat, pointe vers +Z en local ; on l'oriente ensuite via rotation.y.
  // --------------------------------------------------------------------------
  _buildAimArrow() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd23f, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    });
    // Hampe (rectangle plat)
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 1.4), mat);
    shaft.rotation.x = -Math.PI / 2; shaft.position.set(0, 0.02, 1.35);
    g.add(shaft);
    // Pointe (triangle plat, tip vers +Z)
    const shape = new THREE.Shape();
    shape.moveTo(-0.34, 0); shape.lineTo(0.34, 0); shape.lineTo(0, 0.6); shape.closePath();
    const head = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    head.rotation.x = Math.PI / 2; head.position.set(0, 0.02, 2.05);
    g.add(head);
    g.visible = false;
    g.renderOrder = 2;
    this.aimArrow = g;
    this.scene.add(g);
  }

  // --------------------------------------------------------------------------
  // Personnage Mixamo (FBX) : modèle riggé Ch38 + animations du Soccer Game
  // Pack. Chargé en arrière-plan ; en attendant (ou en cas d'échec), les
  // joueurs procéduraux plus bas servent de repli.
  // --------------------------------------------------------------------------
  _loadCharacter() {
    preloadCharacter().then(assets => {
      if (!assets) return;                 // échec -> repli procédural
      this.charBase = assets.base;
      this.charClips = assets.clips;
      this.charScale = assets.scale;
      // Remplace les joueurs procéduraux déjà en scène : ils seront recréés
      // avec le modèle FBX au prochain update().
      for (const e of this.players.values()) this.scene.remove(e.root);
      this.players.clear();
    });
  }

  _makeFbxPlayer(team, isGK) {
    const jColor = isGK ? GK_JERSEY[team] : JERSEY[team];
    const model = SkeletonUtils.clone(this.charBase);
    model.scale.setScalar(this.charScale);
    // Maillot + chaussettes aux couleurs du club. Les meshes du personnage
    // (Ch38_Shirt, Ch38_Socks, Ch38_Shorts…) partagent UN matériau atlas :
    // on clone donc le matériau par mesh et on choisit selon le NOM DU MESH.
    // Pour le maillot on retire la texture diffuse (couleur unie franche,
    // les deux équipes doivent être discernables au premier coup d'œil).
    model.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.frustumCulled = false;
      if (!/shirt|sock/i.test(o.name)) return;
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => {
        const c = m.clone();
        c.map = null;
        c.color.setHex(jColor);
        return c;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });

    const root = new THREE.Group();
    root.add(model);

    // Anneau discret aux couleurs de l'équipe (lisibilité des deux camps,
    // les deux équipes partageant le même modèle) + anneau de contrôle.
    const teamRing = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 24),
      new THREE.MeshBasicMaterial({ color: jColor, transparent: true, opacity: 0.55, depthWrite: false })
    );
    teamRing.rotation.x = -Math.PI / 2; teamRing.position.y = 0.025;
    root.add(teamRing);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.055, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd23f })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
    root.add(ring);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const k in this.charClips) {
      const a = mixer.clipAction(this.charClips[k]);
      if (k === 'kick' || k === 'volley' || k === 'slide' || k === 'standTackle' || k === 'dive') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;        // fige la pose finale tant que l'état dure
      }
      actions[k] = a;
    }

    this.scene.add(root);
    return {
      root, ring, mixer, actions, isGK,
      cur: null, curName: '', oneT: 0,
      last: new THREE.Vector3(), yaw: 0, wasKa: false, wasVo: false,
    };
  }

  // Fondu enchaîné vers une animation (restart : relit le clip depuis le début)
  _fadeTo(e, name, dur = 0.22, restart = false) {
    const a = e.actions[name];
    if (!a) return false;
    if (e.curName === name && !restart) return true;
    if (e.cur && e.cur !== a) e.cur.fadeOut(dur);
    a.reset().fadeIn(dur).play();
    e.cur = a; e.curName = name;
    return true;
  }

  // Machine à états : gestes serveur (frappe, retournée, tacle, plongeon)
  // prioritaires, sinon locomotion course/idle pilotée par la vitesse réelle.
  _animateFbx(e, p, dt, speed, run) {
    if (p.ka && !e.wasKa && e.actions.kick) {
      this._fadeTo(e, 'kick', 0.08, true);
      e.oneT = this.charClips.kick.duration - 0.15;
    }
    e.wasKa = !!p.ka;
    if (p.vo && !e.wasVo) {
      const k = e.actions.volley ? 'volley' : 'kick';
      if (this._fadeTo(e, k, 0.08, true)) e.oneT = this.charClips[k].duration - 0.15;
    }
    e.wasVo = !!p.vo;

    if (p.sl && e.actions.slide) {
      // Le clip (déjà rogné à la phase de plongeon, voir preloadCharacter)
      // doit se DÉROULER ENTIER pendant la fenêtre serveur du tacle glissé
      // (0,55 s, cf. p.slideT côté serveur) pour que clampWhenFinished fige
      // le joueur couché au sol au lieu de l'interrompre en pleine chute.
      if (this._fadeTo(e, 'slide', 0.1)) {
        e.actions.slide.timeScale = this.charClips.slide.duration / 0.55;
      }
    } else if (p.stk && e.actions.standTackle) {
      // Idem pour le tacle debout : fenêtre serveur de 0,35 s (cf. p.standT).
      if (this._fadeTo(e, 'standTackle', 0.08)) {
        e.actions.standTackle.timeScale = this.charClips.standTackle.duration / 0.35;
      }
    } else if (p.dv && e.actions.dive) {
      this._fadeTo(e, 'dive', 0.1);
    } else if (e.oneT > 0) {
      e.oneT -= dt;                        // laisse la frappe/retournée se finir
    } else if (run > 0.12) {
      if (this._fadeTo(e, 'run', 0.25)) {
        // Vitesse de déplacement réelle -> vitesse de la foulée
        e.actions.run.timeScale = Math.min(1.9, Math.max(0.7, speed / 5.5));
      }
    } else {
      this._fadeTo(e, e.isGK ? 'gkIdle' : 'idle', 0.3);
    }
    e.mixer.update(dt);
  }

  // --------------------------------------------------------------------------
  // Joueur humanoïde procédural (REPLI si le FBX n'est pas chargé) : membres en
  // 2 segments (genoux/coudes), visage, variations de peau/cheveux par joueur.
  // Matériaux et géométries partagés entre joueurs via des caches.
  // --------------------------------------------------------------------------
  _stdMat(color, roughness) {
    this._matCache = this._matCache || new Map();
    const k = color + ':' + roughness;
    if (!this._matCache.has(k)) {
      this._matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness }));
    }
    return this._matCache.get(k);
  }

  _geo(key, make) {
    this._geoCache = this._geoCache || new Map();
    if (!this._geoCache.has(key)) this._geoCache.set(key, make());
    return this._geoCache.get(key);
  }

  _capGeo(r, l) {
    return this._geo('cap' + r + ':' + l, () => new THREE.CapsuleGeometry(r, l, 5, 12));
  }

  // Maillot : couleur de base + ombrage de volume + bandes latérales claires
  _jerseyMat(color) {
    this._jerseyCache = this._jerseyCache || new Map();
    if (!this._jerseyCache.has(color)) {
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#' + color.toString(16).padStart(6, '0');
      g.fillRect(0, 0, 128, 128);
      const grad = g.createLinearGradient(0, 0, 128, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0.30)');
      grad.addColorStop(0.25, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.10)');
      grad.addColorStop(0.75, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.30)');
      g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(16, 0, 5, 128); g.fillRect(107, 0, 5, 128);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      this._jerseyCache.set(color, new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
    }
    return this._jerseyCache.get(color);
  }

  _makePlayer(team, isGK, label) {
    const jColor = isGK ? GK_JERSEY[team] : JERSEY[team];
    // Variation déterministe par joueur : teinte de peau, cheveux, coiffure
    let seed = 0;
    const str = team + (isGK ? 'G' : '') + label;
    for (let i = 0; i < str.length; i++) seed = (seed * 131 + str.charCodeAt(i)) >>> 0;
    const skin = this._stdMat(SKIN_TONES[seed % SKIN_TONES.length], 0.65);
    const hairMat = this._stdMat(HAIR_COLORS[(seed >> 3) % HAIR_COLORS.length], 0.9);
    const hairStyle = (seed >> 7) % 3;

    const jersey = this._jerseyMat(jColor);
    const shortMat = this._stdMat(0xffffff, 0.75);
    const sockMat = this._stdMat(jColor, 0.8);
    const shoeMat = this._stdMat(0x111116, 0.45);
    const gloveMat = this._stdMat(0xf2f2f2, 0.6);

    const root = new THREE.Group();          // position + orientation (facing)
    const body = new THREE.Group();          // inclinaison (plongeon) + rebond
    root.add(body);

    const mk = (geo, mat, x, y, z, parent = body) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
    };

    // Torse légèrement aplati (poitrine) + épaules + short + col
    const torso = mk(this._capGeo(0.26, 0.36), jersey, 0, 1.26, 0);
    torso.scale.set(1.04, 1, 0.8);
    const shoulders = mk(this._capGeo(0.115, 0.4), jersey, 0, 1.52, 0);
    shoulders.rotation.z = Math.PI / 2;
    const shorts = mk(this._capGeo(0.235, 0.16), shortMat, 0, 0.97, 0);
    shorts.scale.set(1.05, 1, 0.85);
    const collar = mk(this._geo('collar', () => new THREE.TorusGeometry(0.085, 0.024, 6, 16)),
      shortMat, 0, 1.63, 0);
    collar.rotation.x = Math.PI / 2;
    mk(this._geo('neck', () => new THREE.CylinderGeometry(0.07, 0.08, 0.12, 10)), skin, 0, 1.63, 0);

    // Tête : crâne légèrement ovale, oreilles, yeux, sourcils, bouche
    const head = mk(this._geo('head', () => new THREE.SphereGeometry(0.16, 18, 14)), skin, 0, 1.8, 0);
    head.scale.set(0.95, 1.05, 0.98);
    for (const s of [-1, 1]) {
      const ear = mk(this._geo('ear', () => new THREE.SphereGeometry(0.032, 8, 8)), skin, s * 0.15, 1.79, 0);
      ear.scale.set(0.6, 1, 0.8); ear.castShadow = false;
      const eye = mk(this._geo('eye', () => new THREE.SphereGeometry(0.021, 8, 8)),
        this._stdMat(0x14100c, 0.35), s * 0.058, 1.815, 0.152);
      eye.castShadow = false;
      const brow = mk(this._geo('brow', () => new THREE.BoxGeometry(0.052, 0.013, 0.02)),
        hairMat, s * 0.058, 1.857, 0.142);
      brow.rotation.z = s * -0.15; brow.castShadow = false;
    }
    const mouth = mk(this._geo('mouth', () => new THREE.BoxGeometry(0.05, 0.013, 0.018)),
      this._stdMat(0x7c4a3a, 0.7), 0, 1.732, 0.148);
    mouth.castShadow = false;

    // Coiffure : 0 = classique, 1 = rasée courte, 2 = mi-longue (couvre la nuque)
    if (hairStyle === 0) {
      mk(this._geo('hair0', () => new THREE.SphereGeometry(0.169, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55)),
        hairMat, 0, 1.8, 0);
    } else if (hairStyle === 1) {
      mk(this._geo('hair1', () => new THREE.SphereGeometry(0.164, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.42)),
        hairMat, 0, 1.81, 0);
    } else {
      const h = mk(this._geo('hair2', () => new THREE.SphereGeometry(0.172, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.66)),
        hairMat, 0, 1.8, 0);
      h.rotation.x = -0.3;                    // dégage le front, couvre la nuque
    }

    // Numéro dans le dos
    if (label) {
      const numTex = new THREE.CanvasTexture(this._numberCanvas(label));
      const num = new THREE.Mesh(
        new THREE.PlaneGeometry(0.3, 0.3),
        new THREE.MeshBasicMaterial({ map: numTex, transparent: true })
      );
      num.position.set(0, 1.28, -0.23); num.rotation.y = Math.PI; body.add(num);
    }

    // Jambe articulée : pivot hanche (cuisse) + pivot genou (mollet/chaussette + crampon)
    const leg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.13, 0.96, 0);
      body.add(hip);
      mk(this._capGeo(0.105, 0.26), skin, 0, -0.21, 0, hip);
      const knee = new THREE.Group();
      knee.position.y = -0.44; hip.add(knee);
      mk(this._capGeo(0.085, 0.26), sockMat, 0, -0.2, 0, knee);
      mk(this._geo('shoe', () => new THREE.BoxGeometry(0.15, 0.09, 0.29)), shoeMat, 0, -0.44, 0.07, knee);
      return { hip, knee };
    };
    // Bras articulé : pivot épaule (manche + bras) + pivot coude (avant-bras + main)
    const arm = (side) => {
      const sho = new THREE.Group();
      sho.position.set(side * 0.35, 1.53, 0);
      sho.rotation.z = side * 0.14;           // bras légèrement écartés du corps
      body.add(sho);
      mk(this._capGeo(0.078, 0.14), jersey, 0, -0.1, 0, sho);
      mk(this._capGeo(0.06, 0.1), skin, 0, -0.27, 0, sho);
      const elbow = new THREE.Group();
      elbow.position.y = -0.36; sho.add(elbow);
      mk(this._capGeo(0.052, 0.14), skin, 0, -0.11, 0, elbow);
      mk(this._geo('hand', () => new THREE.SphereGeometry(0.058, 10, 8)),
        isGK ? gloveMat : skin, 0, -0.24, 0, elbow);
      return { sho, elbow };
    };
    const lL = leg(-1), lR = leg(1);
    const aL = arm(-1), aR = arm(1);

    // Anneau au sol (indicateur de contrôle)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.055, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd23f })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
    root.add(ring);

    this.scene.add(root);
    return {
      root, body, ring,
      parts: {
        legL: lL.hip, legR: lR.hip, armL: aL.sho, armR: aR.sho,
        kneeL: lL.knee, kneeR: lR.knee, elbowL: aL.elbow, elbowR: aR.elbow,
      },
      phase: Math.random() * 6, last: new THREE.Vector3(), lean: 0, yaw: 0,
      kickT: 0, voT: 0, slideAmt: 0, standT: 0, wasKa: false, wasVo: false, wasStk: false,
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
    const bx = sx(state.ball.x), bz = sz(state.ball.y), by = BALL_R + (state.ball.z || 0) * SC;
    const nb = this._ballNow.set(bx, by, bz);
    this._vMoved.copy(nb).sub(this._ballPrev);
    const mvx = this._vMoved.x, mvz = this._vMoved.z;
    this.ball.position.copy(nb);
    // Roulement du ballon
    const md = Math.hypot(mvx, mvz);
    if (md > 0.001) {
      this._vAxis.set(mvz, 0, -mvx).normalize();
      this.ball.rotateOnWorldAxis(this._vAxis, md / BALL_R);
    }
    this._ballPrev.copy(nb);

    // Joueurs
    let controlled = null;
    for (const p of state.players) {
      let e = this.players.get(p.i);
      if (!e) {
        e = this.charBase
          ? this._makeFbxPlayer(p.t, p.gk)
          : this._makePlayer(p.t, p.gk, p.gk ? '1' : p.id);
        this.players.set(p.i, e);
      }
      e.team = p.t;                        // pour la sélection au tap (pick)
      // Joueur expulsé : masqué (il a quitté le terrain)
      e.root.visible = !p.off;
      if (p.off) continue;
      const px = sx(p.x), pz = sz(p.y);
      const pos = this._vPos.set(px, 0, pz);

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

      if (e.mixer) {
        // Personnage FBX : animations Mixamo pilotées par l'état serveur
        this._animateFbx(e, p, dt, speed, run);
      } else {
        // Repli procédural : pose calculée à la main
        e.phase += step * 4.2 + run * dt * 3;

        // -- Détection des actions serveur (front montant -> anim locale) --
        if (p.ka && !e.wasKa) e.kickT = 0.32;
        e.wasKa = !!p.ka;
        if (p.vo && !e.wasVo) e.voT = 0.85;
        e.wasVo = !!p.vo;
        if (p.stk && !e.wasStk) e.standT = 0.35;
        e.wasStk = !!p.stk;
        if (e.kickT > 0) e.kickT -= dt;
        if (e.voT > 0) e.voT -= dt;
        if (e.standT > 0) e.standT -= dt;
        e.slideAmt += ((p.sl ? 1 : 0) - e.slideAmt) * Math.min(1, dt * 10);
        const targetLean = p.dv ? 1.25 : 0;
        e.lean += (targetLean - e.lean) * Math.min(1, dt * 12);

        // Pose de base : balancier de course (hanches/épaules) + genoux/coudes
        const swing = (0.35 + 0.75 * run) * Math.min(1, run * 3);
        const s = Math.sin(e.phase);
        let legL = s * swing, legR = -s * swing;
        let armL = -s * swing * 0.7, armR = s * swing * 0.7;
        // Genoux : flexion maximale pendant le retour de la jambe (mi-cycle),
        // jambe quasi tendue au moment de l'appui.
        const rec = Math.sin(e.phase - 0.9);
        let kneeL = 0.1 + run * (0.25 + 1.15 * Math.max(0, rec));
        let kneeR = 0.1 + run * (0.25 + 1.15 * Math.max(0, -rec));
        // Coudes : bras fléchis à ~90° en pleine course, relâchés à l'arrêt
        let elbowL = 0.45 + run * 0.85, elbowR = elbowL;
        let bodyRotX = e.lean;                                      // plongeon GK
        let bodyY = Math.abs(s) * 0.06 * run - e.lean * 0.35;

        if (e.voT > 0) {
          // RETOURNÉE ACROBATIQUE : saut + rotation arrière complète, jambe fouettée
          const u = 1 - e.voT / 0.85;
          bodyY = Math.sin(u * Math.PI) * 1.05;
          bodyRotX = -u * Math.PI * 2;
          legR = -1.7 * Math.sin(u * Math.PI);
          legL = 0.5 * Math.sin(u * Math.PI);
          armL = 1.2; armR = -1.2;
          kneeR = 0.12;                               // jambe de frappe tendue
          kneeL = 0.9 * Math.sin(u * Math.PI);
          elbowL = elbowR = 0.2;                      // bras ouverts en balancier
        } else if (e.slideAmt > 0.03) {
          // TACLE GLISSÉ : corps couché en arrière au ras du sol, jambe tendue
          const a = e.slideAmt;
          bodyRotX = -1.05 * a + e.lean;
          bodyY = -0.52 * a;
          legR = -1.5 * a;
          legL = -0.8 * a;
          armL = 0.9 * a; armR = -0.4 * a;
          kneeR = 0.06;                               // jambe tendue vers le ballon
          kneeL = 1.25 * a;                           // jambe d'appui repliée dessous
          elbowL = elbowR = 0.3;
        } else if (e.standT > 0) {
          // TACLE DEBOUT : pique du pied avant, buste penché, joueur reste sur ses appuis
          const u = 1 - e.standT / 0.35;
          const poke = Math.sin(u * Math.PI);         // le pied sort puis revient
          bodyRotX = 0.35 * poke + e.lean;            // léger plongée du buste vers l'avant
          legR = 0.85 * poke;                         // jambe tendue vers le ballon
          legL = -0.15 * poke;
          kneeR = 0.1;                                // pointe de pied tendue
          kneeL = 0.35 * poke;
          armL = 0.5 * poke; armR = -0.5 * poke;      // bras qui contrebalancent
          elbowL = elbowR = 0.5;
        } else if (e.kickT > 0) {
          // FRAPPE : jambe armée en arrière (genou plié) puis fouettée, tendue à l'impact
          const u = 1 - e.kickT / 0.32;
          legR = u < 0.3 ? (u / 0.3) * 0.9 : 0.9 - ((u - 0.3) / 0.7) * 2.6;
          armL = -0.6; armR = 0.4;
          kneeR = u < 0.3 ? (u / 0.3) * 1.25 : Math.max(0.06, 1.25 * (1 - (u - 0.3) / 0.45));
        }

        e.parts.legL.rotation.x = legL;
        e.parts.legR.rotation.x = legR;
        e.parts.armL.rotation.x = armL;
        e.parts.armR.rotation.x = armR;
        e.parts.kneeL.rotation.x = kneeL;
        e.parts.kneeR.rotation.x = kneeR;
        e.parts.elbowL.rotation.x = -elbowL;
        e.parts.elbowR.rotation.x = -elbowR;
        e.body.rotation.x = bodyRotX;
        e.body.position.y = bodyY;
      }

      e.root.position.copy(pos);
      e.last.copy(pos);

      // Anneau de contrôle : jaune = moi, blanc = autre humain de mon équipe
      const isMine = p.c === ctx.mySocket;
      const isHumanMate = p.c && p.t === ctx.myTeam && !isMine;
      e.ring.visible = isMine || isHumanMate;
      if (e.ring.visible) e.ring.material.color.setHex(isMine ? 0xffd23f : 0xffffff);
      if (isMine) {
        // On copie (pas de référence) : _vPos est réutilisé par les joueurs suivants.
        this._controlled.pos.copy(pos);
        this._controlled.dir.set(dx, 0, dz);
        this._controlled.team = p.t;
        controlled = this._controlled;
      }

      // Flash (refus de contrôle) : teinte rouge éphémère de l'anneau
      if (p.fl && !e.ring.visible) { e.ring.visible = true; e.ring.material.color.setHex(0xff3030); }
    }

    this._updateCamera(controlled, state, dt, ctx.aim, ctx.corner);
    this._updateAimArrow(controlled, ctx.aim, ctx.shotArrow);
    this.render();
  }

  // Oriente la flèche sous le joueur contrôlé dans la direction de la VISÉE =
  // la direction de la vue (caméra), pas le déplacement. On peut ainsi avancer
  // tout droit et viser/passer sur le côté en tournant la vue. En remise en jeu
  // figée (aim != null), elle suit l'angle de visée choisi au joystick.
  _updateAimArrow(controlled, aim, shotArrow) {
    if (!this.aimArrow) return;
    if (!controlled) { this.aimArrow.visible = false; return; }
    let dirX, dirZ;
    // Frappe chronométrée : la flèche suit le BALAYAGE (l'angle de tir), pas la caméra
    const ang = shotArrow != null ? shotArrow : aim;
    if (ang != null) {
      dirX = Math.cos(ang); dirZ = Math.sin(ang);          // monde -> scène (X,Z)
    } else {
      this.camera.updateMatrixWorld();
      const b = this.cameraBasis();                        // avant caméra projeté au sol
      dirX = b.fwd.x; dirZ = b.fwd.z;
    }
    this.aimArrow.visible = true;
    this.aimArrow.position.set(controlled.pos.x, 0, controlled.pos.z);
    this.aimArrow.rotation.y = Math.atan2(dirX, dirZ);
  }

  _updateCamera(controlled, state, dt, aim, corner) {
    // Vecteurs scratch réutilisés : chaque branche les fixe entièrement via .set().
    const desiredPos = this._desiredPos, lookAt = this._lookAt;
    if (corner && aim == null) {
      // VUE DE CORNER : caméra placée derrière le but attaqué, en hauteur, qui
      // cadre toute la surface. Lisible aussi bien en défense (on voit les
      // attaquants et le centre arriver) qu'en attaque (on vise le point de
      // chute). Le tireur, lui (aim != null), garde sa vue de visée.
      // La tribune derrière la cage (mur gris, cf. _buildStands) commence à
      // M + standD/2 = 11 unités au-delà de la ligne de but : au-delà, la
      // caméra se retrouve dans son emprise et le mur bouche la vue. On reste
      // donc bien en-deçà (8) et on monte plus haut pour garder tout le
      // rectangle des 16,50 m dans le cadre malgré le recul réduit.
      const b = this.ball.position;
      const side = b.x < 0 ? -1 : 1;               // but attaqué : -HW ou +HW
      const goalX = side * HW;
      desiredPos.set(goalX + side * 8, 16, b.z * 0.5);
      lookAt.set(goalX - side * 14, 1, b.z * 0.15);
    } else if (controlled && aim != null) {
      // MODE VISÉE (remise en jeu figée) : caméra orbitale derrière le tireur,
      // pilotée par le joystick — on balaye le terrain pour choisir sa passe.
      const p = controlled.pos;
      const dx = Math.cos(aim), dz = Math.sin(aim);   // monde (x,y) -> scène (X,Z)
      desiredPos.set(p.x - dx * 8.5, 4.6, p.z - dz * 8.5);
      lookAt.set(p.x + dx * 14, 0.8, p.z + dz * 14);
    } else if (controlled) {
      // Caméra 3e personne STABLE qui cadre TOUJOURS le joueur ET le ballon.
      // Son ORIENTATION dépend de la possession :
      //  · en ATTAQUE (mon équipe a le ballon) → orientée vers le but adverse ;
      //  · en DÉFENSE (je n'ai pas le ballon) → calée derrière le joueur dans
      //    l'axe joueur→ballon, pour que le ballon soit cadré DEVANT et qu'on
      //    dirige son joueur vers lui en le voyant.
      const atk = controlled.team === 'A' ? 1 : -1;    // sens d'attaque en X scène
      const p = controlled.pos;
      const b = this.ball.position;

      // Mon équipe a-t-elle le ballon ? (détenu par moi ou un coéquipier)
      let ownerTeam = null;
      if (state.ball.owner != null) {
        const op = state.players.find(pp => pp.i === state.ball.owner);
        ownerTeam = op ? op.t : null;
      }
      const inPossession = ownerTeam === controlled.team;

      if (inPossession) {
        // ATTAQUE : la caméra VISE LE BALLON et recule derrière le plus en
        // retrait du joueur et du ballon pour garder les deux dans le cadre.
        const rearX = atk === 1 ? Math.min(p.x, b.x) : Math.max(p.x, b.x);
        const spread = Math.min(45, Math.hypot(p.x - b.x, p.z - b.z));
        const dist = 9 + spread * 0.55;
        const height = 5.4 + spread * 0.4;
        const midZ = b.z * 0.6 + p.z * 0.4;
        desiredPos.set(rearX - atk * dist, height, midZ * 0.9);
        lookAt.set(b.x * 0.7 + p.x * 0.3, 0.5, b.z * 0.7 + p.z * 0.3);
      } else {
        // DÉFENSE : caméra derrière le joueur contrôlé, dans l'axe qui pointe
        // vers le ballon → le ballon reste cadré devant. Comme le joystick est
        // relatif à la vue, pousser vers l'avant dirige le joueur vers le ballon.
        let ax = b.x - p.x, az = b.z - p.z;
        const spread = Math.hypot(ax, az);
        if (spread > 1.5) { ax /= spread; az /= spread; }   // axe joueur→ballon
        else { ax = atk; az = 0; }                          // ballon collé : axe d'attaque
        const s = Math.min(45, spread);
        const dist = 9 + s * 0.5;
        const height = 5.4 + s * 0.38;
        desiredPos.set(p.x - ax * dist, height, p.z - az * dist);
        lookAt.set(p.x * 0.4 + b.x * 0.6, 0.5, p.z * 0.4 + b.z * 0.6);
      }

      // Orbite manuelle : on fait pivoter la position de la caméra autour du
      // point visé, ce qui permet de tourner la vue pour viser une passe dans
      // n'importe quelle direction (les passes sont relatives à la caméra).
      if (this.camYaw) {
        const ox = desiredPos.x - lookAt.x, oz = desiredPos.z - lookAt.z;
        const c = Math.cos(this.camYaw), sn = Math.sin(this.camYaw);
        desiredPos.x = lookAt.x + ox * c - oz * sn;
        desiredPos.z = lookAt.z + ox * sn + oz * c;
      }
      // Recentrage doux de l'orbite manuelle quand on ne tourne pas.
      if (!this.camYawActive) this.camYaw *= Math.exp(-dt * 0.7);
    } else {
      // Caméra de retransmission : suit le ballon en diagonale
      const b = this.ball.position;
      desiredPos.set(b.x - 6, 16, b.z - 22);
      lookAt.set(b.x, 0, b.z + 4);
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

  // Sélection d'un joueur au tap -> pid ou null.
  // 1) Raycast précis sur le corps du joueur (cas idéal).
  // 2) Repli tolérant : si le tap ne touche aucun joueur (fréquent sur mobile
  //    quand on vise un défenseur au loin), on choisit le joueur dont le torse
  //    projeté à l'écran est le plus proche du point tapé, dans un rayon donné.
  // team (optionnel) : restreint le repli tolérant aux joueurs de cette équipe,
  // pour qu'un tap approximatif prenne toujours TON défenseur le plus proche
  // plutôt qu'un adversaire (qui serait de toute façon refusé côté serveur).
  pick(clientX, clientY, team = null) {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const ndc = new THREE.Vector2(
      (px / rect.width) * 2 - 1,
      -(py / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const roots = [];
    for (const [pid, e] of this.players) { e.root.userData.pid = pid; roots.push(e.root); }
    const hits = ray.intersectObjects(roots, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && o.userData.pid === undefined) o = o.parent;
      if (o) return o.userData.pid;
    }
    // Repli : joueur le plus proche à l'écran (rayon de tolérance en px CSS).
    const TOL = 48;
    const v = new THREE.Vector3();
    let bestPid = null, bestD = TOL * TOL;
    for (const [pid, e] of this.players) {
      if (!e.root.visible) continue;               // expulsé / masqué
      if (team && e.team !== team) continue;       // repli limité à ton équipe
      v.copy(e.root.position); v.y += 1;           // ~torse, plus stable que les pieds
      v.project(this.camera);
      if (v.z > 1) continue;                        // derrière la caméra
      const ex = (v.x * 0.5 + 0.5) * rect.width;
      const ey = (-v.y * 0.5 + 0.5) * rect.height;
      const d = (ex - px) * (ex - px) + (ey - py) * (ey - py);
      if (d < bestD) { bestD = d; bestPid = pid; }
    }
    return bestPid;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

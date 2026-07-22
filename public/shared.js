/*
 * shared.js — Constantes et helpers partagés entre le serveur et le client.
 * Fichier UMD : utilisable via require() côté Node et via <script> côté navigateur.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod; // Node / serveur
  } else {
    root.SHARED = mod; // Navigateur -> window.SHARED
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Dimensions du terrain (unités "monde" ~ décimètres, terrain 105m x 68m)
  // Repère : X = longueur (0 = but gauche, FIELD.W = but droit), Y = largeur.
  // ---------------------------------------------------------------------------
  const FIELD = {
    W: 1050,
    H: 680,
    MARGIN: 60,            // marge autour du terrain (zone de sortie / décor)
    GOAL_WIDTH: 146,       // largeur de la cage (entre poteaux)
    GOAL_DEPTH: 40,        // profondeur visuelle de la cage
    PENALTY_W: 165,        // profondeur de la surface de réparation
    PENALTY_H: 403,        // largeur de la surface
    GOALAREA_W: 55,        // profondeur des 6 mètres
    GOALAREA_H: 183,
    CENTER_R: 91,          // rayon du rond central
    CORNER_R: 10,
  };
  FIELD.GOAL_Y1 = FIELD.H / 2 - FIELD.GOAL_WIDTH / 2;
  FIELD.GOAL_Y2 = FIELD.H / 2 + FIELD.GOAL_WIDTH / 2;

  // ---------------------------------------------------------------------------
  // Physique
  // ---------------------------------------------------------------------------
  const PHYS = {
    TICK_HZ: 30,                 // fréquence de simulation & broadcast
    PLAYER_RADIUS: 14,           // rayon "gameplay" (limites terrain, sélection)
    BODY_RADIUS: 5,              // rayon de collision corps-à-corps (contact rapproché)
    PLAYER_SPEED: 132,           // unités/seconde (ralenti pour un jeu plus posé)
    SPRINT_MULT: 1.4,
    GK_SPEED: 108,
    BALL_RADIUS: 7,
    BALL_FRICTION: 0.72,         // friction au sol (par seconde, exponentielle)
    BALL_AIR_FRICTION: 0.4,
    WALL_RESTITUTION: 0.55,      // rebond sur les bords hors-jeu (décor)
    POST_RESTITUTION: 0.7,
    POSSESS_RADIUS: 24,          // distance de prise de balle
    POSSESS_COOLDOWN: 0.35,      // délai avant qu'un joueur puisse reprendre après un tir
    CAPTURE_MAX_SPEED: 480,      // au-delà, un joueur de champ dévie au lieu de contrôler
    KICK_OFFSET: 16,             // le ballon est posé devant le joueur porteur
    MAX_SHOT_POWER: 720,
    MIN_SHOT_POWER: 260,
    PASS_POWER: 430,
    LONG_PASS_POWER: 620,
    CROSS_POWER: 540,
    HEADER_POWER: 480,
    TACKLE_RANGE: 40,
    TACKLE_COOLDOWN: 1.2,
    TACKLE_FOUL_CHANCE: 0.15,
    DIVE_COOLDOWN: 1.4,
    DIVE_RANGE: 90,
    DIVE_SPEED: 340,
    SPRINT_MAX: 100,             // jauge de sprint
    SPRINT_DRAIN: 34,            // par seconde
    SPRINT_REGEN: 18,
  };

  // Hauteur (z) : le ballon peut être aérien (centres, passes lobées, dégagements)
  const AIR = {
    GRAVITY: 900,                // unités/s^2 sur l'axe z
  };

  // ---------------------------------------------------------------------------
  // Formats de match : tous les matchs se jouent à 8 vs 8 sur le terrain
  // (gardien + 7 joueurs de champ). Les postes sans humain sont tenus par l'IA.
  // Le format ne détermine que le type d'adversaire.
  // ---------------------------------------------------------------------------
  const FORMATS = {
    '1v1-ai': { vsAI: true, label: 'Solo / Coop vs IA (8v8)' },
    'multi':  { vsAI: false, label: 'Multijoueur — 2 équipes (8v8)' },
  };

  const DIFFICULTY = {
    easy:   { reaction: 0.55, speed: 0.82, error: 0.35, label: 'Facile' },
    medium: { reaction: 0.32, speed: 0.94, error: 0.20, label: 'Moyen' },
    hard:   { reaction: 0.16, speed: 1.05, error: 0.08, label: 'Difficile' },
  };

  const MATCH = {
    DURATION: 300,        // durée d'une mi-temps en secondes (temps de jeu)
    HALVES: 2,
    ROSTER_FIELD: 8,      // 8 joueurs de champ dans l'effectif
  };

  // ---------------------------------------------------------------------------
  // Helpers mathématiques (partagés)
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }
  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function norm(x, y) { const l = len(x, y) || 1; return { x: x / l, y: y / l }; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function angleLerp(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  return {
    FIELD, PHYS, AIR, FORMATS, DIFFICULTY, MATCH,
    clamp, dist2, dist, len, norm, lerp, angleLerp,
  };
});

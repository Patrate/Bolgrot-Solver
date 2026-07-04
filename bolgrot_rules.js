/* bolgrot_rules.js — Règles de simulation + timeline glyphes + scoring T6 virtuel + Next Kill Seeker.
   V43-C : attraction dynamique, avec priorité aux seuls feux repoussés. */

/* bolgrot_rules_v38b_1.js — V38B.1 architecture multi-fichiers. */



/* ============================================================================
   BOLGROT SOLVER — port JS (Web Worker + module Node pour validation).
   Modèle de simulation V20-C : attraction séquentielle dynamique, ordre dépendant
   de l'action ; après une poussée, les feux repoussés sont traités avant les
   autres, tout en gardant destinations et coins diagonaux dynamiques.
   Correctif V5.3 : le joueur est aussi un bloqueur latéral de diagonale.
   "feux" = ennemis. État canonique de départ : tour 7, 39 PV, 10 PA,
   0 bond double utilisé, 36 feux, joueur 15/15, bolgrot 20/10 (= obstacle).

   Le MÊME fichier sert :
     - de Web Worker (self.onmessage) chargé via Blob/Worker dans bolgrot.html ;
     - de module Node (module.exports) pour les tests d'équivalence / fuzz.

   Coordonnées : gx = colonne, gy = ligne. idx = gy * W + gx (row-major).
   Orthogonal (Bond) : (±1,0),(0,±1). Diagonale (Immobilisme) : (±1,±1).

   ----------------------------------------------------------------------------
   NOYAU DUR DU MODÈLE :
   1. Les feux sont attirés après chaque action non-end : axe dominant, ou
      diagonale exacte si |dx|==|dy| ; destination bloquée => le feu reste
      (blocked=stay). Les coins sont toujours CURRENT ; les feux repoussés
      sont simplement traités avant les autres pendant cette attraction.
   2. L'attraction est séquentielle dynamique : chaque feu présent au début de
      la phase est traité une seule fois, dans l'ordre V20 calculé au début.
   3. L'ordre normal est [manhattan, originDiff, angle, cellId], avec inversion
      originDiff/angle si la cible est à gauche du feu ; Immobilisme a son ordre
      spécial [manhattan, quadrantRank, originDiff, angle, cellId].
   4. Arriver sur un feu (Astral / Double cible) le tue. Traverser un feu en
      case intermédiaire avec un Bond Double tue le JOUEUR.
   5. Tuer un feu repousse SIMULTANÉMENT les feux adjacents (Chebyshev 1) dans
      la direction opposée, AVANT l'attirance.
   6. Si une répulsion est bloquée => mort. Si le dernier feu est tué => victoire.
   7. Règles de mort / pression V20 appliquées seulement hors Immobilisme :
      A) landing cell vide adjacente à au moins un feu = mort ;
      B) landing cell vide revendiquée par au moins deux feux = danger ;
      C) feu repoussé qui veut revenir sur son origine + autre claim = danger ;
      D) chaîne de pression vers le joueur ;
      E) Bond Double : pression diagonale via la case intermédiaire.
   L'attirance n'est PAS létale : un feu qui vise la case du joueur est bloqué.
============================================================================ */

"use strict";

// ============================================================
// PLATEAU PAR DÉFAUT (identique à BOARD_DEF de bolgrot.html)
// ============================================================
var DEFAULT_BOARD = [
  "############..#################", "###########....################", "##########......###############",
  "#########........##############", "########..........#############", "#######............############",
  "######..............###########", "#####................##########", "####..................#########",
  "###....................########", "##......................#######", "#........................######",
  "..........................#####", "...........................####", "............................###",
  "#..............P.............##", "##............................#", "###............................",
  "####...........................", "#####..........................", "######.........................",
  "#######........................", "########......................#", "#########....................##",
  "##########..................###", "###########................####", "############..............#####",
  "#############............######", "##############..........#######", "###############........########",
  "################......#########",
];

var DEFAULT_PLAYER = [15, 15];   // gx, gy
var DEFAULT_BOLGROT = [20, 10];  // gx, gy — agit comme un mur
var DEFAULT_PV = 39;
var DEFAULT_PA = 10;
var DEFAULT_TURN = 7;
var ENEMY_COUNT = 36;

// ============================================================
// CONFIG SOLVEUR (réglable)
// ============================================================
var BEAM_WIDTH_DEFAULT = 2000;
var MAX_STEPS_DEFAULT = 400;    // profondeur max en NOMBRE D'ACTIONS
var HP_CAP = 40;

// Poids heuristique (alpha — tunable).
// V23/V24 : scoring tactique. Le nombre de feux reste prioritaire,
// mais il n'écrase plus totalement la mobilité et les setups.
var W_ENEMIES = 120000;
var W_PV = 260;
var W_PA = 90;
var W_DOUBLE_LEFT = 420;
var W_SUMDIST = 3;
var W_MINDIST = 55;
var W_KILL_TARGET = 5200;
var W_SAFE_LANDING = 1500;
var W_IMMO_OPTION = 700;
var W_MOBILITY = 900;
var W_OPEN_NEIGHBOR = 260;
var W_PRIMARY_CLAIM_DANGER = 1800;
var W_NO_PROGRESS_PENALTY = 6500;
// V38A : scoring tactique de formation. L'objectif empirique en jeu est
// de créer de longues lignes de feux, puis de les consommer en série.
// Ces poids restent très inférieurs au poids d'un feu complet : ils servent
// uniquement à départager des états proches au même nombre de menaces.
var W_FIRE_LINE_RAY = 1850;
var W_FIRE_LINE_GLOBAL = 760;
var W_FIRE_ALIGNMENT = 115;
var W_LOCAL_DENSITY = 1250;
var W_ADJACENT_DENSITY = 2200;

// V24 : sélection diversifiée du beam. L'objectif est de garder un noyau
// élite très fort, puis de réserver une partie du beam à des familles
// tactiques différentes pour éviter l'effondrement prématuré sur un seul plan.
var DIVERSITY_ENABLED_DEFAULT = true;
var DIVERSITY_ELITE_RATIO_DEFAULT = 0.65;
var DIVERSITY_MIN_BUCKET_SLOTS = 24;

var ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
var DIAG = [[1, 1], [-1, -1], [1, -1], [-1, 1]];
var ORTHO_DIAG = ORTHO.concat(DIAG); // hissé : évite une allocation par appel de fireLineMetrics

function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

// ============================================================================
//  MODÈLE DE SIMULATION — surface de reverse-engineering (cf. analyse Emma).
//  Réglage exposé via ctx : cornerMode ∈ {"reserved","current"} (défaut
//  "reserved"). Ordre de résolution des feux : chebyshev_nearest + idx.
// ============================================================================

// Pas primaire (géométrique) d'un feu vers la cible T. null si déjà sur T.
function primaryStep(f, T, W) {
  var fx = f % W, fy = (f / W) | 0;
  var tx = T % W, ty = (T / W) | 0;
  var dx = tx - fx, dy = ty - fy;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) === Math.abs(dy)) return [sgn(dx), sgn(dy)];   // diagonale exacte
  if (Math.abs(dx) > Math.abs(dy)) return [sgn(dx), 0];           // axe X dominant
  return [0, sgn(dy)];                                            // axe Y dominant
}

// Destination primaire réellement revendiquée par un feu : géométrie + bornes + murs.
// C'est la même notion que la passe 1 d'attractFires, exposée pour les règles prudentes.
function primaryDestination(f, T, ctx) {
  var W = ctx.W, H = ctx.H, blocked = ctx.blocked;
  var st = primaryStep(f, T, W);
  if (st === null) return null;
  var nx = (f % W) + st[0], ny = ((f / W) | 0) + st[1];
  if (nx < 0 || nx >= W || ny < 0 || ny >= H) return null;
  var d = ny * W + nx;
  if (blocked.has(d)) return null;
  return d;
}

function countPrimaryClaimsTo(fires, T, claimed, ctx) {
  var n = 0;
  // Perf : quand claimed===T (les deux seuls usages : vers target et vers player),
  // un feu ne peut revendiquer T que s'il en est voisin Chebyshev-1 (primaryDestination
  // ne fait qu'un pas). On saute donc les non-voisins sans appeler primaryDestination.
  // Comportement-exact : un non-voisin contribue toujours 0 dans ce cas.
  if (claimed === T) {
    var W = ctx.W, tx = T % W, ty = (T / W) | 0;
    for (var f of fires) {
      var dx = Math.abs((f % W) - tx), dy = Math.abs(((f / W) | 0) - ty);
      if (Math.max(dx, dy) !== 1) continue;
      if (primaryDestination(f, T, ctx) === claimed) n++;
    }
    return n;
  }
  fires.forEach(function (f) {
    if (primaryDestination(f, T, ctx) === claimed) n++;
  });
  return n;
}

function chebIdx(a, b, W) {
  return Math.max(Math.abs((a % W) - (b % W)), Math.abs(((a / W) | 0) - ((b / W) | 0)));
}

function hasAdjacentFireToCell(fires, cell, ctx) {
  var W = ctx.W;
  var cx = cell % W, cy = (cell / W) | 0;
  var found = false;
  fires.forEach(function (f) {
    if (found) return;
    var dx = Math.abs((f % W) - cx);
    var dy = Math.abs(((f / W) | 0) - cy);
    if (Math.max(dx, dy) === 1) found = true;
  });
  return found;
}

function hasPrimaryClaimCollisionNear(fires, T, center, radius, ctx) {
  var counts = new Map();
  fires.forEach(function (f) {
    var d = primaryDestination(f, T, ctx);
    if (d === null) return;
    counts.set(d, (counts.get(d) || 0) + 1);
  });

  var W = ctx.W;
  var dangerous = false;
  counts.forEach(function (n, d) {
    if (n >= 2 && chebIdx(d, center, W) <= radius) dangerous = true;
  });
  return dangerous;
}

function primaryClaimCounts(fires, T, ctx) {
  var counts = new Map();
  fires.forEach(function (f) {
    var d = primaryDestination(f, T, ctx);
    if (d === null) return;
    counts.set(d, (counts.get(d) || 0) + 1);
  });
  return counts;
}

// Règle pression 3 — chain_pressure_to_player :
// si un feu vise directement la case joueur, et qu'au moins un autre feu vise
// l'origine de ce feu, on coupe l'action par prudence.
function hasChainPressureToPlayer(fires, playerAfter, ctx) {
  // Perf : primaryDestination(f, playerAfter) était calculé deux fois par feu
  // (dans primaryClaimCounts puis dans la boucle ci-dessous). Cette fonction tourne
  // sur quasiment chaque action ; on calcule donc la destination une seule fois par
  // feu, puis on construit la carte des claims à partir de ce résultat. Résultat
  // strictement identique (mêmes claims, même test).
  var dangerous = false;
  var claims = new Map();
  var dests = [];
  for (var f of fires) {
    var d = primaryDestination(f, playerAfter, ctx);
    dests.push([f, d]);
    if (d !== null) claims.set(d, (claims.get(d) || 0) + 1);
  }
  for (var i = 0; i < dests.length; i++) {
    var fd = dests[i];
    if (fd[1] === playerAfter && (claims.get(fd[0]) || 0) >= 1) { dangerous = true; break; }
  }
  return dangerous;
}

// Règle pression 4 — double_diagonal_corner_intermediate_pressure :
// après un Bond Double, si un feu veut entrer en diagonale sur player_after
// et que la case intermédiaire du bond est l'un des deux coins orthogonaux
// de cette diagonale, on coupe l'action par prudence.
function hasDoubleDiagonalCornerIntermediatePressure(fires, playerAfter, intermediate, ctx) {
  var W = ctx.W;
  var pax = playerAfter % W, pay = (playerAfter / W) | 0;
  var dangerous = false;

  fires.forEach(function (f) {
    if (dangerous) return;
    var d = primaryDestination(f, playerAfter, ctx);
    if (d !== playerAfter) return;

    var fx = f % W, fy = (f / W) | 0;
    var dx = sgn(pax - fx), dy = sgn(pay - fy);
    if (dx === 0 || dy === 0) return;                  // pas une attaque diagonale

    var sideA = fy * W + (fx + dx);                    // (fire.x + dx, fire.y)
    var sideB = (fy + dy) * W + fx;                    // (fire.x, fire.y + dy)
    if (intermediate === sideA || intermediate === sideB) dangerous = true;
  });

  return dangerous;
}

// Règle pression 2 : un feu repoussé veut revenir sur son origine,
// et cette origine est aussi revendiquée par au moins un autre feu.
function hasRepulsedOriginReclaimConflict(firesAfterRepulse, repulseMoves, T, ctx) {
  if (!repulseMoves || repulseMoves.length === 0) return false;
  var counts = primaryClaimCounts(firesAfterRepulse, T, ctx);
  for (var i = 0; i < repulseMoves.length; i++) {
    var origin = repulseMoves[i][0];
    var newCell = repulseMoves[i][1];
    if (primaryDestination(newCell, T, ctx) === origin && (counts.get(origin) || 0) >= 2) return true;
  }
  return false;
}

function manhattanIdx(a, b, W) {
  return Math.abs((a % W) - (b % W)) + Math.abs(((a / W) | 0) - ((b / W) | 0));
}
function originDiffIdx(c, W) {
  return (c % W) - ((c / W) | 0);
}
function angleClockwiseFromNorthIdx(origin, target, W) {
  var ox = origin % W, oy = (origin / W) | 0;
  var tx = target % W, ty = (target / W) | 0;
  var sx = (ox - oy) - (tx - ty);
  var sy = ((ox + oy) - (tx + ty)) * 0.5;
  var angle = Math.atan2(sx, -sy);
  if (angle < 0) angle += 2 * Math.PI;
  return angle;
}
function quadrantIdx(origin, target, W) {
  var dx = (origin % W) - (target % W);
  var dy = ((origin / W) | 0) - ((target / W) | 0);
  if (dx >= 0 && dy < 0) return "NE";
  if (dx >= 0 && dy >= 0) return "SE";
  if (dx < 0 && dy >= 0) return "SW";
  return "NW";
}
function quadrantRank(q) {
  if (q === "NW") return 0;
  if (q === "NE") return 1;
  if (q === "SE") return 2;
  if (q === "SW") return 3;
  return 99;
}
function normalFireOrderKey(fire, target, ctx) {
  var W = ctx.W;
  var manh = manhattanIdx(fire, target, W);
  var odiff = originDiffIdx(fire, W);
  var angle = angleClockwiseFromNorthIdx(fire, target, W);
  var cid = fire; // row-major y*W+x, proxy stable équivalent au cellId du rapport.
  var dx = (target % W) - (fire % W);
  if (dx < 0) return [manh, angle, odiff, cid];
  return [manh, odiff, angle, cid];
}
function immobilismeFireOrderKey(fire, target, ctx) {
  var W = ctx.W;
  return [
    manhattanIdx(fire, target, W),
    quadrantRank(quadrantIdx(fire, target, W)),
    originDiffIdx(fire, W),
    angleClockwiseFromNorthIdx(fire, target, W),
    fire
  ];
}
function fireOrderKey(fire, target, actionKind, ctx) {
  if (actionKind === "immo" || actionKind === "IMMOBILISME") return immobilismeFireOrderKey(fire, target, ctx);
  return normalFireOrderKey(fire, target, ctx);
}
function compareKeys(a, b) {
  var n = Math.min(a.length, b.length);
  for (var i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}
function latBlockedCurrent(cell, occ, blocked, playerBlocker) {
  if (blocked.has(cell)) return true;
  if (occ.has(cell)) return true;
  // V5.3 : une case occupée par le joueur bloque aussi le corner-cutting diagonal.
  // Sans ça, un feu peut glisser diagonalement “à travers le coin” du joueur,
  // surtout visible pendant Immobilisme où la cible d'attraction n'est pas le joueur.
  if (playerBlocker != null && cell === playerBlocker) return true;
  return false;
}

// --- ATTIRANCE V20-C (non létale) : séquentielle dynamique, ordre dépendant de l'action.
// Après une poussée, les feux effectivement repoussés sont traités avant tous les
// autres. Les destinations ET les coins diagonaux restent lus dans l'occupation
// dynamique courante. Les tests exhaustif local + stress global ont confirmé que
// cette formulation C est équivalente à B sur les états de poussée légaux, tout en
// évitant le snapshot post-poussée alloué par B.
function attractFires(fires, T, P, ctx, actionKind, repulsedSet) {
  var W = ctx.W, H = ctx.H, blocked = ctx.blocked;
  actionKind = actionKind || "normal";

  // Chemin wasm hybride (voie A) : les angles atan2 sont calculés ici en JS (seul
  // op transcendant, non bit-portable) puis passés en f64 ; le wasm fait le tri
  // (comparaisons IEEE strictement identiques à JS) + le déplacement des feux +
  // l'occupation en bitmap. Sortie bit-exacte avec le repli JS ci-dessous
  // (validé : 846 728 appels réels, 0 écart). n <= 64 sinon repli.
  // Le WASM ne connaît pas la priorité C des feux repoussés. On garde la voie
  // rapide pour les attractions ordinaires et on bascule en JS seulement lorsqu'au
  // moins un feu repoussé doit être traité.
  if ((!repulsedSet || repulsedSet.size === 0) && typeof self !== 'undefined' && self.__FLN_READY && self.__FLN_MEM_F64 !== undefined && fires.size <= 64) {
    var _f = self.__FLN, _M = self.__FLN_MEM_I32, _U8 = self.__FLN_MEM_U8, _F = self.__FLN_MEM_F64;
    if (self.__FLN_BOARD_W !== ctx.W || self.__FLN_BOARD_H !== ctx.H || self.__FLN_BOARD_BSZ !== ctx.blocked.size) {
      _f.init(ctx.W, ctx.H);
      var _bp = self.__FLN_BLOCKED_PTR, _cells = ctx.W * ctx.H;
      for (var _z = 0; _z < _cells; _z++) _U8[_bp + _z] = 0;
      for (var _bc of ctx.blocked) _U8[_bp + _bc] = 1;
      self.__FLN_BOARD_W = ctx.W; self.__FLN_BOARD_H = ctx.H; self.__FLN_BOARD_BSZ = ctx.blocked.size;
    }
    var _eb = self.__FLN_ENEM_I32, _ao = self.__FLN_AANG_OFF, _ob = self.__FLN_AOUT_I32, _i = 0;
    for (var _fc of fires) { _M[_eb + _i] = _fc; _F[_ao + _i] = angleClockwiseFromNorthIdx(_fc, T, W); _i++; }
    var _ak = (actionKind === "immo" || actionKind === "IMMOBILISME") ? 1 : 0;
    var _pb = (ctx.playerBlocksDiagonalCorner === false) ? 0 : 1;
    _f.attractFires(T, P, _ak, _pb, _i);
    var _occ = new Set();
    for (var _j = 0; _j < _i; _j++) _occ.add(_M[_ob + _j]);
    return _occ;
  }

  // identity_once : on fige la liste des feux au début et chacun est traité une fois.
  // Perf : transformation de Schwartz — la clé d'ordre (qui calcule un atan2) est
  // calculée UNE fois par feu, au lieu d'être recalculée pour les deux opérandes à
  // chaque comparaison du tri. Les clés se terminent par l'index de cellule (unique),
  // donc l'ordre est strictement total et identique à l'ancien tri.
  var keyed = [];
  for (var f of fires) keyed.push({ f: f, k: fireOrderKey(f, T, actionKind, ctx) });
  keyed.sort(function (a, b) { return compareKeys(a.k, b.k); });

  var occ = new Set(fires);
  var playerCornerBlocker = ctx.playerBlocksDiagonalCorner === false ? null : P;

  // Les clés sont déjà triées selon l'ordre V20. C est une partition stable : on
  // traite d'abord les feux repoussés, puis les autres, sans réallouer de clés ni
  // de snapshot d'occupation. Hors poussée, un seul passage suffit.
  var passCount = (repulsedSet && repulsedSet.size) ? 2 : 1;
  for (var pass = 0; pass < passCount; pass++) {
    for (var j = 0; j < keyed.length; j++) {
      var fo = keyed[j].f;
      if (passCount === 2 && (repulsedSet.has(fo) ? 0 : 1) !== pass) continue;
      if (!occ.has(fo)) continue; // garde-fou identité ; normalement vrai pendant une attraction pure.

      var st = primaryStep(fo, T, W);
      if (st === null) continue;
      var nx = (fo % W) + st[0], ny = ((fo / W) | 0) + st[1];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      var dd = ny * W + nx;
      if (blocked.has(dd)) continue;

      var isDiag = (st[0] !== 0 && st[1] !== 0);
      var stop = false;
      if (dd === P) stop = true;                         // case joueur : bloqué (NON létal)
      else if (occ.has(dd)) stop = true;                 // occupée par un feu dans l'état courant
      else if (isDiag) {
        var fx = fo % W, fy = (fo / W) | 0;
        var latA = fy * W + (fx + st[0]);                // (fx+dx, fy)
        var latB = (fy + st[1]) * W + fx;                // (fx, fy+dy)
        if (latBlockedCurrent(latA, occ, blocked, playerCornerBlocker) ||
            latBlockedCurrent(latB, occ, blocked, playerCornerBlocker)) stop = true;
      }

      if (!stop) { occ.delete(fo); occ.add(dd); }
    }
  }
  return occ;
}

// --- RÉPULSION après kill : feux à Chebyshev 1 du feu tué, poussés à l'opposé.
// Renvoie {fires, moves}, ou null si une répulsion est bloquée (= mort).
// moves = [[origin, dest], ...] pour alimenter les règles prudentes post-répulsion.
function repulseDetailed(fires, K, playerBefore, playerAfter, ctx) {
  var W = ctx.W, H = ctx.H, blocked = ctx.blocked;
  var Kx = K % W, Ky = (K / W) | 0;

  var affected = [];
  fires.forEach(function (f) {
    var dxc = Math.abs((f % W) - Kx), dyc = Math.abs(((f / W) | 0) - Ky);
    if (Math.max(dxc, dyc) === 1) affected.push(f);
  });
  if (affected.length === 0) return { fires: fires, moves: [] };

  var affectedOrigins = new Set(affected);
  var moves = [];                       // [origin, dest]
  var destCount = new Map();
  for (var i = 0; i < affected.length; i++) {
    var f = affected[i];
    var fx = f % W, fy = (f / W) | 0;
    var nx = fx + sgn(fx - Kx), ny = fy + sgn(fy - Ky);
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) return null;     // hors plateau => mort
    var d = ny * W + nx;
    if (blocked.has(d)) return null;                              // mur/bolgrot => mort
    if (d === playerBefore || d === playerAfter) return null;     // joueur => mort (probable)
    moves.push([f, d]);
    destCount.set(d, (destCount.get(d) || 0) + 1);
  }
  for (var j = 0; j < moves.length; j++) {
    var d2 = moves[j][1];
    if (fires.has(d2) && !affectedOrigins.has(d2)) return null;   // feu stationnaire => mort
    if (destCount.get(d2) > 1) return null;                       // deux répulsions, même case => mort
  }

  var result = new Set(fires);
  for (var a = 0; a < affected.length; a++) result.delete(affected[a]);
  for (var m = 0; m < moves.length; m++) result.add(moves[m][1]);
  return { fires: result, moves: moves };
}

// Wrapper historique conservé pour compatibilité avec les tests/outils existants.
function repulse(fires, K, playerBefore, playerAfter, ctx) {
  var rep = repulseDetailed(fires, K, playerBefore, playerAfter, ctx);
  return rep === null ? null : rep.fires;
}

// ============================================================
// ÉTAT & CLÉ DE DÉDUP
// État = { player, enemies:Set<idx>, pv, pa, doubles, turn }
// ============================================================
function mkState(player, enemies, pv, pa, doubles, turn, glyphs) {
  return { player: player, enemies: enemies, pv: pv, pa: pa, doubles: doubles, turn: turn, glyphs: glyphs || new Set() };
}
// Perf : les ensembles enemies/glyphs d'un état ne sont jamais mutés après
// création (mkState reçoit des Set neufs, attraction/répulsion renvoient des Set
// neufs). On mémoïse donc les clés triées une fois par état ; enemiesKey/glyphsKey
// sont appelées plusieurs fois par enfant (stateKey, tacticalKey, positionEnemyKey,
// cycle check) — le cache supprime ces reconstructions redondantes. Comportement
// identique : mêmes chaînes produites.
function glyphsKey(s) {
  if (!s || !s.glyphs || s.glyphs.size === 0) return "";
  if (s._glyphsKey !== undefined) return s._glyphsKey;
  var arr = Array.from(s.glyphs).sort(function (a, b) { return a - b; });
  var k = String.fromCharCode.apply(null, arr);
  s._glyphsKey = k;
  return k;
}
function stateKey(s) {
  return String.fromCharCode(s.player) + "\u0001" +
         enemiesKey(s) + "\u0001" +
         glyphsKey(s) + "\u0001" +
         s.pv + "," + s.pa + "," + s.doubles + "," + s.turn;
}

// V22 — clés tactiques pour dominance.
// Le tour est volontairement ignoré : après le tour 7, il sert surtout à
// l'affichage et à la perte de PV déjà matérialisée dans pv.
function enemiesKey(s) {
  if (s._enemiesKey !== undefined) return s._enemiesKey;
  var arr = Array.from(s.enemies).sort(function (a, b) { return a - b; });
  var k = String.fromCharCode.apply(null, arr);
  s._enemiesKey = k;
  return k;
}
function tacticalKey(s) {
  var gk = glyphsKey(s);
  var extra = (gk || s.turn < 7) ? ("\u0001t" + s.turn + "g" + gk) : "";
  return String.fromCharCode(s.player) + "\u0001" + enemiesKey(s) + "\u0001" + s.pa + "," + s.doubles + extra;
}
function positionEnemyKey(s) {
  if (s._posKey !== undefined) return s._posKey;
  var gk = glyphsKey(s);
  var k = String.fromCharCode(s.player) + "\u0001" + enemiesKey(s) + "\u0001" + gk;
  s._posKey = k;
  return k;
}
function sameFireSet(a, b) {
  if (a.size !== b.size) return false;
  var same = true;
  a.forEach(function (x) { if (!b.has(x)) same = false; });
  return same;
}
function idxToCell(idx, ctx) { return [idx % ctx.W, (idx / ctx.W) | 0]; }

// ============================================================
// ACTIONS
// action = { kind:"end" } | { kind:"astral"|"double"|"immo", dx, dy }
// ============================================================
function enumerateActions(state) {
  var acts = [{ kind: "end" }];
  var d;
  if (state.pa >= 1) {
    // Bond Astral : déplacement strictement orthogonal d'une case.
    for (var i = 0; i < ORTHO.length; i++) { d = ORTHO[i]; acts.push({ kind: "astral", dx: d[0], dy: d[1] }); }
  }
  if (state.pa >= 2 && state.doubles < 2) {
    // Bond Double conservé sur les 4 directions orthogonales observées/testées.
    for (var j = 0; j < ORTHO.length; j++) { d = ORTHO[j]; acts.push({ kind: "double", dx: d[0], dy: d[1] }); }
  }
  if (state.pa >= 1 && state.pv > 5) {   // Immobilisme : PV > 5 STRICT
    for (var kk = 0; kk < DIAG.length; kk++) { d = DIAG[kk]; acts.push({ kind: "immo", dx: d[0], dy: d[1] }); }
  }
  return acts;
}

// ============================================================
// V22 — SIMULATION INSTRUMENTÉE + BEAM SEARCH TT/PRUNING
// Hérite de V21 : raisons de rejet, score détaillé et audit de plan.
// Ajout V22 : transposition table globale, dominance et pruning des cycles/fin de tour.
// ============================================================
function cellObj(idx, ctx) { return { gx: idx % ctx.W, gy: (idx / ctx.W) | 0 }; }
function cellText(idx, ctx) { var c = cellObj(idx, ctx); return "(" + c.gx + "," + c.gy + ")"; }
function cellsArrayFromSet(set, ctx) {
  return Array.from(set).sort(function (a, b) { return a - b; }).map(function (idx) { return idxToCell(idx, ctx); });
}
function cloneAction(a) {
  var r = { kind: a.kind };
  if (a.dx != null) r.dx = a.dx;
  if (a.dy != null) r.dy = a.dy;
  return r;
}
function sameAction(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && (a.dx || 0) === (b.dx || 0) && (a.dy || 0) === (b.dy || 0);
}
function countAdjacentFiresToCell(fires, cell, ctx) {
  var W = ctx.W;
  var cx = cell % W, cy = (cell / W) | 0;
  var n = 0;
  fires.forEach(function (f) {
    var dx = Math.abs((f % W) - cx);
    var dy = Math.abs(((f / W) | 0) - cy);
    if (Math.max(dx, dy) === 1) n++;
  });
  return n;
}
function fireSetDelta(before, after, ctx) {
  var removed = [], added = [];
  before.forEach(function (f) { if (!after.has(f)) removed.push(idxToCell(f, ctx)); });
  after.forEach(function (f) { if (!before.has(f)) added.push(idxToCell(f, ctx)); });
  removed.sort(function (a, b) { return a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]; });
  added.sort(function (a, b) { return a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]; });
  return { removed: removed, added: added, changed_count: Math.max(removed.length, added.length) };
}
function summarizeStateLite(state, ctx) {
  return {
    player: idxToCell(state.player, ctx),
    enemies_remaining: state.enemies.size,
    glyphs_remaining: state.glyphs ? state.glyphs.size : 0,
    pv: state.pv,
    pa: state.pa,
    doubles: state.doubles,
    game_turn: state.turn
  };
}
function emptyEffects(state, a, ctx) {
  return {
    action_kind: a.kind,
    player_before: idxToCell(state.player, ctx),
    player_after: idxToCell(state.player, ctx),
    target: null,
    intermediate: null,
    killed: null,
    target_had_fire: false,
    repulsions: [],
    attraction: null,
    pv_before: state.pv,
    pv_after: state.pv,
    pa_before: state.pa,
    pa_after: state.pa,
    doubles_before: state.doubles,
    doubles_after: state.doubles,
    turn_before: state.turn,
    turn_after: state.turn
  };
}
function rejectDetailed(reason, state, a, ctx, details, effects, risk) {
  return {
    ok: false,
    state: null,
    rejectReason: reason,
    reason: reason,
    action: cloneAction(a),
    state_before: summarizeStateLite(state, ctx),
    effects: effects || emptyEffects(state, a, ctx),
    risk: risk || {},
    details: details || {}
  };
}
function okDetailed(nextState, state, a, ctx, effects, risk) {
  if (!nextState.glyphs) nextState.glyphs = (state && state.glyphs) ? new Set(state.glyphs) : new Set();
  // Perf : pendant la recherche (auditDuringSearch === false), ce score n'est
  // jamais relu — makeNode/scoreNodeDetailed le recalcule sur l'enfant. On évite
  // donc un scoreStateDetailed complet par action légale dans le hot path. Hors
  // recherche (audit, replay, appels externes via l'API), le comportement est
  // identique : le score est calculé comme avant.
  var ev = (ctx && ctx.auditDuringSearch === false) ? null : scoreStateDetailed(nextState, ctx);
  return {
    ok: true,
    state: nextState,
    rejectReason: null,
    reason: null,
    action: cloneAction(a),
    state_before: summarizeStateLite(state, ctx),
    state_after: summarizeStateLite(nextState, ctx),
    effects: effects || emptyEffects(state, a, ctx),
    risk: risk || {},
    score_total: ev ? ev.total : null,
    score_parts: ev ? ev.parts : null,
    score_metrics: ev ? ev.metrics : null
  };
}

// ============================================================
// V63B — résultat de recherche lean
// ------------------------------------------------------------
// Chemin strictement réservé à auditDuringSearch === false.
// Il applique les mêmes règles que simulateActionDetailed, mais ne construit pas
// effects/details/summaries/action clones. Le replay et l'audit final restent sur
// simulateActionDetailed.
// ============================================================
function leanReject(reason) {
  return { ok: false, state: null, rejectReason: reason, reason: reason, lean_v63b: true };
}
function leanOk(nextState, state) {
  if (!nextState.glyphs) nextState.glyphs = (state && state.glyphs) ? new Set(state.glyphs) : new Set();
  return { ok: true, state: nextState, rejectReason: null, reason: null, lean_v63b: true };
}

function simulateActionLean(state, a, ctx) {
  var W = ctx.W, H = ctx.H, blocked = ctx.blocked;

  if (a.kind === "end") {
    var pvEnd = state.pv - (state.turn >= 6 ? 1 : 0);
    var endEnemies = state.enemies;
    var endGlyphs = state.glyphs ? new Set(state.glyphs) : new Set();

    if (state.turn <= 6 && endGlyphs.size > 0) {
      endEnemies = new Set(state.enemies);
      endGlyphs.forEach(function (g) {
        if (g === state.player) return;
        if (endEnemies.has(g)) return;
        endEnemies.add(g);
      });
      endGlyphs = new Set();
    }

    var nextTurn = state.turn + 1;
    if (ctx.futureGlyphWaves && nextTurn <= 6) {
      var wave = ctx.futureGlyphWaves[nextTurn] || null;
      if (wave && wave.size) {
        endGlyphs = new Set(endGlyphs);
        wave.forEach(function (g) {
          if (g === state.player) return;
          if (endEnemies.has(g)) return;
          endGlyphs.add(g);
        });
      }
    }

    if (pvEnd <= 0) return leanReject("PV_DEATH_END_TURN");
    return leanOk(mkState(state.player, endEnemies, pvEnd, DEFAULT_PA, 0, nextTurn, endGlyphs), state);
  }

  var px = state.player % W, py = (state.player / W) | 0;

  if (a.kind === "immo") {
    var tx = px + a.dx, ty = py + a.dy;
    if (tx < 0 || tx >= W || ty < 0 || ty >= H) return leanReject("IMMO_TARGET_OUT_OF_BOARD");
    var tIdx = ty * W + tx;
    if (blocked.has(tIdx)) return leanReject("IMMO_TARGET_BLOCKED");
    var paI = state.pa - 1;
    var pvI = state.pv - 5;
    var firesI = attractFires(state.enemies, tIdx, state.player, ctx, "immo");
    return leanOk(mkState(state.player, firesI, pvI, paI, state.doubles, state.turn, state.glyphs), state);
  }

  var dist = (a.kind === "double") ? 2 : 1;
  var tx2 = px + a.dx * dist, ty2 = py + a.dy * dist;
  if (tx2 < 0 || tx2 >= W || ty2 < 0 || ty2 >= H) return leanReject("TARGET_OUT_OF_BOARD");
  var target = ty2 * W + tx2;
  if (blocked.has(target)) return leanReject("TARGET_BLOCKED");

  var targetHasFire = state.enemies.has(target);
  var primaryClaimsToTarget = countPrimaryClaimsTo(state.enemies, target, target, ctx);

  if (a.kind === "astral" && !targetHasFire && ctx.prudentAstralEmptyTarget !== false) {
    if (primaryClaimsToTarget >= 1) return leanReject("ASTRAL_EMPTY_TARGET_PRIMARY_CLAIM");
  }

  var inter = null;
  if (a.kind === "double") {
    var ix = px + a.dx, iy = py + a.dy;
    inter = iy * W + ix;
    if (blocked.has(inter)) return leanReject("INTERMEDIATE_BLOCKED");
    if (state.enemies.has(inter)) return leanReject("INTERMEDIATE_FIRE_FATAL");
  }

  if (!targetHasFire && ctx.fatalAdjacentEmptyLanding !== false) {
    if (countAdjacentFiresToCell(state.enemies, target, ctx) > 0) return leanReject("EMPTY_LANDING_ADJACENT_FIRE");
  }

  if (!targetHasFire && ctx.prudentLandingMultiClaim !== false) {
    if (primaryClaimsToTarget >= 2) return leanReject("LANDING_MULTI_CLAIM");
  }

  var pa = state.pa - (a.kind === "double" ? 2 : 1);
  var doubles = state.doubles + (a.kind === "double" ? 1 : 0);
  var pv = state.pv - 1;
  var playerAfter = target;

  var fires = new Set(state.enemies);
  var repulsedForAttraction = new Set();
  if (targetHasFire) {
    fires.delete(target);
    pv = Math.min(HP_CAP, pv + 1);
    if (fires.size === 0) {
      if (pv <= 0) return leanReject("PV_DEATH_AFTER_LAST_KILL");
      return leanOk(mkState(playerAfter, fires, pv, pa, doubles, state.turn, state.glyphs), state);
    }
    var rep = repulseDetailed(fires, target, state.player, playerAfter, ctx);
    if (rep === null) return leanReject("REPULSE_BLOCKED");
    fires = rep.fires;
    for (var rm = 0; rm < rep.moves.length; rm++) repulsedForAttraction.add(rep.moves[rm][1]);

    if (a.kind === "astral" && ctx.prudentAstralKillCollision !== false) {
      if (hasPrimaryClaimCollisionNear(fires, playerAfter, playerAfter, 1, ctx)) return leanReject("ASTRAL_KILL_COLLISION_NEAR_PLAYER");
    }

    if (ctx.prudentRepulsedOriginReclaim !== false) {
      if (hasRepulsedOriginReclaimConflict(fires, rep.moves, playerAfter, ctx)) return leanReject("REPULSED_ORIGIN_RECLAIM");
    }
  }
  if (pv <= 0) return leanReject("PV_DEATH_AFTER_ACTION");

  if (a.kind === "double" && ctx.prudentDoubleDiagonalCornerIntermediatePressure !== false) {
    if (hasDoubleDiagonalCornerIntermediatePressure(fires, playerAfter, inter, ctx)) return leanReject("DOUBLE_DIAGONAL_CORNER_INTERMEDIATE_PRESSURE");
  }

  if (ctx.prudentChainPressureToPlayer !== false) {
    if (hasChainPressureToPlayer(fires, playerAfter, ctx)) return leanReject("CHAIN_PRESSURE_TO_PLAYER");
  }

  fires = attractFires(fires, playerAfter, playerAfter, ctx, a.kind, repulsedForAttraction);
  return leanOk(mkState(playerAfter, fires, pv, pa, doubles, state.turn, state.glyphs), state);
}

function incCounter(obj, key, n) { obj[key] = (obj[key] || 0) + (n == null ? 1 : n); }

// Version debug de repulseDetailed : même logique, mais raison typée au lieu de null.
function repulseDetailedDebug(fires, K, playerBefore, playerAfter, ctx) {
  var W = ctx.W, H = ctx.H, blocked = ctx.blocked;
  var Kx = K % W, Ky = (K / W) | 0;

  var affected = [];
  fires.forEach(function (f) {
    var dxc = Math.abs((f % W) - Kx), dyc = Math.abs(((f / W) | 0) - Ky);
    if (Math.max(dxc, dyc) === 1) affected.push(f);
  });
  if (affected.length === 0) return { ok: true, fires: fires, moves: [] };

  var affectedOrigins = new Set(affected);
  var moves = [];
  var destCount = new Map();
  for (var i = 0; i < affected.length; i++) {
    var f = affected[i];
    var fx = f % W, fy = (f / W) | 0;
    var nx = fx + sgn(fx - Kx), ny = fy + sgn(fy - Ky);
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) {
      return { ok: false, reason: "REPULSE_BLOCKED_OUT_OF_BOARD", details: { origin: idxToCell(f, ctx), killed: idxToCell(K, ctx), attempted: [nx, ny] } };
    }
    var d = ny * W + nx;
    if (blocked.has(d)) {
      return { ok: false, reason: "REPULSE_BLOCKED_WALL_OR_BOLGROT", details: { origin: idxToCell(f, ctx), killed: idxToCell(K, ctx), destination: idxToCell(d, ctx) } };
    }
    if (d === playerBefore || d === playerAfter) {
      return { ok: false, reason: "REPULSE_BLOCKED_PLAYER", details: { origin: idxToCell(f, ctx), killed: idxToCell(K, ctx), destination: idxToCell(d, ctx), player_before: idxToCell(playerBefore, ctx), player_after: idxToCell(playerAfter, ctx) } };
    }
    moves.push([f, d]);
    destCount.set(d, (destCount.get(d) || 0) + 1);
  }
  for (var j = 0; j < moves.length; j++) {
    var d2 = moves[j][1];
    if (fires.has(d2) && !affectedOrigins.has(d2)) {
      return { ok: false, reason: "REPULSE_BLOCKED_STATIONARY_FIRE", details: { origin: idxToCell(moves[j][0], ctx), destination: idxToCell(d2, ctx) } };
    }
    if (destCount.get(d2) > 1) {
      return { ok: false, reason: "REPULSE_DESTINATION_COLLISION", details: { destination: idxToCell(d2, ctx), claims: destCount.get(d2) } };
    }
  }

  var result = new Set(fires);
  for (var a = 0; a < affected.length; a++) result.delete(affected[a]);
  for (var m = 0; m < moves.length; m++) result.add(moves[m][1]);
  return { ok: true, fires: result, moves: moves };
}

// Simulation détaillée. C'est volontairement le miroir de l'ancien applyAction().
function simulateActionDetailed(state, a, ctx) {
  var W = ctx.W, H = ctx.H, blocked = ctx.blocked;
  var effects = emptyEffects(state, a, ctx);
  var risk = {};

  if (a.kind === "end") {
    var pvEnd = state.pv - (state.turn >= 6 ? 1 : 0);
    var endEnemies = state.enemies;
    var endGlyphs = state.glyphs ? new Set(state.glyphs) : new Set();
    var glyphSpawn = { spawned: [], suppressed: [], blocked_by_player: [], blocked_by_fire: [] };
    // V38B.1 : pour les scénarios timeline T1→T6, les glyphes visibles du tour
    // courant deviennent des feux à la fin du tour. En T6, cela conserve le
    // comportement T6 historique ; avant T6, cela permet de simuler les vagues.
    if (state.turn <= 6 && endGlyphs.size > 0) {
      endEnemies = new Set(state.enemies);
      endGlyphs.forEach(function (g) {
        if (g === state.player) {
          var pc = idxToCell(g, ctx);
          glyphSpawn.suppressed.push(pc);
          glyphSpawn.blocked_by_player.push(pc);
        } else if (endEnemies.has(g)) {
          var fc = idxToCell(g, ctx);
          glyphSpawn.suppressed.push(fc);
          glyphSpawn.blocked_by_fire.push(fc);
        } else {
          endEnemies.add(g);
          glyphSpawn.spawned.push(idxToCell(g, ctx));
        }
      });
      endGlyphs = new Set();
    }

    var nextTurn = state.turn + 1;
    var nextGlyphWave = { turn: nextTurn, added: [], suppressed: [], blocked_by_player: [], blocked_by_fire: [] };
    if (ctx.futureGlyphWaves && nextTurn <= 6) {
      var wave = ctx.futureGlyphWaves[nextTurn] || null;
      if (wave && wave.size) {
        endGlyphs = new Set(endGlyphs);
        wave.forEach(function (g) {
          if (g === state.player) {
            var pc2 = idxToCell(g, ctx);
            nextGlyphWave.suppressed.push(pc2);
            nextGlyphWave.blocked_by_player.push(pc2);
          } else if (endEnemies.has(g)) {
            var fc2 = idxToCell(g, ctx);
            nextGlyphWave.suppressed.push(fc2);
            nextGlyphWave.blocked_by_fire.push(fc2);
          } else {
            endGlyphs.add(g);
            nextGlyphWave.added.push(idxToCell(g, ctx));
          }
        });
      }
    }

    effects.glyph_spawn = glyphSpawn;
    effects.next_glyph_wave = nextGlyphWave;
    effects.pv_after = pvEnd;
    effects.pa_after = DEFAULT_PA;
    effects.doubles_after = 0;
    effects.turn_after = nextTurn;
    if (pvEnd <= 0) return rejectDetailed("PV_DEATH_END_TURN", state, a, ctx, { pv_after: pvEnd }, effects, risk);
    return okDetailed(mkState(state.player, endEnemies, pvEnd, DEFAULT_PA, 0, nextTurn, endGlyphs), state, a, ctx, effects, risk);
  }

  var px = state.player % W, py = (state.player / W) | 0;

  if (a.kind === "immo") {
    var tx = px + a.dx, ty = py + a.dy;
    effects.target = [tx, ty];
    if (tx < 0 || tx >= W || ty < 0 || ty >= H) return rejectDetailed("IMMO_TARGET_OUT_OF_BOARD", state, a, ctx, { target: [tx, ty] }, effects, risk);
    var tIdx = ty * W + tx;
    if (blocked.has(tIdx)) return rejectDetailed("IMMO_TARGET_BLOCKED", state, a, ctx, { target: idxToCell(tIdx, ctx) }, effects, risk);
    var paI = state.pa - 1;
    var pvI = state.pv - 5;
    var firesI = attractFires(state.enemies, tIdx, state.player, ctx, "immo");
    effects.attraction = fireSetDelta(state.enemies, firesI, ctx);
    effects.pv_after = pvI;
    effects.pa_after = paI;
    effects.doubles_after = state.doubles;
    effects.turn_after = state.turn;
    return okDetailed(mkState(state.player, firesI, pvI, paI, state.doubles, state.turn, state.glyphs), state, a, ctx, effects, risk);
  }

  var dist = (a.kind === "double") ? 2 : 1;
  var tx2 = px + a.dx * dist, ty2 = py + a.dy * dist;
  effects.target = [tx2, ty2];
  if (tx2 < 0 || tx2 >= W || ty2 < 0 || ty2 >= H) return rejectDetailed("TARGET_OUT_OF_BOARD", state, a, ctx, { target: [tx2, ty2] }, effects, risk);
  var target = ty2 * W + tx2;
  if (blocked.has(target)) return rejectDetailed("TARGET_BLOCKED", state, a, ctx, { target: idxToCell(target, ctx) }, effects, risk);

  var targetHasFire = state.enemies.has(target);
  effects.target_had_fire = targetHasFire;
  risk.primary_claims_to_target = countPrimaryClaimsTo(state.enemies, target, target, ctx);

  if (a.kind === "astral" && !targetHasFire && ctx.prudentAstralEmptyTarget !== false) {
    if (risk.primary_claims_to_target >= 1) return rejectDetailed("ASTRAL_EMPTY_TARGET_PRIMARY_CLAIM", state, a, ctx, { target: idxToCell(target, ctx), claims: risk.primary_claims_to_target }, effects, risk);
  }

  var inter = null;
  if (a.kind === "double") {
    var ix = px + a.dx, iy = py + a.dy;
    inter = iy * W + ix;
    effects.intermediate = idxToCell(inter, ctx);
    if (blocked.has(inter)) return rejectDetailed("INTERMEDIATE_BLOCKED", state, a, ctx, { intermediate: idxToCell(inter, ctx) }, effects, risk);
    if (state.enemies.has(inter)) return rejectDetailed("INTERMEDIATE_FIRE_FATAL", state, a, ctx, { intermediate: idxToCell(inter, ctx) }, effects, risk);
  }

  if (!targetHasFire && ctx.fatalAdjacentEmptyLanding !== false) {
    risk.adjacent_fire_count = countAdjacentFiresToCell(state.enemies, target, ctx);
    if (risk.adjacent_fire_count > 0) return rejectDetailed("EMPTY_LANDING_ADJACENT_FIRE", state, a, ctx, { target: idxToCell(target, ctx), adjacent_fire_count: risk.adjacent_fire_count }, effects, risk);
  }

  if (!targetHasFire && ctx.prudentLandingMultiClaim !== false) {
    if (risk.primary_claims_to_target >= 2) return rejectDetailed("LANDING_MULTI_CLAIM", state, a, ctx, { target: idxToCell(target, ctx), claims: risk.primary_claims_to_target }, effects, risk);
  }

  var pa = state.pa - (a.kind === "double" ? 2 : 1);
  var doubles = state.doubles + (a.kind === "double" ? 1 : 0);
  var pv = state.pv - 1;
  var playerAfter = target;
  effects.player_after = idxToCell(playerAfter, ctx);
  effects.pa_after = pa;
  effects.doubles_after = doubles;
  effects.pv_after = pv;

  var fires = new Set(state.enemies);
  var repulsedForAttraction = new Set();
  if (targetHasFire) {
    fires.delete(target);
    effects.killed = idxToCell(target, ctx);
    pv = Math.min(HP_CAP, pv + 1);
    effects.pv_after = pv;
    if (fires.size === 0) {
      if (pv <= 0) return rejectDetailed("PV_DEATH_AFTER_LAST_KILL", state, a, ctx, { pv_after: pv }, effects, risk);
      return okDetailed(mkState(playerAfter, fires, pv, pa, doubles, state.turn, state.glyphs), state, a, ctx, effects, risk);
    }
    var rep = repulseDetailedDebug(fires, target, state.player, playerAfter, ctx);
    if (!rep.ok) return rejectDetailed(rep.reason || "REPULSE_BLOCKED", state, a, ctx, rep.details || {}, effects, risk);
    fires = rep.fires;
    for (var rm2 = 0; rm2 < rep.moves.length; rm2++) repulsedForAttraction.add(rep.moves[rm2][1]);
    effects.repulsions = rep.moves.map(function (mv) { return { from: idxToCell(mv[0], ctx), to: idxToCell(mv[1], ctx) }; });

    if (a.kind === "astral" && ctx.prudentAstralKillCollision !== false) {
      if (hasPrimaryClaimCollisionNear(fires, playerAfter, playerAfter, 1, ctx)) return rejectDetailed("ASTRAL_KILL_COLLISION_NEAR_PLAYER", state, a, ctx, { player_after: idxToCell(playerAfter, ctx) }, effects, risk);
    }

    if (ctx.prudentRepulsedOriginReclaim !== false) {
      if (hasRepulsedOriginReclaimConflict(fires, rep.moves, playerAfter, ctx)) return rejectDetailed("REPULSED_ORIGIN_RECLAIM", state, a, ctx, { player_after: idxToCell(playerAfter, ctx) }, effects, risk);
    }
  }
  if (pv <= 0) return rejectDetailed("PV_DEATH_AFTER_ACTION", state, a, ctx, { pv_after: pv }, effects, risk);

  if (a.kind === "double" && ctx.prudentDoubleDiagonalCornerIntermediatePressure !== false) {
    if (hasDoubleDiagonalCornerIntermediatePressure(fires, playerAfter, inter, ctx)) return rejectDetailed("DOUBLE_DIAGONAL_CORNER_INTERMEDIATE_PRESSURE", state, a, ctx, { player_after: idxToCell(playerAfter, ctx), intermediate: idxToCell(inter, ctx) }, effects, risk);
  }

  if (ctx.prudentChainPressureToPlayer !== false) {
    risk.chain_pressure_to_player = hasChainPressureToPlayer(fires, playerAfter, ctx);
    if (risk.chain_pressure_to_player) return rejectDetailed("CHAIN_PRESSURE_TO_PLAYER", state, a, ctx, { player_after: idxToCell(playerAfter, ctx) }, effects, risk);
  }

  var beforeAttraction = new Set(fires);
  fires = attractFires(fires, playerAfter, playerAfter, ctx, a.kind, repulsedForAttraction);
  effects.attraction = fireSetDelta(beforeAttraction, fires, ctx);
  effects.pv_after = pv;
  effects.pa_after = pa;
  effects.doubles_after = doubles;
  effects.turn_after = state.turn;

  return okDetailed(mkState(playerAfter, fires, pv, pa, doubles, state.turn, state.glyphs), state, a, ctx, effects, risk);
}

// Applique une action. Renvoie le nouvel état, ou null si illégal / mortel.
function applyAction(state, a, ctx) {
  var r = simulateActionDetailed(state, a, ctx);
  return r.ok ? r.state : null;
}

function actionDiagnosticRecord(state, a, sim, ctx) {
  var rec = {
    action: actionLabel(a, state, ctx),
    action_raw: cloneAction(a),
    ok: sim.ok,
    effects: sim.effects || null,
    risk: sim.risk || {},
  };
  if (sim.ok) {
    var ev = scoreNodeDetailed(sim.state, ctx, state, a, sim);
    rec.state_after = summarizeStateLite(sim.state, ctx);
    rec.score_total = ev.total;
    rec.score_parts = ev.parts;
    rec.score_metrics = ev.metrics;
  } else {
    rec.reject_reason = sim.rejectReason || sim.reason || "REJECTED";
    rec.details = sim.details || {};
  }
  return rec;
}

function expandDetailed(state, ctx) {
  var out = { children: [], legal: [], rejected: [], all: [] };
  var acts = enumerateActions(state);
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
    var sim = simulateActionDetailed(state, a, ctx);
    var rec = actionDiagnosticRecord(state, a, sim, ctx);
    out.all.push(rec);
    if (sim.ok) {
      out.children.push([a, sim.state, sim]);
      out.legal.push(rec);
    } else {
      out.rejected.push(rec);
    }
  }
  return out;
}

function expandForSearch(state, ctx) {
  // V27 : pendant la recherche portfolio, on évite l'audit complet de chaque
  // action. L'audit détaillé est reconstruit seulement sur le plan final.
  if (ctx.auditDuringSearch !== false) return expandDetailed(state, ctx);

  var out = {
    children: [], legal: [], rejected: [], all: [],
    all_count: 0, legal_count: 0, rejected_count: 0, rejected_by_reason: {}
  };
  var acts = enumerateActions(state);
  out.all_count = acts.length;
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
    var sim = (ctx.leanFastSearchResultV63B !== false && typeof simulateActionLean === 'function') ? simulateActionLean(state, a, ctx) : simulateActionDetailed(state, a, ctx);
    if (sim.ok) {
      out.children.push([a, sim.state, sim]);
      out.legal_count++;
    } else {
      var rr = sim.rejectReason || sim.reason || "REJECTED";
      incCounter(out.rejected_by_reason, rr);
      out.rejected_count++;
    }
  }
  return out;
}

function expand(state, ctx) {
  var out = [];
  var ex = expandDetailed(state, ctx);
  for (var i = 0; i < ex.children.length; i++) out.push([ex.children[i][0], ex.children[i][1]]);
  return out;
}

// ============================================================
// HEURISTIQUE & ÉLAGAGE
// ============================================================
function isWin(state) { return state.enemies.size === 0 && (!state.glyphs || state.glyphs.size === 0); }

function pendingThreatCount(state) { return state.enemies.size + (state.glyphs ? state.glyphs.size : 0); }
function minHpToFinish(state) {
  var K = pendingThreatCount(state);
  if (K === 0) return 0;
  var remainingAfterThisTurn = Math.max(0, K - state.pa);
  return Math.ceil(remainingAfterThisTurn / 10);   // borne basse : fins de tour restantes
}

function cellInBoundsIdx(cell, ctx) {
  var x = cell % ctx.W, y = (cell / ctx.W) | 0;
  return x >= 0 && x < ctx.W && y >= 0 && y < ctx.H;
}
function isOpenBoardCell(cell, ctx) {
  return cellInBoundsIdx(cell, ctx) && !ctx.blocked.has(cell);
}
function fireDistanceMetrics(state, ctx) {
  var W = ctx.W;
  var px = state.player % W, py = (state.player / W) | 0;
  var sumDist = 0, minDist = Infinity, minCheb = Infinity;
  for (var e of state.enemies) {
    var ex = e % W, ey = (e / W) | 0;
    var md = Math.abs(px - ex) + Math.abs(py - ey);
    var cd = Math.max(Math.abs(px - ex), Math.abs(py - ey));
    sumDist += md;
    if (md < minDist) minDist = md;
    if (cd < minCheb) minCheb = cd;
  }
  if (state.enemies.size === 0) { minDist = 0; minCheb = 0; }
  return { sumDist: sumDist, minDist: minDist, minCheb: minCheb };
}
function countGeometricKillTargets(state, ctx) {
  var W = ctx.W;
  var px = state.player % W, py = (state.player / W) | 0;
  var n = 0, astral = 0, dbl = 0;
  if (state.pa >= 1) {
    for (var i = 0; i < ORTHO.length; i++) {
      var d = ORTHO[i], tx = px + d[0], ty = py + d[1];
      if (tx < 0 || tx >= ctx.W || ty < 0 || ty >= ctx.H) continue;
      var target = ty * W + tx;
      if (!ctx.blocked.has(target) && state.enemies.has(target)) { n++; astral++; }
    }
  }
  if (state.pa >= 2 && state.doubles < 2) {
    for (var j = 0; j < ORTHO.length; j++) {
      var dd = ORTHO[j], ix = px + dd[0], iy = py + dd[1], tx2 = px + 2 * dd[0], ty2 = py + 2 * dd[1];
      if (tx2 < 0 || tx2 >= ctx.W || ty2 < 0 || ty2 >= ctx.H) continue;
      var inter = iy * W + ix, target2 = ty2 * W + tx2;
      if (ctx.blocked.has(inter) || ctx.blocked.has(target2) || state.enemies.has(inter)) continue;
      if (state.enemies.has(target2)) { n++; dbl++; }
    }
  }
  return { total: n, astral: astral, double: dbl };
}
function countRoughSafeEmptyLandings(state, ctx) {
  var W = ctx.W;
  var px = state.player % W, py = (state.player / W) | 0;
  // Perf : seuls les feux à distance Chebyshev 1 d'une cible peuvent compter,
  // tant pour l'adjacence (hasAdjacentFireToCell) que pour les claims
  // (primaryDestination ne fait qu'UN pas : il ne peut atteindre la cible que
  // depuis un voisin immédiat). On itère donc les feux une seule fois par cible,
  // boucle indexée, et on n'appelle primaryDestination que sur ces voisins — au
  // lieu de deux scans O(E) complets par cible. Conditions évaluées à l'identique.
  var en = Array.from(state.enemies);
  var n = 0;
  function testTarget(target) {
    if (ctx.blocked.has(target) || state.enemies.has(target)) return;
    var tx = target % W, ty = (target / W) | 0;
    var adj = 0, claims = 0;
    for (var fi = 0; fi < en.length; fi++) {
      var f = en[fi];
      var dx = Math.abs((f % W) - tx), dy = Math.abs(((f / W) | 0) - ty);
      if (Math.max(dx, dy) !== 1) continue;             // pas un voisin Chebyshev 1
      adj++;                                             // = hasAdjacentFireToCell
      if (primaryDestination(f, target, ctx) === target) claims++; // = countPrimaryClaimsTo
    }
    if (adj >= 1) return;                                // hasAdjacentFireToCell -> rejet
    if (claims >= 2) return;                             // countPrimaryClaimsTo >= 2 -> rejet
    n++;
  }
  if (state.pa >= 1) {
    for (var i = 0; i < ORTHO.length; i++) {
      var d = ORTHO[i], tx = px + d[0], ty = py + d[1];
      if (tx < 0 || tx >= ctx.W || ty < 0 || ty >= ctx.H) continue;
      testTarget(ty * W + tx);
    }
  }
  if (state.pa >= 2 && state.doubles < 2) {
    for (var j = 0; j < ORTHO.length; j++) {
      var dd = ORTHO[j], ix = px + dd[0], iy = py + dd[1], tx2 = px + 2 * dd[0], ty2 = py + 2 * dd[1];
      if (tx2 < 0 || tx2 >= ctx.W || ty2 < 0 || ty2 >= ctx.H) continue;
      var inter = iy * W + ix;
      if (ctx.blocked.has(inter) || state.enemies.has(inter)) continue;
      testTarget(ty2 * W + tx2);
    }
  }
  return n;
}
function countImmoOptions(state, ctx) {
  if (state.pa < 1 || state.pv <= 5) return 0;
  var W = ctx.W, px = state.player % W, py = (state.player / W) | 0, n = 0;
  for (var i = 0; i < DIAG.length; i++) {
    var d = DIAG[i], tx = px + d[0], ty = py + d[1];
    if (tx < 0 || tx >= ctx.W || ty < 0 || ty >= ctx.H) continue;
    if (!ctx.blocked.has(ty * W + tx)) n++; // un feu sur la cible est légal.
  }
  return n;
}
function countOpenOrthogonalNeighborhood(state, ctx) {
  var W = ctx.W, px = state.player % W, py = (state.player / W) | 0, n = 0;
  for (var i = 0; i < ORTHO.length; i++) {
    var d = ORTHO[i], tx = px + d[0], ty = py + d[1];
    if (tx < 0 || tx >= ctx.W || ty < 0 || ty >= ctx.H) continue;
    var cell = ty * W + tx;
    if (!ctx.blocked.has(cell) && !state.enemies.has(cell)) n++;
  }
  return n;
}

function fireLineMetrics(state, ctx) {
  // Perf : pure en (état, géométrie du plateau). Mémoïsée sur l'état pour partager
  // un seul calcul entre le scorer V47 (par nœud) et la sélection V38, qui la
  // recalculaient séparément. État jamais muté après création -> cache valide.
  if (state && state._lineMetrics !== undefined) return state._lineMetrics;

  // Chemin wasm (Phase A) : si le worker a instancié fln.wasm, on délègue le calcul.
  // Marshalling synchrone via mémoire linéaire partagée (pas de sérialisation).
  // Strictement iso-résultat avec le chemin JS ci-dessous (validé 2000/2000 états).
  if (typeof self !== 'undefined' && self.__FLN_READY) {
    var _f = self.__FLN, _M = self.__FLN_MEM_I32, _U8 = self.__FLN_MEM_U8;
    if (self.__FLN_BOARD_W !== ctx.W || self.__FLN_BOARD_H !== ctx.H || self.__FLN_BOARD_BSZ !== ctx.blocked.size) {
      _f.init(ctx.W, ctx.H);
      var _bp = self.__FLN_BLOCKED_PTR, _cells = ctx.W * ctx.H;
      for (var _z = 0; _z < _cells; _z++) _U8[_bp + _z] = 0;
      for (var _bc of ctx.blocked) _U8[_bp + _bc] = 1;
      self.__FLN_BOARD_W = ctx.W; self.__FLN_BOARD_H = ctx.H; self.__FLN_BOARD_BSZ = ctx.blocked.size;
    }
    var _W = ctx.W, _px = state.player % _W, _py = (state.player / _W) | 0;
    var _eb = self.__FLN_ENEM_I32, _i = 0;
    for (var _e of state.enemies) { _M[_eb + _i] = _e; _i++; }
    _f.fireLineMetrics(_px, _py, _i);
    var _ob = self.__FLN_OUT_I32;
    var _wout = {
      max_fire_line_ray: _M[_ob], fire_line_ray_score: _M[_ob + 1],
      max_fire_line_global: _M[_ob + 2], fire_alignment_score: _M[_ob + 3],
      local_density_cheb2: _M[_ob + 4], local_density_cheb3: _M[_ob + 5], adjacent_density: _M[_ob + 6]
    };
    if (state) state._lineMetrics = _wout;
    return _wout;
  }

  var W = ctx.W;
  var px = state.player % W, py = (state.player / W) | 0;
  var dirs = ORTHO_DIAG;
  var maxRay = 0, rayScore = 0;
  for (var di = 0; di < dirs.length; di++) {
    var d = dirs[di], count = 0, consecutive = 0, gapSeen = false;
    var x = px + d[0], y = py + d[1], step = 1;
    while (x >= 0 && x < ctx.W && y >= 0 && y < ctx.H) {
      var c = y * W + x;
      if (ctx.blocked.has(c)) break;
      if (state.enemies.has(c)) {
        count++;
        if (!gapSeen) consecutive++;
        // Plus le feu est proche sur le rayon, plus il est utile comme amorce.
        rayScore += Math.max(0, 9 - step);
      } else if (count > 0) {
        // On tolère les trous, mais on distingue les lignes vraiment compactes.
        gapSeen = true;
      }
      x += d[0]; y += d[1]; step++;
    }
    var rayValue = count * 2 + consecutive;
    if (rayValue > maxRay) maxRay = rayValue;
  }

  var rows = Object.create(null), cols = Object.create(null), diagA = Object.create(null), diagB = Object.create(null);
  var local2 = 0, local3 = 0, adjacent = 0;
  for (var e of state.enemies) {
    var ex = e % W, ey = (e / W) | 0;
    rows[ey] = (rows[ey] || 0) + 1;
    cols[ex] = (cols[ex] || 0) + 1;
    diagA[ex - ey] = (diagA[ex - ey] || 0) + 1;
    diagB[ex + ey] = (diagB[ex + ey] || 0) + 1;
    var cd = Math.max(Math.abs(px - ex), Math.abs(py - ey));
    if (cd <= 1) adjacent++;
    if (cd <= 2) local2++;
    if (cd <= 3) local3++;
  }
  function scan(map) {
    var max = 0, sq = 0;
    for (var k in map) {
      var v = map[k] || 0;
      if (v > max) max = v;
      if (v >= 2) sq += v * v;
    }
    return { max: max, sq: sq };
  }
  var sr = scan(rows), sc = scan(cols), sa = scan(diagA), sb = scan(diagB);
  var maxGlobal = Math.max(sr.max, sc.max, sa.max, sb.max);
  var alignment = sr.sq + sc.sq + sa.sq + sb.sq;
  var out = {
    max_fire_line_ray: maxRay,
    fire_line_ray_score: rayScore,
    max_fire_line_global: maxGlobal,
    fire_alignment_score: alignment,
    local_density_cheb2: local2,
    local_density_cheb3: local3,
    adjacent_density: adjacent
  };
  if (state) state._lineMetrics = out;
  return out;
}

// V42 : évaluateur virtuel T6 → T7.
// Il ne modifie jamais l'état ni les règles : il simule seulement un FIN DE TOUR
// depuis un état T6 pour donner au beam une idée de la qualité du T7 obtenu.

// V43 : heuristique “chercher le prochain kill”.
// Objectif : favoriser les états qui ont déjà une cible géométrique ou qui restent
// proches d'une conversion. Cette fonction est volontairement légère car elle est
// appelée sur beaucoup de candidats ; la validation “kill légal au coup suivant”
// est réservée à la lane bornée de bolgrot_strategies.js.
function nextKillSeekEvaluation(state, ctx) {
  if (!ctx || ctx.nextKillSeekScore !== true) return null;
  if (!state || !state.enemies || state.enemies.size === 0) return null;
  var dist = fireDistanceMetrics(state, ctx);
  var kills = countGeometricKillTargets(state, ctx);
  var safe = countRoughSafeEmptyLandings(state, ctx);
  var immo = countImmoOptions(state, ctx);
  var open = countOpenOrthogonalNeighborhood(state, ctx);
  var line = fireLineMetrics(state, ctx);
  var mobility = (kills.total || 0) + (safe || 0) + (immo || 0);
  var minDist = dist.minDist == null ? 99 : dist.minDist;
  var parts = {
    next_kill_geometric_targets: (kills.total || 0) * 30000,
    next_kill_astral_targets: (kills.astral || 0) * 9000,
    next_kill_double_targets: (kills.double || 0) * 6500,
    next_kill_close_fire_pressure: -Math.max(0, minDist - 1) * 2600,
    next_kill_mobility: Math.min(14, mobility || 0) * 1600,
    next_kill_safe_landings: Math.min(10, safe || 0) * 1200,
    next_kill_immo_options: Math.min(4, immo || 0) * 900,
    next_kill_open_neighbors: Math.min(4, open || 0) * 700,
    next_kill_line_support: (line.max_fire_line_ray || 0) * 2200,
    next_kill_no_target_penalty: ((kills.total || 0) === 0 && minDist > 3) ? -18000 : 0,
    next_kill_trapped_penalty: (mobility <= 1 && (kills.total || 0) === 0) ? -26000 : 0
  };
  var total = 0;
  Object.keys(parts).forEach(function (k) { total += parts[k]; });
  return {
    total: total,
    parts: parts,
    metrics: {
      geometric_kill_targets: kills.total || 0,
      geometric_kill_astral: kills.astral || 0,
      geometric_kill_double: kills.double || 0,
      min_dist: minDist,
      mobility: mobility,
      safe_landings: safe,
      immo_options: immo,
      open_neighbors: open,
      line_ray: line.max_fire_line_ray || 0
    }
  };
}


function t6VirtualEndEvaluation(state, ctx) {
  if (!ctx || ctx.t6VirtualEndScore !== true) return null;
  if (!state || state.turn !== 6 || !state.glyphs || state.glyphs.size === 0) return null;

  var sim = simulateActionDetailed(state, { kind: "end" }, ctx);
  if (!sim || !sim.ok || !sim.state) {
    return {
      total: -90000,
      parts: { t6_virtual_end_rejected: -90000 },
      metrics: { ok: false, reject_reason: sim ? (sim.rejectReason || sim.reason || "REJECTED") : "NO_SIM" }
    };
  }

  var projected = sim.state;
  var gs = (sim.effects && sim.effects.glyph_spawn) ? sim.effects.glyph_spawn : {};
  var suppressed = (gs.suppressed || []).length;
  var blockedByPlayer = (gs.blocked_by_player || []).length;
  var blockedByFire = (gs.blocked_by_fire || []).length;
  var spawned = (gs.spawned || []).length;
  var pm = tacticalStateMetrics(projected, ctx);
  var lm = fireLineMetrics(projected, ctx);

  var parts = {
    t6_virtual_suppressed_glyphs: suppressed * 54000,
    t6_virtual_blocked_by_player: blockedByPlayer * 9000,
    t6_virtual_blocked_by_fire: blockedByFire * 6500,
    t6_virtual_spawn_pressure: -Math.max(0, spawned - 3) * 4200,
    t6_virtual_t7_kill_targets: (pm.kill_targets || 0) * 11000,
    t6_virtual_t7_mobility: (pm.mobility_rough || 0) * 3000,
    t6_virtual_t7_safe_landings: (pm.rough_safe_empty_landings || 0) * 1700,
    t6_virtual_t7_line_ray: (lm.max_fire_line_ray || 0) * 3000,
    t6_virtual_t7_line_global: (lm.max_fire_line_global || 0) * 950,
    t6_virtual_t7_alignment: Math.min(260, lm.fire_alignment_score || 0) * 38,
    t6_virtual_t7_local_density: -Math.max(0, (lm.local_density_cheb2 || 0) - 2) * 4300,
    t6_virtual_t7_adjacent_density: -(lm.adjacent_density || 0) * 7200,
    t6_virtual_t7_primary_claims: -(pm.primary_claims_to_player || 0) * 2600,
    t6_virtual_t7_no_progress: ((pm.kill_targets || 0) === 0 && (pm.mobility_rough || 0) <= 2) ? -24000 : 0,
    t6_virtual_t7_low_pv_pressure: (projected.pv <= 2 && (pm.effective_enemies || 0) > 8) ? -18000 : 0
  };
  var total = 0;
  Object.keys(parts).forEach(function (k) { total += parts[k]; });
  return {
    total: total,
    parts: parts,
    metrics: {
      ok: true,
      projected_turn: projected.turn,
      projected_enemies: projected.enemies.size,
      projected_glyphs: projected.glyphs ? projected.glyphs.size : 0,
      suppressed_glyphs: suppressed,
      blocked_by_player: blockedByPlayer,
      blocked_by_fire: blockedByFire,
      spawned_glyphs: spawned,
      projected_kill_targets: pm.kill_targets || 0,
      projected_mobility: pm.mobility_rough || 0,
      projected_safe_landings: pm.rough_safe_empty_landings || 0,
      projected_max_fire_line_ray: lm.max_fire_line_ray || 0,
      projected_max_fire_line_global: lm.max_fire_line_global || 0,
      projected_alignment: lm.fire_alignment_score || 0,
      projected_local_density_cheb2: lm.local_density_cheb2 || 0,
      projected_adjacent_density: lm.adjacent_density || 0
    }
  };
}

function tacticalStateMetrics(state, ctx) {
  var dist = fireDistanceMetrics(state, ctx);
  var kills = countGeometricKillTargets(state, ctx);
  var safe = countRoughSafeEmptyLandings(state, ctx);
  var immo = countImmoOptions(state, ctx);
  var open = countOpenOrthogonalNeighborhood(state, ctx);
  var claims = countPrimaryClaimsTo(state.enemies, state.player, state.player, ctx);
  var glyphCount = state.glyphs ? state.glyphs.size : 0;
  return {
    enemies: state.enemies.size,
    glyphs: glyphCount,
    effective_enemies: state.enemies.size + glyphCount,
    pv: state.pv,
    pa: state.pa,
    doubles: state.doubles,
    doubles_left: Math.max(0, 2 - state.doubles),
    game_turn: state.turn,
    sum_dist: dist.sumDist,
    min_dist: dist.minDist,
    min_cheb: dist.minCheb,
    kill_targets: kills.total,
    kill_targets_astral: kills.astral,
    kill_targets_double: kills.double,
    rough_safe_empty_landings: safe,
    immo_options: immo,
    open_orthogonal_neighbors: open,
    primary_claims_to_player: claims,
    mobility_rough: kills.total + safe + immo
  };
}
function scoreStateDetailed(state, ctx) {
  if (isWin(state)) {
    return { total: Infinity, parts: { win: Infinity }, metrics: { enemies: 0, glyphs: 0, effective_enemies: 0, sum_dist: 0, min_dist: 0 } };
  }
  var m = tacticalStateMetrics(state, ctx);
  var parts = {
    enemies: -m.effective_enemies * W_ENEMIES,
    pv: m.pv * W_PV,
    pa: m.pa * W_PA,
    double_budget: m.doubles_left * W_DOUBLE_LEFT,
    sum_distance: -m.sum_dist * W_SUMDIST,
    min_distance: -m.min_dist * W_MINDIST,
    kill_targets: m.kill_targets * W_KILL_TARGET,
    rough_safe_landings: m.rough_safe_empty_landings * W_SAFE_LANDING,
    immo_options: m.immo_options * W_IMMO_OPTION,
    mobility: m.mobility_rough * W_MOBILITY,
    open_neighbors: m.open_orthogonal_neighbors * W_OPEN_NEIGHBOR,
    primary_claim_danger: -m.primary_claims_to_player * W_PRIMARY_CLAIM_DANGER,
    no_progress_penalty: (m.kill_targets === 0 && m.mobility_rough <= 2) ? -W_NO_PROGRESS_PENALTY : 0
  };
  var virtualEnd = t6VirtualEndEvaluation(state, ctx);
  if (virtualEnd) {
    Object.keys(virtualEnd.parts || {}).forEach(function (k) { parts[k] = virtualEnd.parts[k]; });
    m.t6_virtual_end = virtualEnd.metrics || null;
  }
  var nextKill = nextKillSeekEvaluation(state, ctx);
  if (nextKill) {
    Object.keys(nextKill.parts || {}).forEach(function (k) { parts[k] = nextKill.parts[k]; });
    m.next_kill_seek = nextKill.metrics || null;
  }
  var total = 0;
  Object.keys(parts).forEach(function (k) { total += parts[k]; });
  return { total: total, parts: parts, metrics: m };
}

function scoreState(state, ctx) {
  return scoreStateDetailed(state, ctx).total;
}

function scoreNodeDetailed(state, ctx, parentNodeOrState, action, actionDiag) {
  var base = scoreStateDetailed(state, ctx);
  if (!action || !parentNodeOrState) return base;

  var parentState = parentNodeOrState.state || parentNodeOrState;
  // Perf : tacticalStateMetrics est une fonction pure de l'état. Quand le parent
  // est un nœud déjà scoré, ses métriques de base sont identiques à un recalcul ;
  // on les réutilise pour économiser un O(E) par enfant. Garde-fou : on ne
  // réutilise que des métriques complètes (mobility_rough défini), jamais l'objet
  // réduit renvoyé pour un état gagnant.
  var before = (parentNodeOrState && parentNodeOrState.score_metrics && parentNodeOrState.score_metrics.mobility_rough != null)
    ? parentNodeOrState.score_metrics
    : tacticalStateMetrics(parentState, ctx);
  var after = base.metrics || tacticalStateMetrics(state, ctx);
  var effects = (actionDiag && actionDiag.effects) ? actionDiag.effects : {};
  var attraction = effects.attraction || {};
  var repulsions = effects.repulsions || [];
  var parts = {};
  Object.keys(base.parts || {}).forEach(function (k) { parts[k] = base.parts[k]; });

  // Bonus/malus d'action : petits devant le poids "ennemis", mais assez forts
  // pour choisir entre plusieurs états au même nombre de feux.
  if (effects.killed) parts.action_kill = 9000;
  if (action.kind === "end") {
    parts.action_end_penalty = -4200;
    if (parentState.pa <= 2 || parentState.doubles >= 2) parts.resource_reset_bonus = 2200;
    // V31 : bonus léger de tie-breaker pour les glyphes annulés au passage tour 6 -> 7.
    // Le score d'état tient déjà compte du nombre réel de menaces ; ce bonus ne doit pas
    // reproduire l'erreur V30 en optimisant myopiquement le tour 7.
    var gs = effects.glyph_spawn || null;
    if (gs && gs.suppressed && gs.suppressed.length) {
      parts.glyphs_blocked_tiebreak = gs.suppressed.length * 2200;
      if (gs.blocked_by_player && gs.blocked_by_player.length) parts.glyphs_blocked_by_player = gs.blocked_by_player.length * 900;
      if (gs.blocked_by_fire && gs.blocked_by_fire.length) parts.glyphs_blocked_by_fire = gs.blocked_by_fire.length * 650;
    }
  }
  if (action.kind === "immo") {
    parts.action_immo_setup = 900 + Math.min(12, attraction.changed_count || 0) * 180;
    if ((after.kill_targets || 0) > (before.kill_targets || 0)) parts.immo_created_kill_targets = (after.kill_targets - before.kill_targets) * 2400;
  }
  if (action.kind === "double") parts.action_double_budget_cost = -650;
  if (repulsions.length) parts.repulsion_activity = Math.min(8, repulsions.length) * 240;

  parts.delta_kill_targets = ((after.kill_targets || 0) - (before.kill_targets || 0)) * 1800;
  parts.delta_mobility = ((after.mobility_rough || 0) - (before.mobility_rough || 0)) * 800;
  parts.delta_safe_landings = ((after.rough_safe_empty_landings || 0) - (before.rough_safe_empty_landings || 0)) * 650;

  var total = 0;
  Object.keys(parts).forEach(function (k) { total += parts[k]; });
  return { total: total, parts: parts, metrics: after };
}


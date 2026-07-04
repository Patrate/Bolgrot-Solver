/* bolgrot_strategies.js — Structures de recherche et sélection beam V38A/V45.
   V45 : profil sweep déterministe line / survival / conversion + hybrides. */

// ============================================================
// BEAM SEARCH (V24 : V23 + sélection diversifiée du beam)
// ============================================================

function makeNode(state, parent, action, ctx, actionDiag, depth) {
  var ev = scoreNodeDetailed(state, ctx, parent, action, actionDiag);
  var j = v44StochasticScoreBonus(state, ctx, parent, action, ev);
  if (j) {
    ev.parts = ev.parts || {};
    ev.parts.v44_stochastic_restart = j;
    ev.total += j;
  }
  var p45 = v45ProfileScoreBonus(state, ctx, parent, action, ev, actionDiag);
  if (p45) {
    ev.parts = ev.parts || {};
    ev.parts.v45_profile_sweep = p45;
    ev.total += p45;
  }
  if (actionDiag) {
    actionDiag.score_total = ev.total;
    actionDiag.score_parts = ev.parts;
    actionDiag.score_metrics = ev.metrics;
  }
  return {
    negScore: -ev.total,
    score: ev.total,
    score_parts: ev.parts,
    score_metrics: ev.metrics,
    state: state,
    parent: parent,
    action: action,
    action_diag: actionDiag || null,
    depth: depth == null ? (parent ? parent.depth + 1 : 0) : depth
  };
}


// V60 — nœud de recherche rapide en parité stricte.
// On conserve exactement le même scoring que le chemin détaillé utilisé pendant
// la recherche (actionDiag=null quand auditDuringSearch=false), et on évite
// seulement de stocker les diagnostics détaillés dans chaque nœud.
function makeNodeFast(state, parent, action, ctx, fastEffects, depth) {
  // V60 Fast Path Parity : en mode recherche normale, auditDuringSearch=false.
  // Le chemin détaillé OFF score alors les enfants avec actionDiag=null.
  // V58A injectait ici des effects minimaux (kill/repulsion/attraction), ce qui
  // modifiait l'ordre du beam et pouvait perdre des branches gagnantes.
  // On ignore donc volontairement fastEffects pour le scoring chaud ; le replay
  // final reconstruit les effects détaillés avec simulateActionDetailed.
  var actionDiag = null;
  var ev = scoreNodeDetailed(state, ctx, parent, action, actionDiag);
  var j = v44StochasticScoreBonus(state, ctx, parent, action, ev);
  if (j) {
    ev.parts = ev.parts || {};
    ev.parts.v44_stochastic_restart = j;
    ev.total += j;
  }
  var p45 = v45ProfileScoreBonus(state, ctx, parent, action, ev, actionDiag);
  if (p45) {
    ev.parts = ev.parts || {};
    ev.parts.v45_profile_sweep = p45;
    ev.total += p45;
  }
  return {
    negScore: -ev.total,
    score: ev.total,
    score_parts: ev.parts,
    score_metrics: ev.metrics,
    state: state,
    parent: parent,
    action: action,
    action_diag: null,
    depth: depth == null ? (parent ? parent.depth + 1 : 0) : depth
  };
}

function makeSearchNodeV58A(state, parent, action, ctx, diag, fastEffects, depth) {
  if (ctx && ctx.auditDuringSearch === false && ctx.fastSearchPathV58A !== false && typeof makeNodeFast === 'function') {
    return makeNodeFast(state, parent, action, ctx, fastEffects || (diag && diag.effects) || null, depth);
  }
  return makeNode(state, parent, action, ctx, diag, depth);
}

// V44 — restarts stochastiques contrôlés.
// Objectif : modifier légèrement l’ordre de préférence du beam sans changer les règles
// ni créer un solveur aléatoire non reproductible. Le bruit est déterministe pour
// un état/action/seed donné, afin que deux benchmarks avec la même seed soient comparables.
function v44HashString(str) {
  var h = 2166136261 >>> 0;
  str = String(str || '');
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function v44ActionKey(action) {
  if (!action) return 'root';
  return String(action.kind || '') + ':' + (action.dx || 0) + ':' + (action.dy || 0) + ':' + (action.steps || 0);
}
function v44Noise01(key) {
  return (v44HashString(key) % 1000003) / 1000003;
}
function v44StochasticScoreBonus(state, ctx, parent, action, ev) {
  if (!ctx || ctx.v44StochasticRestart !== true) return 0;
  var m = (ev && ev.metrics) || tacticalStateMetrics(state, ctx);
  var seed = ctx.v44StochasticSeed || 'v44';
  var profile = ctx.v44StochasticProfile || 'mix';
  var strength = Math.max(0, Math.min(2, Number(ctx.v44JitterStrength) || 0.35));
  var depth = parent && parent.depth != null ? parent.depth + 1 : 0;
  var key = seed + '|' + profile + '|' + depth + '|' + stateKey(state) + '|' + v44ActionKey(action);
  var noise = (v44Noise01(key) * 2 - 1);

  // Bruit borné : assez fort pour casser les ex-aequo et explorer d'autres branches,
  // mais très inférieur au poids d'un feu réel (120k).
  var bonus = noise * (2600 + strength * 6200);

  // Profils légers : ils ne remplacent pas le score principal, ils déplacent les
  // préférences entre branches proches.
  if (profile === 'survival') {
    bonus += (m.pv || 0) * 95 * strength;
    bonus += (m.rough_safe_empty_landings || 0) * 980 * strength;
    bonus += (m.open_orthogonal_neighbors || 0) * 460 * strength;
    bonus -= (m.primary_claims_to_player || 0) * 1700 * strength;
  } else if (profile === 'line') {
    var lm = (typeof fireLineMetrics === 'function') ? fireLineMetrics(state, ctx) : null;
    if (lm) {
      bonus += (lm.max_ray || 0) * 1700 * strength;
      bonus += (lm.alignment_score || 0) * 90 * strength;
      bonus -= (lm.adjacent_density || 0) * 1200 * strength;
    }
  } else if (profile === 'conversion') {
    bonus += (m.kill_targets || 0) * 2300 * strength;
    bonus += (m.kill_targets_double || 0) * 900 * strength;
    if (action && action.kind === 'immo') bonus += 900 * strength;
    if (action && action.kind === 'end') bonus -= 1200 * strength;
  } else if (profile === 't6') {
    var v = m.t6_virtual_end || null;
    if (v) {
      bonus += (v.projected_kill_targets || 0) * 2100 * strength;
      bonus += (v.projected_safe_landings || 0) * 900 * strength;
      bonus += (v.suppressed_total || 0) * 1600 * strength;
      bonus -= (v.spawned_glyphs || 0) * 450 * strength;
    }
  } else {
    bonus += (m.kill_targets || 0) * 900 * strength;
    bonus += (m.rough_safe_empty_landings || 0) * 520 * strength;
    bonus += (m.pv || 0) * 38 * strength;
  }
  return Math.round(bonus);
}

// V45 — profil sweep déterministe.
// Contrairement aux restarts V44, ce bonus ne contient aucun bruit. Il sert à tester
// quel biais heuristique reste utile à beam 100 / 300 / 1000 : ligne, survie,
// conversion, et quelques hybrides simples.
function v45ProfileScoreBonus(state, ctx, parent, action, ev, actionDiag) {
  if (!ctx || ctx.v45ProfileSweep !== true) return 0;
  var comps = ctx.v45ProfileComponents || {};
  var intensity = Math.max(0, Math.min(2.5, Number(ctx.v45ProfileIntensity) || 1));
  var m = (ev && ev.metrics) || tacticalStateMetrics(state, ctx);
  var lm = null;
  var effects = actionDiag && actionDiag.effects ? actionDiag.effects : {};

  function lineMetrics() {
    if (!lm && typeof fireLineMetrics === 'function') lm = fireLineMetrics(state, ctx) || {};
    return lm || {};
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || 0)); }

  var total = 0;
  if (comps.line) {
    var l = lineMetrics();
    var maxRay = l.max_fire_line_ray || l.max_ray || 0;
    var maxGlobal = l.max_fire_line_global || l.max_global || 0;
    var align = l.fire_alignment_score || l.alignment_score || 0;
    var density2 = l.local_density_cheb2 || 0;
    var adjacent = l.adjacent_density || 0;
    var bLine =
      maxRay * 5200 +
      maxGlobal * 1500 +
      Math.min(260, align) * 72 +
      (m.mobility_rough || 0) * 520 -
      Math.max(0, density2 - 2) * 2600 -
      adjacent * 3900;
    if (maxRay >= 7) bLine += 9000;
    if (maxRay >= 9) bLine += 9000;
    total += bLine * Number(comps.line || 0);
  }

  if (comps.survival) {
    var bSurvival =
      (m.pv || 0) * 760 +
      (m.mobility_rough || 0) * 2300 +
      (m.rough_safe_empty_landings || 0) * 1550 +
      (m.open_orthogonal_neighbors || 0) * 900 +
      (m.immo_options || 0) * 850 -
      (m.primary_claims_to_player || 0) * 7600;
    var sl = lineMetrics();
    bSurvival -= (sl.adjacent_density || 0) * 4300;
    bSurvival -= Math.max(0, (sl.local_density_cheb2 || 0) - 2) * 2200;
    if ((m.mobility_rough || 0) <= 2 && (m.kill_targets || 0) === 0) bSurvival -= 16000;
    total += bSurvival * Number(comps.survival || 0);
  }

  if (comps.conversion) {
    var killed = effects && effects.killed ? 1 : 0;
    var bConversion =
      killed * 32000 +
      (m.kill_targets || 0) * 7800 +
      (m.kill_targets_astral || 0) * 1600 +
      (m.kill_targets_double || 0) * 1400 +
      (m.mobility_rough || 0) * 450;
    if (action && action.kind === 'immo') bConversion += 2400;
    if (action && action.kind === 'end') bConversion -= 3600;
    if ((m.kill_targets || 0) === 0 && state.enemies && state.enemies.size > 8) bConversion -= 6200;
    total += bConversion * Number(comps.conversion || 0);
  }

  if (comps.t6) {
    var v = m.t6_virtual_end || null;
    if (v && v.ok !== false) {
      var suppressed = (v.suppressed_glyphs || 0) + (v.suppressed_total || 0);
      var bT6 =
        suppressed * 9200 +
        (v.blocked_by_player || 0) * 2600 +
        (v.blocked_by_fire || 0) * 1600 +
        (v.projected_kill_targets || 0) * 6400 +
        (v.projected_mobility || 0) * 2100 +
        (v.projected_safe_landings || 0) * 1150 +
        (v.projected_max_fire_line_ray || 0) * 2100 -
        Math.max(0, (v.spawned_glyphs || 0) - 3) * 2600 -
        Math.max(0, (v.projected_local_density_cheb2 || 0) - 2) * 2600 -
        (v.projected_adjacent_density || 0) * 3900;
      total += bT6 * Number(comps.t6 || 0);
    } else if (state.turn === 6 && state.glyphs && state.glyphs.size) {
      total -= 12000 * Number(comps.t6 || 0);
    }
  }

  // Très léger profil early/late possible sans nouvelles stratégies dédiées : si le
  // profil indique lateBias, la conversion devient plus forte quand il reste moins
  // de menaces ; utile pour de futurs micro-tests sans toucher à l'UI.
  if (ctx.v45LateBias && state && state.enemies) {
    var remaining = state.enemies.size + (state.glyphs ? state.glyphs.size : 0);
    total *= (remaining <= 18 ? 1.18 : 0.92);
  }

  return Math.round(total * intensity);
}

function makeTranspositionTable() {
  return {
    byTactical: new Map(),
    stored: 0,
    replaced: 0,
    dominated: 0
  };
}

function ttDominates(tt, node) {
  var s = node.state;
  var prev = tt.byTactical.get(tacticalKey(s));
  if (prev === undefined) return { dominated: false, reason: "TT_NEW" };
  // Même position, mêmes feux, mêmes PA, mêmes doubles : plus de PV domine.
  // À PV égal, le chemin le plus court/proche de la racine domine.
  if (prev.pv > s.pv || (prev.pv === s.pv && prev.depth <= node.depth)) {
    return { dominated: true, reason: "TT_DOMINATED", previous: prev };
  }
  return { dominated: false, reason: "TT_CAN_REPLACE", previous: prev };
}

function ttRememberNode(tt, node) {
  var s = node.state;
  var key = tacticalKey(s);
  var prev = tt.byTactical.get(key);
  if (prev !== undefined) {
    if (prev.pv > s.pv || (prev.pv === s.pv && prev.depth <= node.depth)) {
      tt.dominated++;
      return "TT_DOMINATED";
    }
    tt.replaced++;
  } else {
    tt.stored++;
  }
  tt.byTactical.set(key, { pv: s.pv, depth: node.depth, score: node.score, enemies: s.enemies.size });
  return prev === undefined ? "TT_NEW" : "TT_REPLACED";
}

function localCandidateDominance(localBest, node) {
  var key = tacticalKey(node.state);
  var prev = localBest.get(key);
  if (prev !== undefined) {
    var ps = prev.node.state, cs = node.state;
    if (ps.pv > cs.pv || (ps.pv === cs.pv && prev.node.depth <= node.depth)) {
      return { dominated: true, replace: false, previous: prev };
    }
    return { dominated: false, replace: true, previous: prev };
  }
  return { dominated: false, replace: false, previous: null };
}

function rememberLocalCandidate(localBest, node, exactKey) {
  localBest.set(tacticalKey(node.state), { node: node, exactKey: exactKey });
}

function isUselessEndTurn(parentState, action, childState) {
  // Finir un tour avec déjà 10 PA et 0 double utilisé ne fait que perdre 1 PV
  // et incrémenter le tour ; la TT le couperait aussi, mais ce compteur est plus lisible.
  return action && action.kind === "end" &&
         parentState.pa === DEFAULT_PA && parentState.doubles === 0 &&
         childState.player === parentState.player &&
         childState.pa === parentState.pa && childState.doubles === parentState.doubles &&
         childState.pv < parentState.pv &&
         sameFireSet(childState.enemies, parentState.enemies);
}

function isRecentCycleDominated(parentNode, childState, maxBack) {
  var posKey = positionEnemyKey(childState);
  var depthLeft = maxBack == null ? 24 : maxBack;
  for (var n = parentNode; n !== null && depthLeft-- > 0; n = n.parent) {
    var st = n.state;
    if (positionEnemyKey(st) !== posKey) continue;
    // Même position + mêmes feux. Si on revient avec moins bien ou égal en ressources,
    // la boucle ne peut pas améliorer le plan.
    if (st.pv >= childState.pv && st.pa >= childState.pa && st.doubles <= childState.doubles) {
      return true;
    }
  }
  return false;
}

function shouldPruneChildV22(node, action, childNode, tt, stats) {
  var st = node.state;
  var child = childNode.state;

  if (isUselessEndTurn(st, action, child)) {
    stats.pruned_useless_end_turn++;
    return { prune: true, reason: "USELESS_END_TURN" };
  }

  if (isRecentCycleDominated(node, child, 24)) {
    stats.pruned_recent_cycle++;
    return { prune: true, reason: "RECENT_CYCLE_DOMINATED" };
  }

  var ttRes = ttDominates(tt, childNode);
  if (ttRes.dominated) {
    stats.pruned_tt_dominated++;
    return { prune: true, reason: ttRes.reason };
  }
  return { prune: false, reason: ttRes.reason };
}


function clampNumber(v, lo, hi, fallback) {
  if (typeof v !== "number" || !isFinite(v)) v = fallback;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
function makeDiversityOptions(ctx) {
  return {
    enabled: ctx.diversityEnabled !== false,
    elite_ratio: clampNumber(ctx.diversityEliteRatio, 0.25, 0.95, DIVERSITY_ELITE_RATIO_DEFAULT),
    min_bucket_slots: DIVERSITY_MIN_BUCKET_SLOTS
  };
}
function playerSectorKey(cell, ctx) {
  var x = cell % ctx.W, y = (cell / ctx.W) | 0;
  var sx = Math.max(0, Math.min(3, Math.floor(x / Math.max(1, ctx.W / 4))));
  var sy = Math.max(0, Math.min(3, Math.floor(y / Math.max(1, ctx.H / 4))));
  return sx + ":" + sy;
}
function nearestEnemyKeyForDiversity(state, ctx) {
  if (!state.enemies || state.enemies.size === 0) return "none";
  var W = ctx.W, px = state.player % W, py = (state.player / W) | 0;
  var best = null, bestD = Infinity;
  for (var e of state.enemies) {
    var ex = e % W, ey = (e / W) | 0;
    var d = Math.abs(px - ex) + Math.abs(py - ey);
    if (d < bestD || (d === bestD && e < best)) { bestD = d; best = e; }
  }
  // On bucketise par position relative et distance plutôt que par id exact :
  // assez diversifié, mais pas au point de diluer toute la qualité du beam.
  var ex2 = best % W, ey2 = (best / W) | 0;
  var qx = ex2 > px ? "E" : ex2 < px ? "W" : "C";
  var qy = ey2 > py ? "S" : ey2 < py ? "N" : "C";
  var db = bestD <= 2 ? "d0" : bestD <= 5 ? "d1" : bestD <= 9 ? "d2" : "d3";
  return qx + qy + ":" + db;
}
function actionKindKey(action) {
  return action && action.kind ? action.kind : "root";
}
function metricBucket(v, cuts) {
  for (var i = 0; i < cuts.length; i++) if (v <= cuts[i]) return String(i);
  return String(cuts.length);
}
function diversityKey(node, ctx) {
  if (node._divKey !== undefined) return node._divKey;
  var s = node.state;
  var m = node.score_metrics || tacticalStateMetrics(s, ctx);
  var k = [
    "E" + s.enemies.size,
    "P" + playerSectorKey(s.player, ctx),
    "N" + nearestEnemyKeyForDiversity(s, ctx),
    "A" + actionKindKey(node.action),
    "PA" + metricBucket(s.pa, [0, 2, 5, 8]),
    "D" + s.doubles,
    "K" + metricBucket(m.kill_targets || 0, [0, 1, 2, 4]),
    "M" + metricBucket(m.mobility_rough || 0, [1, 3, 6, 10])
  ].join("|");
  node._divKey = k;
  return k;
}
function nodeSelectionKey(node) {
  // V61 : cette clé est appelée plusieurs fois par la sélection multi-lanes.
  // Elle est déterministe pour un node donné, donc on la mémoïse localement
  // sans changer l'ordre ni les règles de sélection.
  if (!node) return "";
  if (node._selectionKeyV61 !== undefined) return node._selectionKeyV61;
  // Les stateKey sont déjà uniques après dédup exacte, mais l'action protège les cas
  // d'objets différents pointant vers un même état pendant la sélection.
  node._selectionKeyV61 = stateKey(node.state) + "\u0002" + actionKindKey(node.action);
  return node._selectionKeyV61;
}
function selectBeamV24(cands, beamWidth, ctx, stats) {
  var opts = makeDiversityOptions(ctx);
  if (!opts.enabled || cands.length <= beamWidth) {
    stats.diversity_enabled = opts.enabled;
    stats.diversity_mode = cands.length <= beamWidth ? "all_candidates_fit" : "disabled";
    stats.diversity_elite_quota = Math.min(beamWidth, cands.length);
    stats.diversity_bucket_quota = 0;
    stats.diversity_buckets_seen = 0;
    stats.diversity_selected_elite = Math.min(beamWidth, cands.length);
    stats.diversity_selected_bucket = 0;
    stats.diversity_selected_fill = 0;
    return cands.slice(0, beamWidth);
  }

  var eliteQuota = Math.floor(beamWidth * opts.elite_ratio);
  var bucketQuota = beamWidth - eliteQuota;
  if (bucketQuota < opts.min_bucket_slots && beamWidth > opts.min_bucket_slots) {
    bucketQuota = opts.min_bucket_slots;
    eliteQuota = beamWidth - bucketQuota;
  }
  if (eliteQuota < 1) eliteQuota = 1;
  if (bucketQuota < 0) bucketQuota = 0;

  var selected = [];
  var selectedKeys = new Set();
  var selectedBuckets = new Set();
  var allBuckets = new Set();
  var bucketSelected = 0;

  function addNode(n) {
    var k = nodeSelectionKey(n);
    if (selectedKeys.has(k)) return false;
    selectedKeys.add(k);
    selected.push(n);
    selectedBuckets.add(diversityKey(n, ctx));
    return true;
  }

  for (var i = 0; i < cands.length && selected.length < eliteQuota; i++) {
    allBuckets.add(diversityKey(cands[i], ctx));
    addNode(cands[i]);
  }

  // Passe diversité : premier meilleur représentant d'un bucket non encore présent.
  for (var j = 0; j < cands.length && bucketSelected < bucketQuota && selected.length < beamWidth; j++) {
    var bk = diversityKey(cands[j], ctx);
    allBuckets.add(bk);
    if (selectedBuckets.has(bk)) continue;
    if (addNode(cands[j])) bucketSelected++;
  }

  // Complément qualité pure si la diversité n'a pas rempli le quota.
  var fillSelected = 0;
  for (var k2 = 0; k2 < cands.length && selected.length < beamWidth; k2++) {
    allBuckets.add(diversityKey(cands[k2], ctx));
    if (addNode(cands[k2])) fillSelected++;
  }

  stats.diversity_enabled = true;
  stats.diversity_mode = "elite_plus_buckets";
  stats.diversity_elite_ratio = opts.elite_ratio;
  stats.diversity_elite_quota = eliteQuota;
  stats.diversity_bucket_quota = bucketQuota;
  stats.diversity_buckets_seen = allBuckets.size;
  stats.diversity_buckets_kept = selectedBuckets.size;
  stats.diversity_selected_elite = Math.min(eliteQuota, selected.length);
  stats.diversity_selected_bucket = bucketSelected;
  stats.diversity_selected_fill = fillSelected;
  return selected;
}



// ============================================================
// V38A BEAM CLEAN — MULTI-LANES + LINE PLANNING
// ------------------------------------------------------------
// Pas un rescue beam : la sélection protège dès le début plusieurs familles
// de branches utiles. Les règles de simulation restent inchangées.
// L'idée forte validée en jeu : former une longue ligne de feux pour pouvoir
// ensuite les consommer en série.
// ============================================================
function v38LineMetricsCached(node, ctx) {
  if (!node) return {};
  if (!node._v38_line_metrics) node._v38_line_metrics = fireLineMetrics(node.state, ctx);
  return node._v38_line_metrics || {};
}
function v38Metric(node, ctx, key) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  if (m && m[key] != null) return m[key] || 0;
  var lm = v38LineMetricsCached(node, ctx);
  return lm[key] || 0;
}

function v38ActionProbeCached(node, ctx) {
  if (!node) return null;
  if (!node._v38_action_probe) node._v38_action_probe = v34ActionProbe(node.state, ctx);
  return node._v38_action_probe;
}
function v38LinePlanningScore(node, ctx) {
  if (!node) return -Infinity;
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var p = v38ActionProbeCached(node, ctx) || {};
  var legalKills = p.legal_kill_targets || 0;
  var roughKills = m.kill_targets || 0;
  var falseKills = Math.max(0, roughKills - legalKills);
  var blockedKills = p.blocked_kill_targets || 0;
  var legalNonEnd = p.legal_non_end_count || 0;
  var legalCount = p.legal_count || 0;
  var enemies = node.state.enemies.size;
  var pv = node.state.pv;
  var lineRay = v38Metric(node, ctx, "max_fire_line_ray");
  var lineGlobal = v38Metric(node, ctx, "max_fire_line_global");
  var align = v38Metric(node, ctx, "fire_alignment_score");
  var density2 = v38Metric(node, ctx, "local_density_cheb2");
  var adjacent = v38Metric(node, ctx, "adjacent_density");

  var score = node.score || 0;
  score += lineRay * 9500;
  score += lineGlobal * 2800;
  score += Math.min(260, align) * 150;
  score += legalKills * 13000;
  score += Math.min(10, legalNonEnd) * 1800;
  score += Math.min(12, legalCount) * 700;
  score -= falseKills * 5200;
  score -= blockedKills * 4200;
  score -= Math.max(0, density2 - 2) * 4200;
  score -= adjacent * 6500;
  score += Math.min(28, pv) * 520;

  // Dès que la ligne commence à devenir exploitable, on accepte de garder
  // des branches un peu moins bonnes au score court-terme.
  if (lineRay >= 8) score += 30000;
  else if (lineRay >= 6) score += 18000;
  else if (lineRay >= 4) score += 7500;
  if (legalCount === 0 && enemies > 0) score -= 60000;
  if (pv <= 2 && enemies > 8 && lineRay < 5) score -= 18000;
  return score;
}
function v38LineShapeScore(node, ctx) {
  // Score peu coûteux : aucune probe d'actions. Utilisé pour les grandes fenêtres
  // de sélection afin de ne pas dépenser tout le budget dans l'analyse du beam.
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var enemies = node.state.enemies.size;
  var pv = node.state.pv;
  var score = node.score || 0;
  score += v38Metric(node, ctx, "max_fire_line_ray") * 11000;
  score += v38Metric(node, ctx, "max_fire_line_global") * 3000;
  score += Math.min(260, v38Metric(node, ctx, "fire_alignment_score")) * 160;
  score += (m.mobility_rough || 0) * 700;
  score += Math.min(28, pv) * 420;
  score -= Math.max(0, v38Metric(node, ctx, "local_density_cheb2") - 2) * 5200;
  score -= v38Metric(node, ctx, "adjacent_density") * 7000;
  score -= enemies * 1200;
  return score;
}

function v38SurvivalShapeScore(node, ctx) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  return (node.score || 0) +
    (node.state.pv || 0) * 2200 +
    (m.mobility_rough || 0) * 4200 +
    (m.rough_safe_empty_landings || 0) * 2600 +
    v38Metric(node, ctx, "max_fire_line_ray") * 1800 -
    v38Metric(node, ctx, "adjacent_density") * 9000 -
    Math.max(0, v38Metric(node, ctx, "local_density_cheb2") - 2) * 3600;
}

function v38SurvivalScore(node, ctx) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var p = v38ActionProbeCached(node, ctx) || {};
  return (node.score || 0) +
    (node.state.pv || 0) * 2200 +
    (m.mobility_rough || 0) * 4200 +
    (m.rough_safe_empty_landings || 0) * 2600 +
    (p.legal_non_end_count || 0) * 1200 -
    v38Metric(node, ctx, "adjacent_density") * 9000 -
    Math.max(0, v38Metric(node, ctx, "local_density_cheb2") - 2) * 3600;
}
function v38KillScore(node, ctx) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var p = v38ActionProbeCached(node, ctx) || {};
  var falseKills = Math.max(0, (m.kill_targets || 0) - (p.legal_kill_targets || 0));
  return (node.score || 0) +
    (p.legal_kill_targets || 0) * 24000 +
    (p.legal_non_end_count || 0) * 2200 -
    falseKills * 10000 -
    (p.blocked_kill_targets || 0) * 7000 +
    v38Metric(node, ctx, "max_fire_line_ray") * 2600;
}
function v38LowEnemyScore(node, ctx) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  return (node.score || 0) -
    node.state.enemies.size * 18000 +
    (node.state.pv || 0) * 1600 +
    (m.mobility_rough || 0) * 2500 +
    v38Metric(node, ctx, "max_fire_line_ray") * 3500;
}

// V43 : lane “chercher le prochain kill”.
// La version légère vient du score d'état. La version profonde, appelée seulement
// sur une fenêtre bornée du beam, vérifie si une action légale crée un kill légal
// au coup suivant.
function v42NextKillSeedScore(node, ctx) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var nk = m.next_kill_seek || {};
  var minDist = nk.min_dist == null ? (m.min_dist == null ? 99 : m.min_dist) : nk.min_dist;
  return (node.score || 0) +
    (nk.geometric_kill_targets || 0) * 62000 +
    (nk.geometric_kill_astral || 0) * 11000 +
    (nk.geometric_kill_double || 0) * 8000 +
    (nk.mobility || m.mobility_rough || 0) * 2500 +
    (nk.safe_landings || m.rough_safe_empty_landings || 0) * 1600 +
    (nk.line_ray || v38Metric(node, ctx, "max_fire_line_ray")) * 2600 -
    Math.max(0, minDist - 1) * 5200;
}
function v42NextKillLookaheadCached(node, ctx) {
  if (!node) return null;
  if (node._v42_next_kill_probe) return node._v42_next_kill_probe;
  var st = node.state;
  var m = node.score_metrics || tacticalStateMetrics(st, ctx);
  var baseProbe = v38ActionProbeCached(node, ctx) || {};
  var out = {
    immediate_legal_kills: baseProbe.legal_kill_targets || 0,
    blocked_kill_targets: baseProbe.blocked_kill_targets || 0,
    legal_non_end_count: baseProbe.legal_non_end_count || 0,
    best_child_legal_kills: 0,
    setup_action_count: 0,
    best_child_non_end_count: 0,
    best_child_score: -Infinity,
    best_child_min_dist: m.min_dist == null ? Infinity : m.min_dist,
    best_dist_gain: 0,
    best_child_mobility: 0,
    best_child_safe_landings: 0
  };
  var beforeMin = m.min_dist == null ? Infinity : m.min_dist;
  // Si un kill existe déjà, le rôle du lookahead est surtout de confirmer la conversion.
  // Sinon, on inspecte les placements légaux non létaux pour trouver un kill légal au coup suivant.
  var acts = enumerateActions(st);
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
    if (a.kind === "end" && st.turn >= 7 && st.pa > 2) continue;
    var sim = simulateActionDetailed(st, a, ctx);
    if (!sim.ok || !sim.state) continue;
    if (sim.effects && sim.effects.killed) continue;
    if (a.kind === "end" && st.turn >= 7) continue;
    var cm = tacticalStateMetrics(sim.state, ctx);
    // Approximation volontaire : on mesure les cibles géométriques créées au coup
    // suivant. La légalité exacte sera vérifiée par le beam lors de l'expansion
    // réelle ; ici on veut surtout préserver les branches prometteuses sans exploser
    // le temps de calcul.
    var childKills = cm.kill_targets || 0;
    if (childKills > 0) out.setup_action_count++;
    if (childKills > out.best_child_legal_kills) out.best_child_legal_kills = childKills;
    if ((cm.mobility_rough || 0) > out.best_child_non_end_count) out.best_child_non_end_count = cm.mobility_rough || 0;
    var childMin = cm.min_dist == null ? Infinity : cm.min_dist;
    if (childMin < out.best_child_min_dist) out.best_child_min_dist = childMin;
    var gain = (beforeMin === Infinity || childMin === Infinity) ? 0 : beforeMin - childMin;
    if (gain > out.best_dist_gain) out.best_dist_gain = gain;
    if ((cm.mobility_rough || 0) > out.best_child_mobility) out.best_child_mobility = cm.mobility_rough || 0;
    if ((cm.rough_safe_empty_landings || 0) > out.best_child_safe_landings) out.best_child_safe_landings = cm.rough_safe_empty_landings || 0;
    var childScore = childKills * 50000 +
      (cm.mobility_rough || 0) * 2600 +
      Math.max(-2, Math.min(5, gain)) * 4500 +
      (cm.mobility_rough || 0) * 1200 +
      (cm.rough_safe_empty_landings || 0) * 900 -
      Math.max(0, v38Metric({state: sim.state, score_metrics: cm}, ctx, "adjacent_density")) * 5500;
    if (childScore > out.best_child_score) out.best_child_score = childScore;
  }
  if (out.best_child_score === -Infinity) out.best_child_score = 0;
  node._v42_next_kill_probe = out;
  return out;
}
function v42NextKillDeepScore(node, ctx) {
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var nk = m.next_kill_seek || {};
  var p = v42NextKillLookaheadCached(node, ctx) || {};
  var score = node.score || 0;
  score += (p.immediate_legal_kills || 0) * 90000;
  score += (p.best_child_legal_kills || 0) * 62000;
  score += (p.setup_action_count || 0) * 12000;
  score += (p.best_child_non_end_count || 0) * 2400;
  score += Math.max(-2, Math.min(5, p.best_dist_gain || nk.best_dist_gain || 0)) * 5200;
  score += (p.best_child_mobility || 0) * 1500;
  score += (p.best_child_safe_landings || 0) * 1100;
  score += v38Metric(node, ctx, "max_fire_line_ray") * 2200;
  score -= (p.blocked_kill_targets || 0) * 11000;
  if ((p.immediate_legal_kills || 0) === 0 && (p.best_child_legal_kills || 0) === 0) score -= 36000;
  if ((m.mobility_rough || 0) <= 2 && (p.best_child_legal_kills || 0) === 0) score -= 18000;
  return score;
}

function v38SelectionScore(node, ctx) {
  // Score d'ordre final du beam, volontairement peu coûteux.
  // V38A initial appelait v38ActionProbeCached ici, ce qui probait jusqu'à
  // beamWidth nœuds par profondeur et vidait le budget temps avant la profondeur utile.
  var m = node.score_metrics || tacticalStateMetrics(node.state, ctx);
  var base = v38LineShapeScore(node, ctx);
  base += (m.mobility_rough || 0) * 900;
  base -= Math.max(0, v38Metric(node, ctx, "local_density_cheb2") - 2) * 1800;
  return base;
}
function v61BeamScoreCacheKey(fn) {
  return (fn && (fn._v61_cache_key || fn.name)) || "anonymous_lane";
}
function v61CachedBeamScore(node, ctx, fn) {
  if (!node || !fn) return -Infinity;
  if (ctx && ctx.beamSelectionCacheV61 === false) return fn(node, ctx);
  var key = v61BeamScoreCacheKey(fn);
  var cache = node._beamSelectionScoresV61;
  if (!cache) cache = node._beamSelectionScoresV61 = Object.create(null);
  if (cache[key] === undefined) cache[key] = fn(node, ctx);
  return cache[key];
}
function v38SortBy(fn, ctx) {
  return function (a, b) {
    var av = v61CachedBeamScore(a, ctx, fn), bv = v61CachedBeamScore(b, ctx, fn);
    if (av !== bv) return bv - av;
    if (a.state.enemies.size !== b.state.enemies.size) return a.state.enemies.size - b.state.enemies.size;
    if (a.state.pv !== b.state.pv) return b.state.pv - a.state.pv;
    return b.score - a.score;
  };
}
function selectBeamV38(cands, beamWidth, ctx, stats, depth) {
  if (!ctx.v38MultiLane) {
    var baseOnly = selectBeamV24(cands, beamWidth, ctx, stats);
    stats.v38_enabled = false;
    stats.v38_mode = "disabled_fallback_v24";
    return baseOnly;
  }
  if (cands.length <= beamWidth) {
    stats.diversity_enabled = ctx.diversityEnabled !== false;
    stats.diversity_mode = "all_candidates_fit";
    stats.diversity_selected_elite = cands.length;
    stats.v38_enabled = true;
    stats.v38_mode = "all_candidates_fit";
    return cands.slice(0, beamWidth);
  }

  // V38A.1 : garde-fou performance.
  // La V38A initiale triait une très grande fenêtre avec des probes d'actions
  // coûteuses ; elle explorait trop peu profond et pouvait tomber à 0%.
  // Ici, on repart du beam V24 éprouvé, puis on remplace seulement une petite
  // tranche par des lanes peu coûteuses orientées ligne/survie/peu d'ennemis.
  var selected = [];
  var seen = new Set();
  function addNode(n, tag) {
    if (!n || selected.length >= beamWidth) return false;
    var k = nodeSelectionKey(n);
    if (seen.has(k)) return false;
    seen.add(k);
    selected.push(n);
    if (tag) stats[tag] = (stats[tag] || 0) + 1;
    return true;
  }
  function addTop(sorted, quota, tag) {
    quota = Math.max(0, Math.floor(quota));
    for (var i = 0; i < sorted.length && (stats[tag] || 0) < quota && selected.length < beamWidth; i++) addNode(sorted[i], tag);
  }

  var nextKillEnabled = ctx.nextKillSeekScore === true;
  var laneProfile = ctx.v44LaneProfile || (ctx.v44StochasticProfile || 'default');
  var ratios = { base: nextKillEnabled ? 0.70 : 0.78, line: nextKillEnabled ? 0.08 : 0.10, survival: 0.05, lowEnemy: 0.04, nextKill: nextKillEnabled ? 0.10 : 0, tail: 0.03 };
  if (laneProfile === 'survival') {
    ratios = { base: 0.70, line: 0.07, survival: 0.12, lowEnemy: 0.05, nextKill: 0, tail: 0.04 };
  } else if (laneProfile === 'line') {
    ratios = { base: 0.68, line: 0.18, survival: 0.04, lowEnemy: 0.04, nextKill: 0, tail: 0.04 };
  } else if (laneProfile === 'conversion') {
    ratios = { base: 0.68, line: 0.08, survival: 0.05, lowEnemy: 0.08, nextKill: nextKillEnabled ? 0.07 : 0, tail: 0.04 };
  } else if (laneProfile === 'line_conversion') {
    ratios = { base: 0.64, line: 0.15, survival: 0.04, lowEnemy: 0.09, nextKill: nextKillEnabled ? 0.04 : 0, tail: 0.04 };
  } else if (laneProfile === 'line_survival') {
    ratios = { base: 0.64, line: 0.14, survival: 0.11, lowEnemy: 0.04, nextKill: 0, tail: 0.04 };
  } else if (laneProfile === 'conversion_t6') {
    ratios = { base: 0.65, line: 0.08, survival: 0.06, lowEnemy: 0.09, nextKill: 0, tail: 0.04 };
  } else if (laneProfile === 't6') {
    ratios = { base: 0.69, line: 0.08, survival: 0.07, lowEnemy: 0.05, nextKill: 0, tail: 0.04 };
  }
  var baseQuota = Math.max(1, Math.floor(beamWidth * ratios.base));
  var lineQuota = Math.max(1, Math.floor(beamWidth * ratios.line));
  var survivalQuota = Math.max(1, Math.floor(beamWidth * ratios.survival));
  var lowEnemyQuota = Math.max(1, Math.floor(beamWidth * ratios.lowEnemy));
  var nextKillQuota = nextKillEnabled && ratios.nextKill > 0 ? Math.max(1, Math.floor(beamWidth * ratios.nextKill)) : 0;
  var tailQuota = Math.max(1, Math.floor(beamWidth * ratios.tail));
  stats.v44_lane_profile = laneProfile;

  // On utilise V24 comme socle, pas comme concurrent. Cela conserve la robustesse
  // observée en benchmark et limite le changement à la composition du beam.
  var baseStats = {};
  var base = selectBeamV24(cands, baseQuota, ctx, baseStats);
  for (var bi = 0; bi < base.length; bi++) addNode(base[bi], "v38_selected_elite");

  var windowSize = Math.min(cands.length, Math.max(beamWidth, Math.floor(beamWidth * 1.8)));
  var window = cands.slice(0, windowSize);
  addTop(window.slice().sort(v38SortBy(v38LineShapeScore, ctx)), lineQuota, "v38_selected_line");
  if (nextKillEnabled && nextKillQuota > 0 && selected.length < beamWidth) {
    var nkTopN = Math.max(24, Math.min(window.length, ctx.nextKillProbeTopN || 120));
    var nkWindow = window.slice().sort(v38SortBy(v42NextKillSeedScore, ctx)).slice(0, nkTopN);
    addTop(nkWindow.slice().sort(v38SortBy(v42NextKillDeepScore, ctx)), nextKillQuota, "v42_selected_next_kill");
    stats.v42_next_kill_enabled = true;
    stats.v42_next_kill_probe_top_n = nkTopN;
  } else {
    stats.v42_next_kill_enabled = nextKillEnabled;
    stats.v42_next_kill_probe_top_n = null;
  }
  addTop(window.slice().sort(v38SortBy(v38SurvivalShapeScore, ctx)), survivalQuota, "v38_selected_survival");
  addTop(window.slice().sort(v38SortBy(v38LowEnemyScore, ctx)), lowEnemyQuota, "v38_selected_low_enemy");

  var stride = Math.max(1, Math.floor(cands.length / Math.max(1, tailQuota * 3)));
  for (var di = 0; di < cands.length && (stats.v38_selected_deep_tail || 0) < tailQuota && selected.length < beamWidth; di += stride) {
    addNode(cands[di], "v38_selected_deep_tail");
  }
  for (var f = 0; f < cands.length && selected.length < beamWidth; f++) addNode(cands[f], "v38_selected_score_fill");

  // Important : on garde l'ordre par score de recherche pour ne pas transformer
  // le solveur en pur "line seeker". Les lanes servent à préserver des branches,
  // pas à remplacer le critère principal.
  selected.sort(function (a, b) {
    if (a.negScore !== b.negScore) return a.negScore - b.negScore;
    return v61CachedBeamScore(b, ctx, v38SelectionScore) - v61CachedBeamScore(a, ctx, v38SelectionScore);
  });

  stats.diversity_enabled = ctx.diversityEnabled !== false;
  stats.diversity_mode = "v38_light_multilane_v24_base";
  stats.diversity_elite_ratio = ctx.diversityEliteRatio;
  stats.v38_enabled = true;
  stats.v38_mode = "beam_clean_light_multilane";
  stats.v38_probe_top_n = 0;
  stats.v38_window_size = windowSize;
  stats.v38_deep_stride = stride;
  stats.v38_best_line_score = selected.length ? v61CachedBeamScore(selected[0], ctx, v38SelectionScore) : null;
  stats.v61_beam_selection_cache = ctx.beamSelectionCacheV61 !== false;
  stats.v61_mode = ctx.beamSelectionCacheV61 !== false ? "cached_lane_scores_and_selection_keys" : "disabled";
  return selected;
}


// ============================================================
// V34 SEARCH DEBUGGER + PARETO PROBE
// ------------------------------------------------------------
// Instrumentation uniquement : ces fonctions ne modifient ni la simulation,
// ni les règles, ni le scoring. Elles expliquent la frontière de recherche.
// ============================================================
function v34SmallRejectSummary(byReason) {
  var out = [];
  Object.keys(byReason || {}).sort(function (a, b) { return (byReason[b] || 0) - (byReason[a] || 0); }).forEach(function (k) {
    out.push({ reason: k, count: byReason[k] || 0 });
  });
  return out;
}

function v34ActionProbe(state, ctx) {
  var acts = enumerateActions(state);
  var out = {
    all_count: acts.length,
    legal_count: 0,
    rejected_count: 0,
    legal_non_end_count: 0,
    legal_by_kind: {},
    rejected_by_kind: {},
    rejected_by_reason: {},
    legal_kill_targets: 0,
    legal_kill_actions: [],
    blocked_kill_targets: 0,
    blocked_kill_reasons: {},
    blocked_kill_examples: []
  };
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
    var sim = simulateActionDetailed(state, a, ctx);
    if (sim.ok) {
      out.legal_count++;
      incCounter(out.legal_by_kind, a.kind || "?");
      if (a.kind !== "end") out.legal_non_end_count++;
      if (sim.effects && sim.effects.killed) {
        out.legal_kill_targets++;
        if (out.legal_kill_actions.length < 8) {
          out.legal_kill_actions.push({ action: actionLabel(a, state, ctx), killed: sim.effects.killed });
        }
      }
    } else {
      out.rejected_count++;
      incCounter(out.rejected_by_kind, a.kind || "?");
      var rr = sim.rejectReason || sim.reason || "REJECTED";
      incCounter(out.rejected_by_reason, rr);
      if (sim.effects && sim.effects.killed) {
        out.blocked_kill_targets++;
        incCounter(out.blocked_kill_reasons, rr);
        if (out.blocked_kill_examples.length < 6) {
          out.blocked_kill_examples.push({ action: actionLabel(a, state, ctx), killed: sim.effects.killed, reject_reason: rr, details: sim.details || {} });
        }
      }
    }
  }
  out.rejected_summary = v34SmallRejectSummary(out.rejected_by_reason);
  out.blocked_kill_summary = v34SmallRejectSummary(out.blocked_kill_reasons);
  return out;
}

function v34NodeLite(node, ctx, withProbe) {
  if (!node) return null;
  var st = node.state;
  var metrics = node.score_metrics || tacticalStateMetrics(st, ctx);
  var probe = withProbe ? v34ActionProbe(st, ctx) : null;
  return {
    score: node.score,
    depth: node.depth,
    action: node.action ? actionLabel(node.action, node.parent ? node.parent.state : st, ctx) : "ROOT",
    state: summarizeStateLite(st, ctx),
    metrics: metrics,
    action_probe: probe ? {
      legal_count: probe.legal_count,
      legal_non_end_count: probe.legal_non_end_count,
      legal_kill_targets: probe.legal_kill_targets,
      blocked_kill_targets: probe.blocked_kill_targets,
      blocked_kill_summary: probe.blocked_kill_summary,
      rejected_summary: probe.rejected_summary,
      legal_by_kind: probe.legal_by_kind,
      rejected_by_kind: probe.rejected_by_kind
    } : null
  };
}

function v34BetterBy(a, b, cmp) {
  if (!a) return b;
  if (!b) return a;
  return cmp(a, b) <= 0 ? a : b;
}

function v34CollectProbeNodes(sortedCands, selected, ctx) {
  var topN = Math.max(20, Math.min(500, ctx.paretoProbeTopN || 120));
  var map = new Map();
  function add(n) {
    if (!n) return;
    var k = stateKey(n.state) + "\u0002" + n.depth + "\u0002" + Math.round(n.score || 0);
    if (!map.has(k)) map.set(k, n);
  }
  for (var i = 0; i < sortedCands.length && i < topN; i++) add(sortedCands[i]);
  if (selected) for (var s = 0; s < selected.length && s < topN; s++) add(selected[s]);
  var bestEnemies = null, bestPv = null, bestMob = null, bestKills = null, bestSafe = null, bestScore = sortedCands[0] || null;
  for (var j = 0; j < sortedCands.length; j++) {
    var n = sortedCands[j], m = n.score_metrics || tacticalStateMetrics(n.state, ctx);
    bestEnemies = v34BetterBy(bestEnemies, n, function (x, y) {
      var mx = x.score_metrics || tacticalStateMetrics(x.state, ctx), my = y.score_metrics || tacticalStateMetrics(y.state, ctx);
      if (mx.effective_enemies !== my.effective_enemies) return mx.effective_enemies - my.effective_enemies;
      if (x.state.pv !== y.state.pv) return y.state.pv - x.state.pv;
      return y.score - x.score;
    });
    bestPv = v34BetterBy(bestPv, n, function (x, y) { if (x.state.pv !== y.state.pv) return y.state.pv - x.state.pv; return x.state.enemies.size - y.state.enemies.size; });
    bestMob = v34BetterBy(bestMob, n, function (x, y) {
      var mx = x.score_metrics || tacticalStateMetrics(x.state, ctx), my = y.score_metrics || tacticalStateMetrics(y.state, ctx);
      if ((mx.mobility_rough || 0) !== (my.mobility_rough || 0)) return (my.mobility_rough || 0) - (mx.mobility_rough || 0);
      return x.state.enemies.size - y.state.enemies.size;
    });
    bestKills = v34BetterBy(bestKills, n, function (x, y) {
      var mx = x.score_metrics || tacticalStateMetrics(x.state, ctx), my = y.score_metrics || tacticalStateMetrics(y.state, ctx);
      if ((mx.kill_targets || 0) !== (my.kill_targets || 0)) return (my.kill_targets || 0) - (mx.kill_targets || 0);
      return x.state.enemies.size - y.state.enemies.size;
    });
    bestSafe = v34BetterBy(bestSafe, n, function (x, y) {
      var mx = x.score_metrics || tacticalStateMetrics(x.state, ctx), my = y.score_metrics || tacticalStateMetrics(y.state, ctx);
      if ((mx.rough_safe_empty_landings || 0) !== (my.rough_safe_empty_landings || 0)) return (my.rough_safe_empty_landings || 0) - (mx.rough_safe_empty_landings || 0);
      return x.state.enemies.size - y.state.enemies.size;
    });
    if (j >= topN * 6 && bestEnemies && bestPv && bestMob && bestKills && bestSafe) break;
  }
  [bestScore, bestEnemies, bestPv, bestMob, bestKills, bestSafe].forEach(add);
  return Array.from(map.values());
}

function v34DominatesLite(a, b, ctx) {
  var ma = a.score_metrics || tacticalStateMetrics(a.state, ctx), mb = b.score_metrics || tacticalStateMetrics(b.state, ctx);
  var ak = a._v34_probe ? a._v34_probe.legal_kill_targets : (ma.kill_targets || 0);
  var bk = b._v34_probe ? b._v34_probe.legal_kill_targets : (mb.kill_targets || 0);
  var aMob = ma.mobility_rough || 0, bMob = mb.mobility_rough || 0;
  var betterOrEqual = ma.effective_enemies <= mb.effective_enemies && a.state.pv >= b.state.pv && aMob >= bMob && ak >= bk;
  var strictly = ma.effective_enemies < mb.effective_enemies || a.state.pv > b.state.pv || aMob > bMob || ak > bk || a.score > b.score;
  return betterOrEqual && strictly;
}

function v34ParetoFront(sample, ctx) {
  var front = [];
  for (var i = 0; i < sample.length; i++) {
    var n = sample[i], dominated = false;
    for (var j = 0; j < sample.length; j++) {
      if (i === j) continue;
      if (v34DominatesLite(sample[j], n, ctx)) { dominated = true; break; }
    }
    if (!dominated) front.push(n);
  }
  front.sort(function (a, b) {
    var ma = a.score_metrics || tacticalStateMetrics(a.state, ctx), mb = b.score_metrics || tacticalStateMetrics(b.state, ctx);
    if (ma.effective_enemies !== mb.effective_enemies) return ma.effective_enemies - mb.effective_enemies;
    if (a.state.pv !== b.state.pv) return b.state.pv - a.state.pv;
    return b.score - a.score;
  });
  return front;
}

function buildV34ParetoProbe(cands, selected, ctx, stats) {
  var sample = v34CollectProbeNodes(cands || [], selected || [], ctx);
  for (var i = 0; i < sample.length; i++) sample[i]._v34_probe = v34ActionProbe(sample[i].state, ctx);
  var front = v34ParetoFront(sample, ctx);
  function bestNode(cmp) {
    var best = null;
    for (var j = 0; j < sample.length; j++) best = v34BetterBy(best, sample[j], cmp);
    return best;
  }
  var byScore = (cands && cands[0]) || null;
  var byFires = bestNode(function (x, y) {
    var mx = x.score_metrics || tacticalStateMetrics(x.state, ctx), my = y.score_metrics || tacticalStateMetrics(y.state, ctx);
    if (mx.effective_enemies !== my.effective_enemies) return mx.effective_enemies - my.effective_enemies;
    if (x.state.pv !== y.state.pv) return y.state.pv - x.state.pv;
    return y.score - x.score;
  });
  var byPv = bestNode(function (x, y) { if (x.state.pv !== y.state.pv) return y.state.pv - x.state.pv; return x.state.enemies.size - y.state.enemies.size; });
  var byMob = bestNode(function (x, y) {
    var mx = x.score_metrics || tacticalStateMetrics(x.state, ctx), my = y.score_metrics || tacticalStateMetrics(y.state, ctx);
    if ((mx.mobility_rough || 0) !== (my.mobility_rough || 0)) return (my.mobility_rough || 0) - (mx.mobility_rough || 0);
    return x.state.enemies.size - y.state.enemies.size;
  });
  var byLegalKills = bestNode(function (x, y) {
    var px = x._v34_probe || { legal_kill_targets: 0 }, py = y._v34_probe || { legal_kill_targets: 0 };
    if (px.legal_kill_targets !== py.legal_kill_targets) return py.legal_kill_targets - px.legal_kill_targets;
    return x.state.enemies.size - y.state.enemies.size;
  });
  var blockedKillCount = 0, legalKillStates = 0, continuingStates = 0;
  for (var k = 0; k < sample.length; k++) {
    var pr = sample[k]._v34_probe || {};
    if ((pr.legal_kill_targets || 0) > 0) legalKillStates++;
    if ((pr.legal_non_end_count || 0) > 0) continuingStates++;
    blockedKillCount += pr.blocked_kill_targets || 0;
  }
  return {
    version: "V34_pareto_probe",
    candidate_count: cands ? cands.length : 0,
    selected_count: selected ? selected.length : 0,
    sampled_count: sample.length,
    pareto_front_count: front.length,
    legal_kill_states_sampled: legalKillStates,
    continuing_states_sampled: continuingStates,
    blocked_kill_targets_sampled: blockedKillCount,
    best_by_score: v34NodeLite(byScore, ctx, true),
    best_by_fires: v34NodeLite(byFires, ctx, true),
    best_by_pv: v34NodeLite(byPv, ctx, true),
    best_by_mobility: v34NodeLite(byMob, ctx, true),
    best_by_legal_kills: v34NodeLite(byLegalKills, ctx, true),
    pareto_front_top: front.slice(0, 10).map(function (n) { return v34NodeLite(n, ctx, true); })
  };
}

function v34SummarizeParetoTrace(depthStats) {
  var probes = [];
  for (var i = 0; i < (depthStats || []).length; i++) if (depthStats[i].v34_pareto_probe) probes.push(depthStats[i].v34_pareto_probe);
  if (!probes.length) return null;
  var bestEnemy = null, bestPvAtBestEnemy = null, maxPv = null, firstNoProgressDepth = null;
  var lastBestEnemies = null, stagnant = 0;
  for (var j = 0; j < depthStats.length; j++) {
    var ds = depthStats[j];
    if (ds.best_enemies_remaining != null) {
      if (bestEnemy == null || ds.best_enemies_remaining < bestEnemy) { bestEnemy = ds.best_enemies_remaining; bestPvAtBestEnemy = null; stagnant = 0; }
      else stagnant++;
      if (lastBestEnemies != null && ds.best_enemies_remaining >= lastBestEnemies) {
        if (stagnant >= 8 && firstNoProgressDepth == null) firstNoProgressDepth = ds.depth;
      }
      lastBestEnemies = ds.best_enemies_remaining;
    }
    if (ds.v34_pareto_probe && ds.v34_pareto_probe.best_by_fires) {
      var st = ds.v34_pareto_probe.best_by_fires.state || {};
      if (bestPvAtBestEnemy == null || (st.enemies_remaining === bestEnemy && st.pv > bestPvAtBestEnemy)) bestPvAtBestEnemy = st.pv;
    }
    if (ds.v34_pareto_probe && ds.v34_pareto_probe.best_by_pv) {
      var pv = ds.v34_pareto_probe.best_by_pv.state && ds.v34_pareto_probe.best_by_pv.state.pv;
      if (pv != null && (maxPv == null || pv > maxPv)) maxPv = pv;
    }
  }
  return {
    probe_count: probes.length,
    max_pareto_front_count: Math.max.apply(null, probes.map(function (p) { return p.pareto_front_count || 0; })),
    max_legal_kill_states_sampled: Math.max.apply(null, probes.map(function (p) { return p.legal_kill_states_sampled || 0; })),
    max_continuing_states_sampled: Math.max.apply(null, probes.map(function (p) { return p.continuing_states_sampled || 0; })),
    max_blocked_kill_targets_sampled: Math.max.apply(null, probes.map(function (p) { return p.blocked_kill_targets_sampled || 0; })),
    best_enemies_seen: bestEnemy,
    best_pv_at_best_enemies_seen: bestPvAtBestEnemy,
    max_pv_seen_in_probes: maxPv,
    first_stagnation_depth_estimate: firstNoProgressDepth
  };
}

function v34FinalStateProbe(res, ctx) {
  if (!res || !res.finalState) return null;
  var st = res.finalState;
  var ev = scoreStateDetailed(st, ctx);
  var probe = v34ActionProbe(st, ctx);
  return {
    state: summarizeStateLite(st, ctx),
    score: res.finalScore,
    metrics: ev.metrics,
    action_probe: probe,
    continuable: probe.legal_non_end_count > 0 || probe.legal_count > 0,
    dead_end: probe.legal_count === 0
  };
}

function makeRunSummary(depthStats, tt) {
  var sum = {
    tt_size: tt.byTactical.size,
    tt_stored: tt.stored,
    tt_replaced: tt.replaced,
    tt_dominated: tt.dominated,
    expanded_nodes: 0,
    generated_actions: 0,
    legal_actions: 0,
    rejected_actions: 0,
    pruned_tt_dominated: 0,
    pruned_useless_end_turn: 0,
    pruned_recent_cycle: 0,
    pruned_hp_bound_parent: 0,
    pruned_hp_bound_child: 0,
    dedup_dropped: 0,
    dedup_replaced: 0,
    diversity_enabled: null,
    diversity_mode: null,
    diversity_selected_bucket: 0,
    diversity_selected_fill: 0,
    diversity_buckets_seen_max: 0,
    diversity_buckets_kept_max: 0,
    diversity_elite_ratio: null,
    v38_enabled: false,
    v38_mode: null,
    v38_probe_top_n: null,
    v38_window_size_max: 0,
    v38_deep_stride_min: null,
    v38_selected_elite: 0,
    v38_selected_line: 0,
    v38_selected_kill: 0,
    v38_selected_survival: 0,
    v38_selected_low_enemy: 0,
    v38_selected_deep_tail: 0,
    v42_selected_next_kill: 0,
    v42_next_kill_enabled: false,
    v42_next_kill_probe_top_n_max: null,
    v44_lane_profile: null,
    v38_selected_diversity_fill: 0,
    v38_selected_score_fill: 0,
    v38_best_line_score_max: null
  };
  for (var i = 0; i < depthStats.length; i++) {
    var s = depthStats[i];
    sum.expanded_nodes += s.expanded_nodes || s.expanded || 0;
    sum.generated_actions += s.generated_actions || s.generated || 0;
    sum.legal_actions += s.legal_actions || s.legal || 0;
    sum.rejected_actions += s.rejected_actions || s.rejected || 0;
    sum.pruned_tt_dominated += s.pruned_tt_dominated || 0;
    sum.pruned_useless_end_turn += s.pruned_useless_end_turn || 0;
    sum.pruned_recent_cycle += s.pruned_recent_cycle || 0;
    sum.pruned_hp_bound_parent += s.pruned_hp_bound_parent || 0;
    sum.pruned_hp_bound_child += s.pruned_hp_bound_child || 0;
    sum.dedup_dropped += s.dedup_dropped || 0;
    sum.dedup_replaced += s.dedup_replaced || 0;
    sum.diversity_selected_bucket += s.diversity_selected_bucket || 0;
    sum.diversity_selected_fill += s.diversity_selected_fill || 0;
    if ((s.diversity_buckets_seen || 0) > sum.diversity_buckets_seen_max) sum.diversity_buckets_seen_max = s.diversity_buckets_seen || 0;
    if ((s.diversity_buckets_kept || 0) > sum.diversity_buckets_kept_max) sum.diversity_buckets_kept_max = s.diversity_buckets_kept || 0;
    if (s.diversity_enabled != null) sum.diversity_enabled = s.diversity_enabled;
    if (s.diversity_mode) sum.diversity_mode = s.diversity_mode;
    if (s.diversity_elite_ratio != null) sum.diversity_elite_ratio = s.diversity_elite_ratio;
    if (s.v38_enabled) sum.v38_enabled = true;
    if (s.v38_mode) sum.v38_mode = s.v38_mode;
    if (s.v38_probe_top_n != null) sum.v38_probe_top_n = s.v38_probe_top_n;
    if ((s.v38_window_size || 0) > sum.v38_window_size_max) sum.v38_window_size_max = s.v38_window_size || 0;
    if (s.v38_deep_stride != null && (sum.v38_deep_stride_min == null || s.v38_deep_stride < sum.v38_deep_stride_min)) sum.v38_deep_stride_min = s.v38_deep_stride;
    sum.v38_selected_elite += s.v38_selected_elite || 0;
    sum.v38_selected_line += s.v38_selected_line || 0;
    sum.v38_selected_kill += s.v38_selected_kill || 0;
    sum.v38_selected_survival += s.v38_selected_survival || 0;
    sum.v38_selected_low_enemy += s.v38_selected_low_enemy || 0;
    sum.v38_selected_deep_tail += s.v38_selected_deep_tail || 0;
    sum.v42_selected_next_kill += s.v42_selected_next_kill || 0;
    if (s.v42_next_kill_enabled) sum.v42_next_kill_enabled = true;
    if (s.v42_next_kill_probe_top_n != null && (sum.v42_next_kill_probe_top_n_max == null || s.v42_next_kill_probe_top_n > sum.v42_next_kill_probe_top_n_max)) sum.v42_next_kill_probe_top_n_max = s.v42_next_kill_probe_top_n;
    if (s.v44_lane_profile && !sum.v44_lane_profile) sum.v44_lane_profile = s.v44_lane_profile;
    sum.v38_selected_diversity_fill += s.v38_selected_diversity_fill || 0;
    sum.v38_selected_score_fill += s.v38_selected_score_fill || 0;
    if (s.v38_best_line_score != null && (sum.v38_best_line_score_max == null || s.v38_best_line_score > sum.v38_best_line_score_max)) sum.v38_best_line_score_max = s.v38_best_line_score;
  }
  var v34 = v34SummarizeParetoTrace(depthStats);
  if (v34) sum.search_debug_v34 = v34;
  return sum;
}


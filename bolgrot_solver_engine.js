/* bolgrot_solver_engine.js — Moteurs solveur, portfolio, LDS, replay/audit et config.
   V45 : profil sweep line / survival / conversion + hybrides. */




function effectiveTimeBudgetMsV58A1(payload, fallbackMs) {
  payload = payload || {};
  var raw = payload.timeBudgetMs != null ? Number(payload.timeBudgetMs) : fallbackMs;
  var budget = Math.max(1000, isFinite(raw) ? raw : fallbackMs);
  // Garde-fou uniquement pour la page finale utilisateur. Le Monte Carlo garde ses budgets configurables.
  if (payload.finalUserSolverV58A4 === true || payload.finalUserSolverV58A1 === true || payload.solverProfileId || payload.solverProfileName) {
    budget = Math.max(30000, budget);
  }
  return budget;
}

function v62ScoringCacheStats(ctx) {
  var cache = ctx && ctx._v62_score_state_cache;
  return {
    enabled: !!(ctx && ctx.scoringCacheV62 === true),
    hits: (ctx && ctx.v62_score_cache_hits) || 0,
    misses: (ctx && ctx.v62_score_cache_misses) || 0,
    size: cache && typeof cache.size === "number" ? cache.size : ((ctx && ctx.v62_score_cache_size) || 0)
  };
}

function solveCore(state0, beamWidth, maxSteps, ctx, strategy) {
  strategy = strategy || {};
  var root = makeNode(state0, null, null, ctx, null, 0);
  var beam = [root];
  var bestWinning = null;
  var lastGoodBeam = [];
  var expanded = 0;
  var depthStats = [];
  var tt = makeTranspositionTable();
  var timeBudgetHit = false;
  ttRememberNode(tt, root);

  var startedAt = Date.now();
  var deadlineMs = ctx.deadlineMs || 0;

  function outOfTime() {
    return deadlineMs && Date.now() >= deadlineMs;
  }

  for (var step = 0; step < maxSteps; step++) {
    if (outOfTime()) { timeBudgetHit = true; break; }

    var bestPerState = new Map();
    var localBestTactical = new Map();
    var stats = {
      depth: step,
      strategy_id: strategy.id || "beam",
      strategy_label: strategy.label || "Beam",
      beam_width: beamWidth,
      beam_in: beam.length,
      expanded_nodes: 0,
      skipped_already_win: 0,
      pruned_hp_bound_parent: 0,
      generated_actions: 0,
      legal_actions: 0,
      rejected_actions: 0,
      rejected_by_reason: {},
      wins_found: 0,
      pruned_hp_bound_child: 0,
      pruned_useless_end_turn: 0,
      pruned_recent_cycle: 0,
      pruned_tt_dominated: 0,
      tt_remembered_new: 0,
      tt_remembered_replaced: 0,
      local_tactical_dropped: 0,
      local_tactical_replaced: 0,
      candidates_before_local_dedup: 0,
      dedup_replaced: 0,
      dedup_dropped: 0,
      candidates_unique: 0,
      beam_out: 0,
      diversity_enabled: null,
      diversity_mode: null,
      diversity_elite_ratio: null,
      diversity_elite_quota: 0,
      diversity_bucket_quota: 0,
      diversity_buckets_seen: 0,
      diversity_buckets_kept: 0,
      diversity_selected_elite: 0,
      diversity_selected_bucket: 0,
      diversity_selected_fill: 0,
      tt_size_after_depth: 0,
      best_score: null,
      best_enemies_remaining: null,
      v38_enabled: false,
      v38_mode: null,
      v38_probe_top_n: null,
      v38_window_size: 0,
      v38_deep_stride: null,
      v38_selected_elite: 0,
      v38_selected_line: 0,
      v38_selected_kill: 0,
      v38_selected_survival: 0,
      v38_selected_low_enemy: 0,
      v38_selected_deep_tail: 0,
      v38_selected_diversity_fill: 0,
      v38_selected_score_fill: 0,
      v42_selected_next_kill: 0,
      v42_next_kill_enabled: false,
      v42_next_kill_probe_top_n: null,
      v38_best_line_score: null,
      time_budget_hit: false
    };

    for (var b = 0; b < beam.length; b++) {
      if ((b & 63) === 0 && outOfTime()) { timeBudgetHit = true; stats.time_budget_hit = true; break; }
      var node = beam[b];
      var st = node.state;
      expanded++;
      stats.expanded_nodes++;
      if (isWin(st)) { stats.skipped_already_win++; continue; }
      if (minHpToFinish(st) > st.pv) { stats.pruned_hp_bound_parent++; continue; }

      var expansion = expandForSearch(st, ctx);
      stats.generated_actions += expansion.all_count != null ? expansion.all_count : expansion.all.length;
      stats.legal_actions += expansion.legal_count != null ? expansion.legal_count : expansion.legal.length;
      stats.rejected_actions += expansion.rejected_count != null ? expansion.rejected_count : expansion.rejected.length;
      if (expansion.rejected_by_reason) {
        Object.keys(expansion.rejected_by_reason).forEach(function (r) { stats.rejected_by_reason[r] = (stats.rejected_by_reason[r] || 0) + expansion.rejected_by_reason[r]; });
      } else {
        for (var ri = 0; ri < expansion.rejected.length; ri++) incCounter(stats.rejected_by_reason, expansion.rejected[ri].reject_reason);
      }

      var childCount = expansion.fast_v58a ? expansion.states.length : expansion.children.length;
      for (var ci = 0; ci < childCount; ci++) {
        var action = expansion.fast_v58a ? expansion.actions[ci] : expansion.children[ci][0];
        var child = expansion.fast_v58a ? expansion.states[ci] : expansion.children[ci][1];
        var sim = expansion.fast_v58a ? null : expansion.children[ci][2];
        var fastEffects = expansion.fast_v58a ? expansion.effects[ci] : null;
        var diag = (ctx.auditDuringSearch === false) ? null : actionDiagnosticRecord(st, action, sim, ctx);

        if (isWin(child)) {
          stats.wins_found++;
          var winNode = makeSearchNodeV58A(child, node, action, ctx, diag, fastEffects, node.depth + 1);
          if (bestWinning === null || compareResultNodes(winNode, bestWinning) < 0) bestWinning = winNode;
          continue;
        }
        if (minHpToFinish(child) > child.pv) { stats.pruned_hp_bound_child++; continue; }

        // Perf : shouldPruneChildV22 et localCandidateDominance n'utilisent que
        // l'état et la profondeur de l'enfant, jamais son score. On les évalue donc
        // AVANT makeNode (le scoring complet), avec un objet léger {state, depth},
        // et on ne paie scoreNodeDetailed que pour les enfants survivants.
        // Comportement-exact : le score d'un enfant élagué n'était jamais lu, et
        // diag est toujours null dans solveCore (auditDuringSearch === false).
        var lightChild = { state: child, depth: node.depth + 1 };
        var prune = shouldPruneChildV22(node, action, lightChild, tt, stats);
        if (prune.prune) continue;

        var key = stateKey(child);
        var loc = localCandidateDominance(localBestTactical, lightChild);
        if (loc.dominated) {
          stats.local_tactical_dropped++;
          continue;
        }

        var cn = makeSearchNodeV58A(child, node, action, ctx, diag, fastEffects, node.depth + 1);
        if (loc.replace && loc.previous) {
          bestPerState.delete(loc.previous.exactKey);
          stats.local_tactical_replaced++;
        }
        rememberLocalCandidate(localBestTactical, lightChild, key);

        stats.candidates_before_local_dedup++;
        var ex = bestPerState.get(key);
        if (ex === undefined || cn.negScore < ex.negScore) {
          if (ex !== undefined) stats.dedup_replaced++;
          bestPerState.set(key, cn);
        } else {
          stats.dedup_dropped++;
        }
      }
    }

    stats.tt_size_after_depth = tt.byTactical.size;

    if (bestWinning !== null) {
      stats.candidates_unique = bestPerState.size;
      stats.beam_out = 0;
      depthStats.push(stats);
      break;
    }
    if (timeBudgetHit) {
      stats.candidates_unique = bestPerState.size;
      stats.beam_out = beam.length;
      depthStats.push(stats);
      break;
    }
    if (bestPerState.size === 0) {
      stats.candidates_unique = 0;
      stats.beam_out = 0;
      depthStats.push(stats);
      break;
    }

    var cands = [];
    bestPerState.forEach(function (n) { cands.push(n); });
    cands.sort(function (x, y) { return x.negScore < y.negScore ? -1 : x.negScore > y.negScore ? 1 : 0; });
    beam = ctx.v38MultiLane ? selectBeamV38(cands, beamWidth, ctx, stats, step) : selectBeamV24(cands, beamWidth, ctx, stats);
    if (ctx.searchDebugV34 && (step % (ctx.paretoProbeEvery || 1) === 0 || bestPerState.size <= beamWidth || timeBudgetHit)) {
      try { stats.v34_pareto_probe = buildV34ParetoProbe(cands, beam, ctx, stats); }
      catch (e) { stats.v34_pareto_probe_error = String(e && e.message ? e.message : e); }
    }
    lastGoodBeam = beam;
    for (var bi = 0; bi < beam.length; bi++) {
      var rem = ttRememberNode(tt, beam[bi]);
      if (rem === "TT_REPLACED") stats.tt_remembered_replaced++;
      else if (rem === "TT_NEW") stats.tt_remembered_new++;
    }
    stats.candidates_unique = cands.length;
    stats.beam_out = beam.length;
    if (beam.length > 0) {
      stats.best_score = beam[0].score;
      stats.best_enemies_remaining = beam[0].state.enemies.size;
    }
    depthStats.push(stats);
  }

  var resultNode, win;
  if (bestWinning !== null) { resultNode = bestWinning; win = true; }
  else if (lastGoodBeam.length > 0) { resultNode = lastGoodBeam[0]; win = false; }
  else if (beam.length > 0) { resultNode = beam[0]; win = false; }
  else return null;

  var planRaw = [];
  for (var n = resultNode; n !== null && n.action !== null; n = n.parent) planRaw.push(n.action);
  planRaw.reverse();
  var runSummary = makeRunSummary(depthStats, tt);
  runSummary.time_budget_hit = timeBudgetHit;
  runSummary.strategy_id = strategy.id || "beam";
  runSummary.strategy_label = strategy.label || "Beam";
  runSummary.strategy_beam_width = beamWidth;
  runSummary.strategy_diversity_enabled = ctx.diversityEnabled;
  runSummary.strategy_diversity_elite_ratio = ctx.diversityEliteRatio;
  runSummary.fast_search_path_v58a = ctx.fastSearchPathV58A !== false;
  runSummary.lean_search_result_v63b = ctx.leanFastSearchResultV63B !== false;
  runSummary.scoring_cache_v62 = v62ScoringCacheStats(ctx);
  runSummary.elapsed_ms = Date.now() - startedAt;
  runSummary.max_depth_seen = depthStats.length ? depthStats[depthStats.length - 1].depth : 0;
  return {
    planRaw: planRaw,
    win: win,
    finalState: resultNode.state,
    finalScore: resultNode.score,
    finalMetrics: resultNode.score_metrics || tacticalStateMetrics(resultNode.state, ctx),
    expanded: expanded,
    depthStats: depthStats,
    runSummary: runSummary,
    strategy: strategy
  };
}


// ============================================================
// V56A — ADAPTIVE RESERVOIR BEAM
// ------------------------------------------------------------
// Objectif : élargir progressivement le beam sans relancer la recherche.
// Les candidats non explorés restent dans des réservoirs par profondeur ;
// quand le palier augmente, on développe les nouveaux candidats débloqués.
// Les règles, la simulation et le scoring restent inchangés.
// ============================================================
function makeAdaptiveDepthStats(strategy, beamWidth, depth, stageIndex, stageBeam, levelSize) {
  return {
    depth: depth,
    strategy_id: strategy.id || "beam_adaptive",
    strategy_label: strategy.label || "Adaptive Beam",
    beam_width: beamWidth,
    beam_in: 0,
    expanded_nodes: 0,
    skipped_already_win: 0,
    pruned_hp_bound_parent: 0,
    generated_actions: 0,
    legal_actions: 0,
    rejected_actions: 0,
    rejected_by_reason: {},
    wins_found: 0,
    pruned_hp_bound_child: 0,
    pruned_useless_end_turn: 0,
    pruned_recent_cycle: 0,
    pruned_tt_dominated: 0,
    tt_remembered_new: 0,
    tt_remembered_replaced: 0,
    local_tactical_dropped: 0,
    local_tactical_replaced: 0,
    candidates_before_local_dedup: 0,
    dedup_replaced: 0,
    dedup_dropped: 0,
    candidates_unique: levelSize || 0,
    beam_out: 0,
    diversity_enabled: null,
    diversity_mode: null,
    diversity_elite_ratio: null,
    diversity_elite_quota: 0,
    diversity_bucket_quota: 0,
    diversity_buckets_seen: 0,
    diversity_buckets_kept: 0,
    diversity_selected_elite: 0,
    diversity_selected_bucket: 0,
    diversity_selected_fill: 0,
    tt_size_after_depth: 0,
    best_score: null,
    best_enemies_remaining: null,
    v38_enabled: false,
    v38_mode: null,
    v38_probe_top_n: null,
    v38_window_size: 0,
    v38_deep_stride: null,
    v38_selected_elite: 0,
    v38_selected_line: 0,
    v38_selected_kill: 0,
    v38_selected_survival: 0,
    v38_selected_low_enemy: 0,
    v38_selected_deep_tail: 0,
    v38_selected_diversity_fill: 0,
    v38_selected_score_fill: 0,
    v42_selected_next_kill: 0,
    v42_next_kill_enabled: false,
    v42_next_kill_probe_top_n: null,
    v38_best_line_score: null,
    time_budget_hit: false,
    adaptive_beam_enabled: true,
    adaptive_stage_index: stageIndex,
    adaptive_stage_beam: stageBeam,
    adaptive_candidates_available: levelSize || 0,
    adaptive_skipped_already_expanded: 0,
    adaptive_new_candidates: 0,
    adaptive_replaced_candidates: 0,
    adaptive_stage_elapsed_ms: 0
  };
}

function normalizeAdaptiveBeamSchedule(strategy, beamWidth, ctx) {
  strategy = strategy || {};
  var raw = strategy.adaptiveBeamSchedule || strategy.beamSchedule || (ctx && ctx.adaptiveBeamSchedule) || null;
  if (!Array.isArray(raw) || raw.length === 0) {
    var max = Math.max(50, Math.floor(Number(beamWidth) || 1800));
    raw = [Math.min(100, max), Math.min(300, max), Math.min(600, max), Math.min(1000, max), max];
  }
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var v = Math.floor(Number(raw[i]) || 0);
    if (!isFinite(v) || v <= 0) continue;
    v = Math.max(1, Math.min(20000, v));
    if (out.indexOf(v) < 0) out.push(v);
  }
  var finalBeam = Math.max(1, Math.min(20000, Math.floor(Number(beamWidth) || 1800)));
  if (out.indexOf(finalBeam) < 0) out.push(finalBeam);
  out.sort(function (a, b) { return a - b; });
  return out;
}

function makeAdaptiveLevel(depth) {
  return {
    depth: depth,
    candidatesByState: new Map(),
    localBestTactical: new Map(),
    orderedCandidates: null,
    dirty: true,
    expandedKeys: new Set(),
    ttRememberedKeys: new Set()
  };
}

function getAdaptiveLevel(levels, depth) {
  while (levels.length <= depth) levels.push(makeAdaptiveLevel(levels.length));
  return levels[depth];
}

function adaptiveNodeKey(node) {
  return stateKey(node.state);
}

function adaptiveOrderedCandidates(level) {
  if (!level.orderedCandidates || level.dirty) {
    var arr = [];
    level.candidatesByState.forEach(function (n) { arr.push(n); });
    arr.sort(function (x, y) {
      if (x.negScore !== y.negScore) return x.negScore < y.negScore ? -1 : 1;
      if (x.state.enemies.size !== y.state.enemies.size) return x.state.enemies.size - y.state.enemies.size;
      if (x.state.pv !== y.state.pv) return y.state.pv - x.state.pv;
      return x.depth - y.depth;
    });
    level.orderedCandidates = arr;
    level.dirty = false;
  }
  return level.orderedCandidates;
}

function rememberAdaptiveLevelCandidate(level, node, stats) {
  var key = stateKey(node.state);
  var loc = localCandidateDominance(level.localBestTactical, node);
  if (loc.dominated) {
    if (stats) stats.local_tactical_dropped++;
    return false;
  }
  if (loc.replace && loc.previous) {
    level.candidatesByState.delete(loc.previous.exactKey);
    if (stats) stats.local_tactical_replaced++;
  }
  rememberLocalCandidate(level.localBestTactical, node, key);
  if (stats) stats.candidates_before_local_dedup++;
  var ex = level.candidatesByState.get(key);
  if (ex === undefined || node.negScore < ex.negScore) {
    if (ex !== undefined && stats) {
      stats.dedup_replaced++;
      stats.adaptive_replaced_candidates++;
    } else if (stats) {
      stats.adaptive_new_candidates++;
    }
    level.candidatesByState.set(key, node);
    level.dirty = true;
    return true;
  }
  if (stats) stats.dedup_dropped++;
  return false;
}

function selectAdaptiveLevelWindow(level, stageBeam, ctx, stats, depth) {
  var cands = adaptiveOrderedCandidates(level);
  stats.candidates_unique = cands.length;
  stats.adaptive_candidates_available = cands.length;
  if (cands.length === 0) return [];
  return ctx.v38MultiLane ? selectBeamV38(cands, stageBeam, ctx, stats, depth) : selectBeamV24(cands, stageBeam, ctx, stats);
}

function bestAdaptiveFrontierNode(levels) {
  for (var d = levels.length - 1; d >= 0; d--) {
    var arr = adaptiveOrderedCandidates(levels[d]);
    if (arr && arr.length) return arr[0];
  }
  return null;
}

// V64 : calcule le prochain palier de beam élargi pour l'escalade. Renvoie null si
// l'escalade est désactivée, plafonnée, ou n'apporterait rien. Par défaut ACTIVE
// (pur bonus : ne se déclenche que sur schedule épuisé sans victoire), bornée et
// désactivable via strategy/ctx.adaptiveBeamEscalation = false.
function escalatedBeamV64(topBeam, baseBeam, strategy, ctx, doneSteps) {
  var s = strategy || {}, c = ctx || {};
  var on = s.adaptiveBeamEscalation;
  if (on === undefined) on = c.adaptiveBeamEscalation;
  if (on === undefined) on = false; // opt-in : défaut OFF -> comportement actuel inchangé
  if (!on) return null;
  var factor = Number(s.adaptiveBeamEscalationFactor || c.adaptiveBeamEscalationFactor || 1.8);
  var maxMult = Number(s.adaptiveBeamEscalationMaxMult || c.adaptiveBeamEscalationMaxMult || 4);
  var maxSteps = Number(s.adaptiveBeamEscalationMaxSteps || c.adaptiveBeamEscalationMaxSteps || 3);
  if (doneSteps >= maxSteps) return null;
  var next = Math.round(topBeam * factor);
  var cap = Math.round(baseBeam * maxMult);
  if (next > cap) next = cap;
  if (next > 20000) next = 20000;
  if (next <= topBeam) return null;
  return next;
}

// V64 : escalade de beam par re-runs ADAPTATIFS FRAIS à beam croissant. La cascade
// large doit repartir du niveau 0 (élargir une frontière déjà construite à beamWidth
// n'expand rien de neuf), d'où un solveCoreAdaptiveBeam complet par palier élargi.
// Ne tourne que si le primaire a échoué (appelé après le return des victoires) ->
// zéro effet sur les cas gagnants. Renvoie le résultat annoté si une escalade GAGNE,
// sinon null (on retombe sur le fallback fixe existant).
function tryBeamEscalationV64(state0, beamWidth, maxSteps, ctx, strategy, adaptiveRes, originalDeadline, primaryBudgetMs, policy) {
  var curBeam = beamWidth, steps = 0, totalDt = 0, best = adaptiveRes;
  var minLeft = Math.min(1000, adaptiveFallbackMinBudgetMs(policy, strategy, ctx));
  for (;;) {
    var nextBeam = escalatedBeamV64(curBeam, beamWidth, strategy, ctx, steps);
    if (!nextBeam) break;
    if (originalDeadline && (originalDeadline - Date.now()) <= minLeft) break;
    var ectx = cloneAdaptiveRuntimeContext(ctx);
    ectx.deadlineMs = originalDeadline || 0;
    var et0 = Date.now();
    var escRes = solveCoreAdaptiveBeam(state0, nextBeam, maxSteps, ectx, strategy);
    totalDt += Date.now() - et0;
    steps++; curBeam = nextBeam;
    if (escRes && (!best || compareCoreResults(escRes, best) < 0)) best = escRes;
    if (best && best.win) {
      best.strategy = strategy;
      best.runSummary = best.runSummary || {};
      best.runSummary.beam_escalation_to = nextBeam;
      best.runSummary.beam_escalation_steps = steps;
      return annotateAdaptiveFallbackResult(best, adaptiveRes, best, true, true, totalDt, primaryBudgetMs, "beam_escalation_win", policy);
    }
    if (originalDeadline && Date.now() >= originalDeadline) break;
  }
  return null;
}

function solveCoreAdaptiveBeam(state0, beamWidth, maxSteps, ctx, strategy) {
  strategy = strategy || {};
  var schedule = normalizeAdaptiveBeamSchedule(strategy, beamWidth, ctx);
  var root = makeNode(state0, null, null, ctx, null, 0);
  var levels = [makeAdaptiveLevel(0)];
  levels[0].candidatesByState.set(stateKey(root.state), root);
  rememberLocalCandidate(levels[0].localBestTactical, root, stateKey(root.state));
  levels[0].dirty = true;

  var bestWinning = null;
  var lastGoodBeam = [];
  var expanded = 0;
  var depthStats = [];
  var stageStats = [];
  var tt = makeTranspositionTable();
  var timeBudgetHit = false;
  var startedAt = Date.now();
  var deadlineMs = ctx.deadlineMs || 0;
  var maxDepthSeen = 0;
  var solvedAtBeam = null;

  ttRememberNode(tt, root);
  levels[0].ttRememberedKeys.add(stateKey(root.state));

  function outOfTime() { return deadlineMs && Date.now() >= deadlineMs; }

  for (var si = 0; si < schedule.length; si++) {
    var stageBeam = schedule[si];
    var stageStarted = Date.now();
    var expandedBeforeStage = expanded;
    var candidatesBeforeStage = 0;
    for (var cb = 0; cb < levels.length; cb++) candidatesBeforeStage += levels[cb].candidatesByState.size;
    var stageDepthCount = 0;

    for (var step = 0; step < maxSteps; step++) {
      if (outOfTime()) { timeBudgetHit = true; break; }
      var level = getAdaptiveLevel(levels, step);
      var levelSize = level.candidatesByState.size;
      if (levelSize === 0) break;

      var stats = makeAdaptiveDepthStats(strategy, beamWidth, step, si, stageBeam, levelSize);
      var selected = selectAdaptiveLevelWindow(level, stageBeam, ctx, stats, step);
      stats.beam_in = selected.length;
      stats.beam_out = selected.length;
      if (selected.length > 0) {
        stats.best_score = selected[0].score;
        stats.best_enemies_remaining = selected[0].state.enemies.size;
        lastGoodBeam = selected;
        maxDepthSeen = Math.max(maxDepthSeen, step);
      }
      stageDepthCount++;

      // Un nœud devient officiellement actif quand il entre dans la fenêtre
      // du palier courant. On l'enregistre alors dans la TT, une seule fois.
      for (var ri = 0; ri < selected.length; ri++) {
        var rememberKey = adaptiveNodeKey(selected[ri]);
        if (level.ttRememberedKeys.has(rememberKey)) continue;
        var rem = ttRememberNode(tt, selected[ri]);
        level.ttRememberedKeys.add(rememberKey);
        if (rem === "TT_REPLACED") stats.tt_remembered_replaced++;
        else if (rem === "TT_NEW") stats.tt_remembered_new++;
      }

      var nextLevel = getAdaptiveLevel(levels, step + 1);
      for (var b = 0; b < selected.length; b++) {
        if ((b & 63) === 0 && outOfTime()) { timeBudgetHit = true; stats.time_budget_hit = true; break; }
        var node = selected[b];
        var nKey = adaptiveNodeKey(node);
        if (level.expandedKeys.has(nKey)) {
          stats.adaptive_skipped_already_expanded++;
          continue;
        }
        level.expandedKeys.add(nKey);

        var st = node.state;
        expanded++;
        stats.expanded_nodes++;
        if (isWin(st)) { stats.skipped_already_win++; continue; }
        if (minHpToFinish(st) > st.pv) { stats.pruned_hp_bound_parent++; continue; }

        var expansion = expandForSearch(st, ctx);
        stats.generated_actions += expansion.all_count != null ? expansion.all_count : expansion.all.length;
        stats.legal_actions += expansion.legal_count != null ? expansion.legal_count : expansion.legal.length;
        stats.rejected_actions += expansion.rejected_count != null ? expansion.rejected_count : expansion.rejected.length;
        if (expansion.rejected_by_reason) {
          Object.keys(expansion.rejected_by_reason).forEach(function (r) { stats.rejected_by_reason[r] = (stats.rejected_by_reason[r] || 0) + expansion.rejected_by_reason[r]; });
        } else {
          for (var ri2 = 0; ri2 < expansion.rejected.length; ri2++) incCounter(stats.rejected_by_reason, expansion.rejected[ri2].reject_reason);
        }

        var childCount = expansion.fast_v58a ? expansion.states.length : expansion.children.length;
        for (var ci = 0; ci < childCount; ci++) {
          var action = expansion.fast_v58a ? expansion.actions[ci] : expansion.children[ci][0];
          var child = expansion.fast_v58a ? expansion.states[ci] : expansion.children[ci][1];
          var sim = expansion.fast_v58a ? null : expansion.children[ci][2];
          var fastEffects = expansion.fast_v58a ? expansion.effects[ci] : null;
          var diag = (ctx.auditDuringSearch === false) ? null : actionDiagnosticRecord(st, action, sim, ctx);

          if (isWin(child)) {
            stats.wins_found++;
            var winNode = makeSearchNodeV58A(child, node, action, ctx, diag, fastEffects, node.depth + 1);
            if (bestWinning === null || compareResultNodes(winNode, bestWinning) < 0) bestWinning = winNode;
            continue;
          }
          if (minHpToFinish(child) > child.pv) { stats.pruned_hp_bound_child++; continue; }

          var lightChild = { state: child, depth: node.depth + 1 };
          var prune = shouldPruneChildV22(node, action, lightChild, tt, stats);
          if (prune.prune) continue;

          var cn = makeSearchNodeV58A(child, node, action, ctx, diag, fastEffects, node.depth + 1);
          rememberAdaptiveLevelCandidate(nextLevel, cn, stats);
        }
      }

      stats.tt_size_after_depth = tt.byTactical.size;
      stats.candidates_unique = level.candidatesByState.size;
      stats.adaptive_candidates_available = level.candidatesByState.size;
      stats.adaptive_stage_elapsed_ms = Date.now() - stageStarted;
      depthStats.push(stats);

      if (bestWinning !== null) {
        solvedAtBeam = stageBeam;
        break;
      }
      if (timeBudgetHit) break;
    }

    var candidatesAfterStage = 0;
    for (var ca = 0; ca < levels.length; ca++) candidatesAfterStage += levels[ca].candidatesByState.size;
    stageStats.push({
      stage_index: si,
      beam_width: stageBeam,
      elapsed_ms: Date.now() - stageStarted,
      expanded_nodes: expanded - expandedBeforeStage,
      depth_passes: stageDepthCount,
      candidates_before: candidatesBeforeStage,
      candidates_after: candidatesAfterStage,
      win_found: bestWinning !== null,
      time_budget_hit: timeBudgetHit
    });
    if (bestWinning !== null || timeBudgetHit) break;
  }

  var adaptiveStopReason = bestWinning !== null ? "win_found" : (timeBudgetHit ? "time_budget_hit" : (stageStats.length >= schedule.length ? "schedule_complete" : "stopped_before_schedule_end"));
  if (!bestWinning && !lastGoodBeam.length) adaptiveStopReason = timeBudgetHit ? "time_budget_hit_no_frontier" : "no_candidates";

  var resultNode, win;
  if (bestWinning !== null) { resultNode = bestWinning; win = true; }
  else if (lastGoodBeam.length > 0) { resultNode = lastGoodBeam[0]; win = false; }
  else { resultNode = bestAdaptiveFrontierNode(levels); win = false; }
  if (!resultNode) return null;

  var planRaw = [];
  for (var n = resultNode; n !== null && n.action !== null; n = n.parent) planRaw.push(n.action);
  planRaw.reverse();
  var runSummary = makeRunSummary(depthStats, tt);
  runSummary.time_budget_hit = timeBudgetHit;
  runSummary.strategy_id = strategy.id || "beam_adaptive";
  runSummary.strategy_label = strategy.label || "Adaptive Beam";
  runSummary.strategy_beam_width = beamWidth;
  runSummary.strategy_diversity_enabled = ctx.diversityEnabled;
  runSummary.strategy_diversity_elite_ratio = ctx.diversityEliteRatio;
  runSummary.fast_search_path_v58a = ctx.fastSearchPathV58A !== false;
  runSummary.lean_search_result_v63b = ctx.leanFastSearchResultV63B !== false;
  runSummary.scoring_cache_v62 = v62ScoringCacheStats(ctx);
  runSummary.elapsed_ms = Date.now() - startedAt;
  runSummary.max_depth_seen = maxDepthSeen;
  runSummary.adaptive_stop_reason = adaptiveStopReason;
  runSummary.adaptive_schedule_length = schedule.length;
  runSummary.adaptive_schedule_complete = adaptiveStopReason === "schedule_complete";
  runSummary.adaptive_last_stage = stageStats.length ? stageStats[stageStats.length - 1] : null;
  runSummary.diagnostic_v58a4 = {
    version: "V63B_lean_fast_search_result",
    fast_search_path_v58a: ctx.fastSearchPathV58A !== false,
    audit_during_search: ctx.auditDuringSearch !== false,
    fast_path_parity_v60: true,
    fast_path_effects_scoring_disabled: ctx.fastSearchPathV58A !== false,
    beam_selection_cache_v61: ctx.beamSelectionCacheV61 !== false,
    scoring_cache_v62: ctx.scoringCacheV62 === true,
    lean_search_result_v63b: ctx.leanFastSearchResultV63B !== false,
    scoring_cache_stats_v62: v62ScoringCacheStats(ctx),
    deadline_ms_active: !!deadlineMs,
    deadline_remaining_ms_at_end: deadlineMs ? Math.max(0, deadlineMs - Date.now()) : null,
    stop_reason: adaptiveStopReason,
    schedule: schedule.slice(),
    stage_count: stageStats.length,
    max_reached: stageStats.length ? stageStats[stageStats.length - 1].beam_width : null
  };
  runSummary.adaptive_beam = {
    enabled: true,
    mode: "progressive_reservoir_v56a",
    schedule: schedule.slice(),
    solved_at_beam: solvedAtBeam,
    max_reached: stageStats.length ? stageStats[stageStats.length - 1].beam_width : schedule[0],
    stage_count: stageStats.length,
    resumed_without_restart: true,
    restart_count: 0,
    stages: stageStats,
    levels_kept: levels.length,
    expanded_total: expanded,
    stop_reason: adaptiveStopReason,
    schedule_length: schedule.length,
    schedule_complete: adaptiveStopReason === "schedule_complete",
    last_stage: stageStats.length ? stageStats[stageStats.length - 1] : null,
    fast_search_path_v58a: ctx.fastSearchPathV58A !== false,
    diagnostic_v58a4: runSummary.diagnostic_v58a4
  };
  return {
    planRaw: planRaw,
    win: win,
    finalState: resultNode.state,
    finalScore: resultNode.score,
    finalMetrics: resultNode.score_metrics || tacticalStateMetrics(resultNode.state, ctx),
    expanded: expanded,
    depthStats: depthStats,
    runSummary: runSummary,
    strategy: strategy
  };
}

function cloneAdaptiveRuntimeContext(ctx) {
  var out = {};
  Object.keys(ctx || {}).forEach(function (k) { out[k] = ctx[k]; });
  return out;
}

function normalizeAdaptiveFallbackPolicy(strategy, ctx) {
  strategy = strategy || {};
  ctx = ctx || {};
  var raw = strategy.adaptiveFallbackPolicy || strategy.v56AdaptiveFallbackPolicy || ctx.adaptiveFallbackPolicy || ctx.v56AdaptiveFallbackPolicy || "early";
  raw = String(raw || "early").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (raw === "off" || raw === "none" || raw === "pure" || raw === "v56a" || raw === "adaptive_only") return "pure";
  if (raw === "late" || raw === "v56e_late" || raw === "fallback_late") return "late";
  if (raw === "smart" || raw === "v56e_smart" || raw === "fallback_smart") return "smart";
  if (raw === "dual" || raw === "v56f" || raw === "v56f_dual" || raw === "dual_adaptive" || raw === "late_aggressive_pure_classic") return "dual";
  if (raw === "pure_first" || raw === "v56g" || raw === "v56g_pure_first" || raw === "pure_classic_late_aggressive") return "pure_first";
  if (raw === "time_boxed" || raw === "timeboxed" || raw === "v56h" || raw === "v56h_time_boxed" || raw === "pure_then_aggressive_timeboxed") return "time_boxed";
  if (raw === "early" || raw === "safety" || raw === "v56d" || raw === "fallback_early") return "early";
  return "early";
}

function adaptivePolicyLabel(policy) {
  if (policy === "pure") return "V56A pure";
  if (policy === "late") return "V56E late fallback";
  if (policy === "smart") return "V56E smart fallback";
  if (policy === "dual") return "V56F dual adaptive";
  if (policy === "pure_first") return "V56G pure-first adaptive";
  if (policy === "time_boxed") return "V56H time-boxed portfolio";
  return "V56D early fallback";
}

function adaptiveFallbackMinBudgetMs(policy, strategy, ctx) {
  var raw = strategy && strategy.adaptiveFallbackMinBudgetMs != null ? Number(strategy.adaptiveFallbackMinBudgetMs) : (ctx && ctx.adaptiveFallbackMinBudgetMs != null ? Number(ctx.adaptiveFallbackMinBudgetMs) : null);
  if (raw != null && isFinite(raw) && raw > 0) return Math.max(750, Math.floor(raw));
  if (policy === "late") return 6000;
  if (policy === "smart") return 4500;
  return 1500;
}

function adaptivePrimaryBudgetMsForPolicy(policy, remainingTotal, strategy, ctx) {
  strategy = strategy || {};
  ctx = ctx || {};
  var explicitBudget = strategy.adaptivePrimaryBudgetMs != null ? Number(strategy.adaptivePrimaryBudgetMs) : (ctx.adaptivePrimaryBudgetMs != null ? Number(ctx.adaptivePrimaryBudgetMs) : null);
  if (explicitBudget != null && isFinite(explicitBudget) && explicitBudget > 0) return Math.max(500, Math.floor(explicitBudget));
  if (!remainingTotal || remainingTotal <= 0) return 0;

  // V58A.2 : sur la page finale utilisateur, le solveur unique est V56E late
  // aggressive. Le vieux plafond historique de phase primaire (18 s) donnait
  // l'impression que le timeout global 30 s était ignoré, et pouvait arrêter
  // l'adaptive juste avant une solution. On laisse donc l'adaptive consommer
  // presque tout le budget utilisateur ; le fallback fixe ne sert que s'il
  // reste réellement du temps.
  if (ctx.finalUserSolverV58A1 === true && policy === "late") {
    var finalReserve = strategy.adaptiveFinalUserFallbackReserveMs != null ? Number(strategy.adaptiveFinalUserFallbackReserveMs) : (ctx.adaptiveFinalUserFallbackReserveMs != null ? Number(ctx.adaptiveFinalUserFallbackReserveMs) : 500);
    if (!isFinite(finalReserve) || finalReserve < 0) finalReserve = 500;
    finalReserve = Math.max(0, Math.min(5000, Math.floor(finalReserve)));
    return Math.max(500, Math.floor(remainingTotal - finalReserve));
  }

  var explicitFraction = strategy.adaptivePrimaryBudgetFraction != null ? Number(strategy.adaptivePrimaryBudgetFraction) : (ctx.adaptivePrimaryBudgetFraction != null ? Number(ctx.adaptivePrimaryBudgetFraction) : null);
  var frac;
  if (explicitFraction != null && isFinite(explicitFraction) && explicitFraction > 0) frac = Math.max(0.05, Math.min(0.95, explicitFraction));
  else if (policy === "late") frac = 0.74;
  else if (policy === "smart") frac = 0.58;
  else frac = 0.28;
  var minPrimary = policy === "late" ? 4500 : (policy === "smart" ? 3200 : 1800);
  var maxPrimary = policy === "late" ? 18000 : (policy === "smart" ? 14000 : 6000);
  var primary = Math.max(minPrimary, Math.min(maxPrimary, Math.floor(remainingTotal * frac)));
  var minFallback = adaptiveFallbackMinBudgetMs(policy, strategy, ctx);
  if (remainingTotal > minFallback + 750) primary = Math.min(primary, Math.max(750, remainingTotal - minFallback));
  return Math.max(500, Math.floor(primary));
}

function adaptiveFallbackShouldAttempt(policy, adaptiveRes, beamWidth, schedule, ctx, strategy) {
  if (policy === "early" || policy === "late" || policy === "dual" || policy === "pure_first" || policy === "time_boxed") return { attempt: true, reason: adaptiveRes ? "adaptive_no_win" : "adaptive_no_result" };
  if (policy !== "smart") return { attempt: false, reason: "fallback_disabled" };
  if (!adaptiveRes) return { attempt: true, reason: "smart_no_adaptive_result" };
  var rs = adaptiveRes.runSummary || {};
  var ab = rs.adaptive_beam || {};
  var finalBeam = schedule && schedule.length ? schedule[schedule.length - 1] : beamWidth;
  var maxReached = typeof ab.max_reached === "number" ? ab.max_reached : 0;
  var stageCount = typeof ab.stage_count === "number" ? ab.stage_count : 0;
  var enemies = adaptiveRes.finalState && adaptiveRes.finalState.enemies ? adaptiveRes.finalState.enemies.size : 999;
  var enemyThreshold = strategy && strategy.adaptiveSmartEnemyThreshold != null ? Number(strategy.adaptiveSmartEnemyThreshold) : (ctx && ctx.adaptiveSmartEnemyThreshold != null ? Number(ctx.adaptiveSmartEnemyThreshold) : 12);
  if (rs.time_budget_hit || ab.time_budget_hit) return { attempt: true, reason: "smart_time_budget_hit" };
  if (maxReached < finalBeam) return { attempt: true, reason: "smart_max_beam_not_reached" };
  if (stageCount <= 2) return { attempt: true, reason: "smart_low_stage_count" };
  if (isFinite(enemyThreshold) && enemies <= enemyThreshold) return { attempt: true, reason: "smart_promising_low_enemy_count" };
  return { attempt: false, reason: "smart_no_stagnation_signal" };
}

function annotateAdaptiveFallbackResult(targetRes, adaptiveRes, fallbackRes, fallbackUsed, fallbackAttempted, fallbackElapsedMs, adaptiveBudgetMs, fallbackReason, fallbackPolicy) {
  if (!targetRes) return targetRes;
  var base = adaptiveRes && adaptiveRes.runSummary && adaptiveRes.runSummary.adaptive_beam
    ? adaptiveRes.runSummary.adaptive_beam
    : { enabled: true, mode: "progressive_reservoir_v56a" };
  var merged = {};
  Object.keys(base || {}).forEach(function (k) { merged[k] = base[k]; });
  merged.enabled = true;
  merged.fallback_policy = fallbackPolicy || merged.fallback_policy || "early";
  merged.fallback_policy_label = adaptivePolicyLabel(merged.fallback_policy);
  merged.mode = fallbackUsed ? "progressive_reservoir_v56a_with_fixed_fallback" : (merged.mode || "progressive_reservoir_v56a");
  merged.safety_fallback_enabled = merged.fallback_policy !== "pure";
  merged.safety_fallback_attempted = !!fallbackAttempted;
  merged.safety_fallback_used = !!fallbackUsed;
  merged.fallback_reason = fallbackReason || null;
  merged.stop_reason = merged.stop_reason || (adaptiveRes && adaptiveRes.runSummary ? adaptiveRes.runSummary.adaptive_stop_reason : null) || fallbackReason || null;
  merged.primary_budget_ms = adaptiveBudgetMs || null;
  merged.fallback_elapsed_ms = fallbackElapsedMs || 0;
  merged.fast_search_path_v58a = adaptiveRes && adaptiveRes.runSummary ? adaptiveRes.runSummary.fast_search_path_v58a : merged.fast_search_path_v58a;
  merged.diagnostic_v58a4 = adaptiveRes && adaptiveRes.runSummary ? adaptiveRes.runSummary.diagnostic_v58a4 : merged.diagnostic_v58a4;
  merged.restart_count = fallbackUsed ? 1 : (merged.restart_count || 0);
  merged.resumed_without_restart = !fallbackUsed;
  if (fallbackRes && fallbackRes.runSummary) {
    merged.fallback_win = !!fallbackRes.win;
    merged.fallback_enemies_remaining = fallbackRes.finalState && fallbackRes.finalState.enemies ? fallbackRes.finalState.enemies.size : null;
    merged.fallback_expanded_nodes = fallbackRes.expanded || 0;
    merged.fallback_time_budget_hit = !!fallbackRes.runSummary.time_budget_hit;
  }
  targetRes.runSummary = targetRes.runSummary || {};
  targetRes.runSummary.adaptive_beam = merged;
  return targetRes;
}


function cloneAdaptiveStrategy(strategy) {
  var out = {};
  Object.keys(strategy || {}).forEach(function (k) { out[k] = strategy[k]; });
  return out;
}

function adaptiveDualSecondarySchedule(strategy, beamWidth, ctx) {
  strategy = strategy || {};
  ctx = ctx || {};
  var raw = strategy.adaptiveSecondaryBeamSchedule || strategy.v56AdaptiveSecondaryBeamSchedule || ctx.adaptiveSecondaryBeamSchedule || ctx.v56AdaptiveSecondaryBeamSchedule || null;
  if (Array.isArray(raw) && raw.length) {
    var tmpStrategy = cloneAdaptiveStrategy(strategy);
    tmpStrategy.adaptiveBeamSchedule = raw;
    return normalizeAdaptiveBeamSchedule(tmpStrategy, beamWidth, ctx);
  }
  var mult = 1;
  try {
    if (strategy.v47WeightProfile && strategy.v47WeightProfile.beamWidthMultiplier) mult = Math.max(0.25, Math.min(4, Number(strategy.v47WeightProfile.beamWidthMultiplier) || 1));
  } catch (_e) {}
  var baseFinal = Math.max(50, Math.round((Number(beamWidth) || 1600) / mult));
  var bases = [100, 300, 600, 1000, baseFinal];
  var out = [];
  for (var i = 0; i < bases.length; i++) {
    var v = Math.max(50, Math.min(20000, Math.round((Number(bases[i]) || 0) * mult)));
    if (v && out.indexOf(v) < 0) out.push(v);
  }
  if (out.indexOf(beamWidth) < 0) out.push(beamWidth);
  out.sort(function (a, b) { return a - b; });
  return out;
}

function adaptivePhaseSummary(label, res, elapsedMs, schedule, budgetMs) {
  var ab = res && res.runSummary ? (res.runSummary.adaptive_beam || null) : null;
  return {
    label: label,
    win: !!(res && res.win),
    elapsed_ms: elapsedMs || 0,
    budget_ms: budgetMs || null,
    enemies_remaining: res && res.finalState && res.finalState.enemies ? res.finalState.enemies.size : null,
    pv: res && res.finalState ? res.finalState.pv : null,
    actions: res && res.planRaw ? res.planRaw.length : null,
    expanded: res ? (res.expanded || 0) : 0,
    schedule: schedule && schedule.slice ? schedule.slice() : null,
    solved_at_beam: ab && ab.solved_at_beam != null ? ab.solved_at_beam : null,
    max_reached: ab && ab.max_reached != null ? ab.max_reached : null,
    stage_count: ab && ab.stage_count != null ? ab.stage_count : null,
    time_budget_hit: !!(res && res.runSummary && res.runSummary.time_budget_hit)
  };
}

function annotateDualAdaptiveResult(targetRes, phase1Res, phase2Res, fixedRes, usedPhase, phase1ElapsedMs, phase2ElapsedMs, fixedElapsedMs, phase1BudgetMs, phase2BudgetMs, phase1Schedule, phase2Schedule, reason, dualPolicy, phase1Label, phase2Label) {
  if (!targetRes) return targetRes;
  dualPolicy = dualPolicy || "dual";
  phase1Label = phase1Label || "late_aggressive";
  phase2Label = phase2Label || "pure_classic";
  var used = String(usedPhase || "phase1_aggressive");
  var isPhase2 = used.indexOf("phase2") === 0;
  var isPhase1 = used.indexOf("phase1") === 0;
  var adaptiveSource = isPhase2 ? phase2Res : phase1Res;
  var base = adaptiveSource && adaptiveSource.runSummary && adaptiveSource.runSummary.adaptive_beam
    ? adaptiveSource.runSummary.adaptive_beam
    : (phase1Res && phase1Res.runSummary && phase1Res.runSummary.adaptive_beam ? phase1Res.runSummary.adaptive_beam : { enabled: true, mode: "progressive_reservoir_v56a" });
  var merged = {};
  Object.keys(base || {}).forEach(function (k) { merged[k] = base[k]; });
  merged.enabled = true;
  merged.mode = dualPolicy === "time_boxed" ? "progressive_reservoir_v56h_time_boxed" : (dualPolicy === "pure_first" ? "progressive_reservoir_v56g_pure_first" : "progressive_reservoir_v56f_dual");
  merged.fallback_policy = dualPolicy;
  merged.fallback_policy_label = adaptivePolicyLabel(dualPolicy);
  merged.safety_fallback_enabled = true;
  merged.safety_fallback_attempted = !!phase2Res || !!fixedRes || !isPhase1;
  merged.safety_fallback_used = !isPhase1;
  merged.fallback_reason = reason || null;
  merged.restart_count = isPhase1 ? 0 : (isPhase2 ? 1 : 2);
  merged.resumed_without_restart = isPhase1;
  merged.dual_enabled = true;
  merged.dual_variant = dualPolicy;
  merged.dual_used_phase = used;
  merged.dual_phase1 = adaptivePhaseSummary(phase1Label, phase1Res, phase1ElapsedMs, phase1Schedule, phase1BudgetMs);
  merged.dual_phase2 = phase2Res ? adaptivePhaseSummary(phase2Label, phase2Res, phase2ElapsedMs, phase2Schedule, phase2BudgetMs) : null;
  merged.dual_fixed_fallback = fixedRes ? {
    label: "fixed_lo_a",
    win: !!fixedRes.win,
    elapsed_ms: fixedElapsedMs || 0,
    enemies_remaining: fixedRes.finalState && fixedRes.finalState.enemies ? fixedRes.finalState.enemies.size : null,
    pv: fixedRes.finalState ? fixedRes.finalState.pv : null,
    actions: fixedRes.planRaw ? fixedRes.planRaw.length : null,
    expanded: fixedRes.expanded || 0,
    time_budget_hit: !!(fixedRes.runSummary && fixedRes.runSummary.time_budget_hit)
  } : null;
  merged.primary_budget_ms = phase1BudgetMs || null;
  merged.secondary_budget_ms = phase2BudgetMs || null;
  merged.fallback_elapsed_ms = fixedElapsedMs || 0;
  if (fixedRes) {
    merged.fallback_win = !!fixedRes.win;
    merged.fallback_enemies_remaining = fixedRes.finalState && fixedRes.finalState.enemies ? fixedRes.finalState.enemies.size : null;
    merged.fallback_expanded_nodes = fixedRes.expanded || 0;
    merged.fallback_time_budget_hit = !!(fixedRes.runSummary && fixedRes.runSummary.time_budget_hit);
  }
  targetRes.runSummary = targetRes.runSummary || {};
  targetRes.runSummary.adaptive_beam = merged;
  return targetRes;
}


function adaptiveTimeBoxPhase1BudgetMs(remaining, strategy, ctx) {
  strategy = strategy || {};
  ctx = ctx || {};
  var explicit = strategy.adaptiveTimeBoxPhase1BudgetMs != null ? Number(strategy.adaptiveTimeBoxPhase1BudgetMs) : (ctx.adaptiveTimeBoxPhase1BudgetMs != null ? Number(ctx.adaptiveTimeBoxPhase1BudgetMs) : null);
  if (explicit != null && isFinite(explicit) && explicit > 0) return Math.max(500, Math.floor(explicit));
  if (!remaining || remaining <= 0) return 0;
  var target = strategy.adaptiveTimeBoxPhase1TargetMs != null ? Number(strategy.adaptiveTimeBoxPhase1TargetMs) : (ctx.adaptiveTimeBoxPhase1TargetMs != null ? Number(ctx.adaptiveTimeBoxPhase1TargetMs) : 8000);
  if (!isFinite(target) || target <= 0) target = 8000;
  var frac = strategy.adaptiveTimeBoxPhase1Fraction != null ? Number(strategy.adaptiveTimeBoxPhase1Fraction) : (ctx.adaptiveTimeBoxPhase1Fraction != null ? Number(ctx.adaptiveTimeBoxPhase1Fraction) : 0.25);
  if (!isFinite(frac) || frac <= 0) frac = 0.25;
  frac = Math.max(0.12, Math.min(0.45, frac));
  var budget = Math.min(target, Math.floor(remaining * frac));
  return Math.max(500, Math.floor(budget));
}

function adaptiveTimeBoxPhase2BudgetMs(remaining, strategy, ctx) {
  strategy = strategy || {};
  ctx = ctx || {};
  var explicit = strategy.adaptiveTimeBoxPhase2BudgetMs != null ? Number(strategy.adaptiveTimeBoxPhase2BudgetMs) : (ctx.adaptiveTimeBoxPhase2BudgetMs != null ? Number(ctx.adaptiveTimeBoxPhase2BudgetMs) : null);
  if (explicit != null && isFinite(explicit) && explicit > 0) return Math.max(500, Math.floor(explicit));
  if (!remaining || remaining <= 0) return 0;
  var target = strategy.adaptiveTimeBoxPhase2TargetMs != null ? Number(strategy.adaptiveTimeBoxPhase2TargetMs) : (ctx.adaptiveTimeBoxPhase2TargetMs != null ? Number(ctx.adaptiveTimeBoxPhase2TargetMs) : 16000);
  if (!isFinite(target) || target <= 0) target = 16000;
  var reserve = strategy.adaptiveTimeBoxFixedReserveMs != null ? Number(strategy.adaptiveTimeBoxFixedReserveMs) : (ctx.adaptiveTimeBoxFixedReserveMs != null ? Number(ctx.adaptiveTimeBoxFixedReserveMs) : 6000);
  if (!isFinite(reserve) || reserve < 0) reserve = 6000;
  var budget = Math.min(target, Math.floor(remaining * 0.72));
  if (remaining > reserve + 750) budget = Math.min(budget, Math.max(750, remaining - reserve));
  return Math.max(500, Math.floor(budget));
}

function adaptiveDualPhase1BudgetMs(policy, remaining, strategy, ctx) {
  strategy = strategy || {};
  ctx = ctx || {};
  var explicit = strategy.adaptiveDualPhase1BudgetMs != null ? Number(strategy.adaptiveDualPhase1BudgetMs) : (ctx.adaptiveDualPhase1BudgetMs != null ? Number(ctx.adaptiveDualPhase1BudgetMs) : null);
  if (explicit != null && isFinite(explicit) && explicit > 0) return Math.max(500, Math.floor(explicit));
  if (policy === "time_boxed") return adaptiveTimeBoxPhase1BudgetMs(remaining, strategy, ctx);
  if (policy !== "pure_first") return adaptivePrimaryBudgetMsForPolicy("late", remaining, strategy, ctx);
  if (!remaining || remaining <= 0) return 0;
  var frac = strategy.adaptivePureFirstPhase1Fraction != null ? Number(strategy.adaptivePureFirstPhase1Fraction) : (ctx.adaptivePureFirstPhase1Fraction != null ? Number(ctx.adaptivePureFirstPhase1Fraction) : 0.78);
  if (!isFinite(frac) || frac <= 0) frac = 0.78;
  frac = Math.max(0.35, Math.min(0.92, frac));
  var reserve = strategy.adaptivePureFirstReserveMs != null ? Number(strategy.adaptivePureFirstReserveMs) : (ctx.adaptivePureFirstReserveMs != null ? Number(ctx.adaptivePureFirstReserveMs) : 2500);
  reserve = Math.max(0, Math.floor(isFinite(reserve) ? reserve : 2500));
  var maxPrimary = strategy.adaptivePureFirstMaxBudgetMs != null ? Number(strategy.adaptivePureFirstMaxBudgetMs) : (ctx.adaptivePureFirstMaxBudgetMs != null ? Number(ctx.adaptivePureFirstMaxBudgetMs) : 28000);
  maxPrimary = Math.max(4000, Math.floor(isFinite(maxPrimary) ? maxPrimary : 28000));
  var budget = Math.floor(remaining * frac);
  budget = Math.min(maxPrimary, budget);
  if (remaining > reserve + 750) budget = Math.min(budget, Math.max(750, remaining - reserve));
  return Math.max(500, budget);
}

function adaptiveDualPhase2BudgetMs(remaining, strategy, ctx, policy) {
  strategy = strategy || {};
  ctx = ctx || {};
  if (policy === "time_boxed") return adaptiveTimeBoxPhase2BudgetMs(remaining, strategy, ctx);
  var explicit = strategy.adaptiveDualPhase2BudgetMs != null ? Number(strategy.adaptiveDualPhase2BudgetMs) : (ctx.adaptiveDualPhase2BudgetMs != null ? Number(ctx.adaptiveDualPhase2BudgetMs) : null);
  if (explicit != null && isFinite(explicit) && explicit > 0) return Math.max(500, Math.floor(explicit));
  if (!remaining || remaining <= 0) return 0;
  var frac = strategy.adaptiveDualPhase2Fraction != null ? Number(strategy.adaptiveDualPhase2Fraction) : (ctx.adaptiveDualPhase2Fraction != null ? Number(ctx.adaptiveDualPhase2Fraction) : 0.52);
  if (!isFinite(frac) || frac <= 0) frac = 0.52;
  frac = Math.max(0.15, Math.min(0.85, frac));
  var fixedReserve = strategy.adaptiveDualFixedReserveMs != null ? Number(strategy.adaptiveDualFixedReserveMs) : (ctx.adaptiveDualFixedReserveMs != null ? Number(ctx.adaptiveDualFixedReserveMs) : 2500);
  fixedReserve = Math.max(0, Math.floor(isFinite(fixedReserve) ? fixedReserve : 2500));
  var budget = Math.floor(remaining * frac);
  if (remaining > fixedReserve + 750) budget = Math.min(budget, Math.max(750, remaining - fixedReserve));
  return Math.max(500, budget);
}

function solveCoreAdaptiveBeamDual(state0, beamWidth, maxSteps, ctx, strategy) {
  strategy = strategy || {};
  ctx = ctx || {};
  var originalDeadline = ctx.deadlineMs || 0;
  var now = Date.now();
  var remainingTotal = originalDeadline ? Math.max(0, originalDeadline - now) : 0;
  var policy = normalizeAdaptiveFallbackPolicy(strategy, ctx);
  var timeBoxed = policy === "time_boxed";
  var pureFirst = policy === "pure_first" || timeBoxed;
  var phase1Schedule = normalizeAdaptiveBeamSchedule(strategy, beamWidth, ctx);
  var phase1BudgetMs = adaptiveDualPhase1BudgetMs(policy, remainingTotal, strategy, ctx);
  var phase1Name = pureFirst ? (timeBoxed ? "pure_classic_timeboxed" : "pure_classic") : "late_aggressive";
  var phase2Name = pureFirst ? (timeBoxed ? "late_aggressive_timeboxed" : "late_aggressive") : "pure_classic";
  var phase1Used = pureFirst ? (timeBoxed ? "phase1_pure_classic_timeboxed" : "phase1_pure_classic") : "phase1_aggressive";
  var phase2Used = pureFirst ? (timeBoxed ? "phase2_late_aggressive_timeboxed" : "phase2_late_aggressive") : "phase2_classic";

  var phase1Strategy = cloneAdaptiveStrategy(strategy);
  phase1Strategy.adaptiveBeam = true;
  phase1Strategy.adaptiveSafetyFallback = false;
  phase1Strategy.adaptiveFallbackPolicy = "pure";
  phase1Strategy.label = (strategy.label || (timeBoxed ? "Adaptive V56H" : (pureFirst ? "Adaptive V56G" : "Adaptive V56F"))) + " · phase 1 " + phase1Name;
  var phase1Ctx = cloneAdaptiveRuntimeContext(ctx);
  phase1Ctx.adaptiveSafetyFallback = false;
  phase1Ctx.adaptiveFallbackPolicy = "pure";
  if (originalDeadline && phase1BudgetMs > 0) phase1Ctx.deadlineMs = Math.min(originalDeadline, now + phase1BudgetMs);
  var p1t0 = Date.now();
  var phase1Res = solveCoreAdaptiveBeam(state0, beamWidth, maxSteps, phase1Ctx, phase1Strategy);
  var p1dt = Date.now() - p1t0;
  if (phase1Res && phase1Res.win) {
    return annotateDualAdaptiveResult(phase1Res, phase1Res, null, null, phase1Used, p1dt, 0, 0, phase1BudgetMs, 0, phase1Schedule, null, null, policy, phase1Name, phase2Name);
  }

  var afterP1 = Date.now();
  var remainingAfterP1 = originalDeadline ? Math.max(0, originalDeadline - afterP1) : 0;
  var phase2Schedule = adaptiveDualSecondarySchedule(strategy, beamWidth, ctx);
  var phase2BudgetMs = adaptiveDualPhase2BudgetMs(remainingAfterP1, strategy, ctx, policy);
  var phase2Res = null, p2dt = 0;
  if (!originalDeadline || remainingAfterP1 > 650) {
    var phase2Strategy = cloneAdaptiveStrategy(strategy);
    phase2Strategy.adaptiveBeam = true;
    phase2Strategy.adaptiveBeamSchedule = phase2Schedule;
    phase2Strategy.adaptiveSafetyFallback = false;
    phase2Strategy.adaptiveFallbackPolicy = "pure";
    phase2Strategy.label = (strategy.label || (timeBoxed ? "Adaptive V56H" : (pureFirst ? "Adaptive V56G" : "Adaptive V56F"))) + " · phase 2 " + phase2Name;
    var phase2Ctx = cloneAdaptiveRuntimeContext(ctx);
    phase2Ctx.adaptiveBeamSchedule = phase2Schedule;
    phase2Ctx.adaptiveSafetyFallback = false;
    phase2Ctx.adaptiveFallbackPolicy = "pure";
    if (originalDeadline && phase2BudgetMs > 0) phase2Ctx.deadlineMs = Math.min(originalDeadline, Date.now() + phase2BudgetMs);
    var p2t0 = Date.now();
    phase2Res = solveCoreAdaptiveBeam(state0, beamWidth, maxSteps, phase2Ctx, phase2Strategy);
    p2dt = Date.now() - p2t0;
    if (phase2Res && phase2Res.win) {
      phase2Res.strategy = strategy;
      phase2Res.runSummary = phase2Res.runSummary || {};
      phase2Res.runSummary.strategy_id = strategy.id || phase2Res.runSummary.strategy_id;
      phase2Res.runSummary.strategy_label = strategy.label || phase2Res.runSummary.strategy_label;
      return annotateDualAdaptiveResult(phase2Res, phase1Res, phase2Res, null, phase2Used, p1dt, p2dt, 0, phase1BudgetMs, phase2BudgetMs, phase1Schedule, phase2Schedule, "phase1_no_win", policy, phase1Name, phase2Name);
    }
  }

  var bestAdaptive = phase1Res;
  if (phase2Res && (!bestAdaptive || compareCoreResults(phase2Res, bestAdaptive) < 0)) bestAdaptive = phase2Res;
  var timeLeft = originalDeadline ? (originalDeadline - Date.now()) : 1;
  var minFixed = strategy.adaptiveDualFixedMinBudgetMs != null ? Number(strategy.adaptiveDualFixedMinBudgetMs) : (ctx.adaptiveDualFixedMinBudgetMs != null ? Number(ctx.adaptiveDualFixedMinBudgetMs) : 1200);
  minFixed = Math.max(500, isFinite(minFixed) ? minFixed : 1200);
  var fixedRes = null, fdt = 0;
  if (!originalDeadline || timeLeft > minFixed) {
    var fctx = cloneAdaptiveRuntimeContext(ctx);
    fctx.adaptiveBeam = false;
    fctx.deadlineMs = originalDeadline || 0;
    var fixedStrategy = cloneAdaptiveStrategy(strategy);
    fixedStrategy.adaptiveBeam = false;
    fixedStrategy.label = (strategy.label || (timeBoxed ? "Adaptive V56H" : (pureFirst ? "Adaptive V56G" : "Adaptive V56F"))) + " · fallback fixe";
    var ft0 = Date.now();
    fixedRes = solveCore(state0, beamWidth, maxSteps, fctx, fixedStrategy);
    fdt = Date.now() - ft0;
  }

  var best = bestAdaptive;
  var usedPhase = best === phase2Res ? phase2Used : phase1Used;
  if (fixedRes && (!best || compareCoreResults(fixedRes, best) < 0)) {
    best = fixedRes;
    usedPhase = "fixed_fallback";
    fixedRes.strategy = strategy;
    fixedRes.runSummary = fixedRes.runSummary || {};
    fixedRes.runSummary.strategy_id = strategy.id || fixedRes.runSummary.strategy_id;
    fixedRes.runSummary.strategy_label = strategy.label || fixedRes.runSummary.strategy_label;
  }
  if (!best) return null;
  return annotateDualAdaptiveResult(best, phase1Res, phase2Res, fixedRes, usedPhase, p1dt, p2dt, fdt, phase1BudgetMs, phase2BudgetMs, phase1Schedule, phase2Schedule, fixedRes ? "dual_fixed_checked" : "dual_no_fixed_budget", policy, phase1Name, phase2Name);
}

function solveCoreAdaptiveBeamWithSafetyFallback(state0, beamWidth, maxSteps, ctx, strategy) {
  strategy = strategy || {};
  var policy = normalizeAdaptiveFallbackPolicy(strategy, ctx);
  if (policy === "dual" || policy === "pure_first" || policy === "time_boxed") return solveCoreAdaptiveBeamDual(state0, beamWidth, maxSteps, ctx, strategy);
  var fallbackEnabled = policy !== "pure" && strategy.adaptiveSafetyFallback !== false && ctx.adaptiveSafetyFallback !== false;
  if (!fallbackEnabled) {
    var pureRes = solveCoreAdaptiveBeam(state0, beamWidth, maxSteps, ctx, strategy);
    return annotateAdaptiveFallbackResult(pureRes, pureRes, null, false, false, 0, 0, "fallback_disabled", "pure");
  }

  var originalDeadline = ctx.deadlineMs || 0;
  var now = Date.now();
  var remainingTotal = originalDeadline ? Math.max(0, originalDeadline - now) : 0;
  var primaryBudgetMs = adaptivePrimaryBudgetMsForPolicy(policy, remainingTotal, strategy, ctx);
  var schedule = normalizeAdaptiveBeamSchedule(strategy, beamWidth, ctx);

  var actx = cloneAdaptiveRuntimeContext(ctx);
  if (originalDeadline && primaryBudgetMs > 0) actx.deadlineMs = Math.min(originalDeadline, now + primaryBudgetMs);
  var adaptiveRes = solveCoreAdaptiveBeam(state0, beamWidth, maxSteps, actx, strategy);
  if (adaptiveRes && adaptiveRes.win) {
    return annotateAdaptiveFallbackResult(adaptiveRes, adaptiveRes, null, false, false, 0, primaryBudgetMs, null, policy);
  }

  var decision = adaptiveFallbackShouldAttempt(policy, adaptiveRes, beamWidth, schedule, ctx, strategy);
  if (!decision.attempt) {
    return annotateAdaptiveFallbackResult(adaptiveRes, adaptiveRes, null, false, false, 0, primaryBudgetMs, decision.reason, policy);
  }

  var timeLeft = originalDeadline ? (originalDeadline - Date.now()) : 1;
  var minFallback = adaptiveFallbackMinBudgetMs(policy, strategy, ctx);
  var canFallback = timeLeft > Math.min(750, minFallback) || !originalDeadline;
  if (!canFallback) {
    return annotateAdaptiveFallbackResult(adaptiveRes, adaptiveRes, null, false, false, 0, primaryBudgetMs, "no_time_left_for_fallback", policy);
  }

  var fctx = cloneAdaptiveRuntimeContext(ctx);
  fctx.adaptiveBeam = false;
  // V64 : si l'escalade est active, plafonner le fallback fixe pour réserver du
  // budget à l'escalade (sinon il peut tout consommer sur un vrai échec de largeur).
  var escEnabledV64 = !!escalatedBeamV64(beamWidth, beamWidth, strategy, ctx, 0);
  if (escEnabledV64 && originalDeadline) {
    var ffFrac = Number(strategy.adaptiveFixedFallbackFraction != null ? strategy.adaptiveFixedFallbackFraction : (ctx.adaptiveFixedFallbackFraction != null ? ctx.adaptiveFixedFallbackFraction : 0.35));
    var ffLeft = originalDeadline - Date.now();
    fctx.deadlineMs = Math.min(originalDeadline, Date.now() + Math.max(minFallback, ffFrac * ffLeft));
  } else {
    fctx.deadlineMs = originalDeadline || 0;
  }
  var fixedStrategy = {};
  Object.keys(strategy).forEach(function (k) { fixedStrategy[k] = strategy[k]; });
  fixedStrategy.adaptiveBeam = false;
  fixedStrategy.id = strategy.id || fixedStrategy.id || "adaptive_fixed_fallback";
  fixedStrategy.label = (strategy.label || fixedStrategy.label || "Adaptive Beam") + " · fallback fixe";
  var ft0 = Date.now();
  var fallbackRes = solveCore(state0, beamWidth, maxSteps, fctx, fixedStrategy);
  var fdt = Date.now() - ft0;

  var useFallback = fallbackRes && (!adaptiveRes || compareCoreResults(fallbackRes, adaptiveRes) < 0);

  // V64 : si ni le primaire ni le fallback fixe n'ont gagné, escalader le beam
  // (re-runs frais à beam croissant) avec le budget restant.
  var bestSoFarV64 = useFallback ? fallbackRes : adaptiveRes;
  if (bestSoFarV64 && !bestSoFarV64.win) {
    var escWinV64 = tryBeamEscalationV64(state0, beamWidth, maxSteps, ctx, strategy, bestSoFarV64, originalDeadline, primaryBudgetMs, policy);
    if (escWinV64) return escWinV64;
  }

  if (useFallback) {
    fallbackRes.strategy = strategy;
    fallbackRes.runSummary = fallbackRes.runSummary || {};
    fallbackRes.runSummary.strategy_id = strategy.id || fallbackRes.runSummary.strategy_id;
    fallbackRes.runSummary.strategy_label = strategy.label || fallbackRes.runSummary.strategy_label;
    return annotateAdaptiveFallbackResult(fallbackRes, adaptiveRes, fallbackRes, true, true, fdt, primaryBudgetMs, adaptiveRes ? (adaptiveRes.win ? "adaptive_worse" : decision.reason) : "adaptive_no_result", policy);
  }
  return annotateAdaptiveFallbackResult(adaptiveRes, adaptiveRes, fallbackRes, false, true, fdt, primaryBudgetMs, "fallback_not_better:" + (decision.reason || "adaptive_no_win"), policy);
}


function compareResultNodes(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  var aw = isWin(a.state), bw = isWin(b.state);
  if (aw !== bw) return aw ? -1 : 1;
  if (a.state.enemies.size !== b.state.enemies.size) return a.state.enemies.size - b.state.enemies.size;
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.state.pv !== b.state.pv) return b.state.pv - a.state.pv;
  return b.score - a.score;
}

function cloneContextForStrategy(ctx, strategy, deadlineMs) {
  var out = {};
  Object.keys(ctx).forEach(function (k) { out[k] = ctx[k]; });
  out.diversityEnabled = strategy.diversityEnabled !== false;
  out.diversityEliteRatio = strategy.diversityEliteRatio != null ? strategy.diversityEliteRatio : ctx.diversityEliteRatio;
  out.v38MultiLane = strategy.v38MultiLane !== false;
  out.v38ProbeTopN = strategy.v38ProbeTopN != null ? strategy.v38ProbeTopN : ctx.v38ProbeTopN;
  out.t6VirtualEndScore = (strategy.t6VirtualEndScore === true) || (strategy.t6VirtualEndScore !== false && ctx.t6VirtualEndScore === true);
  out.nextKillSeekScore = (strategy.nextKillSeekScore === true) || (strategy.nextKillSeekScore !== false && ctx.nextKillSeekScore === true);
  out.nextKillProbeTopN = strategy.nextKillProbeTopN != null ? strategy.nextKillProbeTopN : ctx.nextKillProbeTopN;
  out.v44StochasticRestart = strategy.v44StochasticRestart === true;
  out.v44StochasticProfile = strategy.v44StochasticProfile || ctx.v44StochasticProfile || 'mix';
  out.v44LaneProfile = strategy.v44LaneProfile || strategy.v44StochasticProfile || ctx.v44LaneProfile || null;
  out.v44StochasticSeed = strategy.v44StochasticSeed || ctx.v44StochasticSeed || 'v44';
  out.v44JitterStrength = strategy.v44JitterStrength != null ? strategy.v44JitterStrength : ctx.v44JitterStrength;
  out.v45ProfileSweep = strategy.v45ProfileSweep === true;
  out.v45ProfileName = strategy.v45ProfileName || ctx.v45ProfileName || null;
  out.v45ProfileComponents = strategy.v45ProfileComponents || ctx.v45ProfileComponents || null;
  out.v45ProfileIntensity = strategy.v45ProfileIntensity != null ? strategy.v45ProfileIntensity : ctx.v45ProfileIntensity;
  out.v45LateBias = strategy.v45LateBias === true || ctx.v45LateBias === true;
  out.adaptiveBeam = strategy.adaptiveBeam === true || ctx.adaptiveBeam === true;
  out.adaptiveBeamSchedule = strategy.adaptiveBeamSchedule || ctx.adaptiveBeamSchedule || null;
  out.adaptiveSecondaryBeamSchedule = strategy.adaptiveSecondaryBeamSchedule || strategy.v56AdaptiveSecondaryBeamSchedule || ctx.adaptiveSecondaryBeamSchedule || ctx.v56AdaptiveSecondaryBeamSchedule || null;
  out.adaptiveFallbackPolicy = strategy.adaptiveFallbackPolicy || strategy.v56AdaptiveFallbackPolicy || ctx.adaptiveFallbackPolicy || ctx.v56AdaptiveFallbackPolicy || null;
  out.adaptiveSafetyFallback = strategy.adaptiveSafetyFallback !== false && ctx.adaptiveSafetyFallback !== false;
  out.adaptivePrimaryBudgetMs = strategy.adaptivePrimaryBudgetMs != null ? strategy.adaptivePrimaryBudgetMs : ctx.adaptivePrimaryBudgetMs;
  out.adaptivePrimaryBudgetFraction = strategy.adaptivePrimaryBudgetFraction != null ? strategy.adaptivePrimaryBudgetFraction : ctx.adaptivePrimaryBudgetFraction;
  out.adaptiveFallbackMinBudgetMs = strategy.adaptiveFallbackMinBudgetMs != null ? strategy.adaptiveFallbackMinBudgetMs : ctx.adaptiveFallbackMinBudgetMs;
  out.adaptiveSmartEnemyThreshold = strategy.adaptiveSmartEnemyThreshold != null ? strategy.adaptiveSmartEnemyThreshold : ctx.adaptiveSmartEnemyThreshold;
  out.adaptiveDualPhase2BudgetMs = strategy.adaptiveDualPhase2BudgetMs != null ? strategy.adaptiveDualPhase2BudgetMs : ctx.adaptiveDualPhase2BudgetMs;
  out.adaptiveDualPhase2Fraction = strategy.adaptiveDualPhase2Fraction != null ? strategy.adaptiveDualPhase2Fraction : ctx.adaptiveDualPhase2Fraction;
  out.adaptiveDualFixedReserveMs = strategy.adaptiveDualFixedReserveMs != null ? strategy.adaptiveDualFixedReserveMs : ctx.adaptiveDualFixedReserveMs;
  out.adaptiveDualFixedMinBudgetMs = strategy.adaptiveDualFixedMinBudgetMs != null ? strategy.adaptiveDualFixedMinBudgetMs : ctx.adaptiveDualFixedMinBudgetMs;
  out.adaptiveTimeBoxPhase1BudgetMs = strategy.adaptiveTimeBoxPhase1BudgetMs != null ? strategy.adaptiveTimeBoxPhase1BudgetMs : ctx.adaptiveTimeBoxPhase1BudgetMs;
  out.adaptiveTimeBoxPhase2BudgetMs = strategy.adaptiveTimeBoxPhase2BudgetMs != null ? strategy.adaptiveTimeBoxPhase2BudgetMs : ctx.adaptiveTimeBoxPhase2BudgetMs;
  out.adaptiveTimeBoxFixedReserveMs = strategy.adaptiveTimeBoxFixedReserveMs != null ? strategy.adaptiveTimeBoxFixedReserveMs : ctx.adaptiveTimeBoxFixedReserveMs;
  out._nextKillSeekCache = null;
  out.auditDuringSearch = false;
  out.fastSearchPathV58A = strategy.fastSearchPathV58A !== false && ctx.fastSearchPathV58A !== false;
  out.deadlineMs = deadlineMs || 0;
  return out;
}

function makePortfolioStrategies(baseBeamWidth, payload) {
  var wide = Math.max(baseBeamWidth, Math.min(10000, payload.wideBeamWidth || 5000));
  var compact = Math.max(400, Math.min(10000, baseBeamWidth));
  var mid = Math.max(compact, Math.min(10000, Math.round((compact + wide) / 2)));
  var arr = [
    { id: "beam_v24_base", label: "Beam V24 base", beamWidth: compact, diversityEnabled: true, diversityEliteRatio: 0.65 },
    { id: "beam_v24_explore", label: "Beam exploration", beamWidth: compact, diversityEnabled: true, diversityEliteRatio: 0.42 },
    { id: "beam_score_pur", label: "Beam score pur", beamWidth: compact, diversityEnabled: false, diversityEliteRatio: 1.0 },
    { id: "beam_mid", label: "Beam intermédiaire", beamWidth: mid, diversityEnabled: true, diversityEliteRatio: 0.58 },
    { id: "beam_large", label: "Beam large", beamWidth: wide, diversityEnabled: true, diversityEliteRatio: 0.65 }
  ];
  // Si l'utilisateur met déjà 5000, éviter deux stratégies identiques trop coûteuses.
  var seen = new Set(), unique = [];
  for (var i = 0; i < arr.length; i++) {
    var key = arr[i].id + ":" + arr[i].beamWidth + ":" + arr[i].diversityEnabled + ":" + arr[i].diversityEliteRatio;
    if (seen.has(key)) continue;
    seen.add(key); unique.push(arr[i]);
  }
  return unique;
}

function summarizeStrategyResult(strategy, res, elapsedMs, status, note, ctx) {
  var fs = res && res.finalState ? res.finalState : null;
  var rs = res && res.runSummary ? res.runSummary : {};
  var finalProbe = (res && ctx && ctx.searchDebugV34) ? v34FinalStateProbe(res, ctx) : null;
  return {
    id: strategy.id,
    label: strategy.label,
    status: status || (res ? (res.win ? "ok" : "partial") : "no_plan"),
    note: note || null,
    win: !!(res && res.win),
    reason: res ? (res.win ? "ok" : "partial") : "no_plan",
    beam_width: strategy.beamWidth,
    diversity_enabled: strategy.diversityEnabled !== false,
    diversity_elite_ratio: strategy.diversityEliteRatio,
    enemies_remaining: fs ? fs.enemies.size : null,
    pv_final: fs ? fs.pv : null,
    pa_final: fs ? fs.pa : null,
    turn_final: fs ? fs.turn : null,
    turns_elapsed: fs ? Math.max(0, fs.turn - DEFAULT_TURN) : null,
    actions: res && res.planRaw ? res.planRaw.length : 0,
    expanded_nodes: res ? res.expanded : 0,
    elapsed_ms: elapsedMs || 0,
    score: res && res.finalScore != null ? res.finalScore : null,
    time_budget_hit: !!(rs && rs.time_budget_hit),
    max_depth_seen: rs && rs.max_depth_seen != null ? rs.max_depth_seen : null,
    final_metrics: res && res.finalMetrics ? res.finalMetrics : null,
    final_probe_v34: finalProbe,
    t6_virtual_end_score: !!(strategy && strategy.t6VirtualEndScore),
    next_kill_seek_score: !!(strategy && strategy.nextKillSeekScore),
    v44_stochastic_restart: !!(strategy && strategy.v44StochasticRestart),
    v44_stochastic_profile: strategy && strategy.v44StochasticProfile ? strategy.v44StochasticProfile : null,
    v44_jitter_strength: strategy && strategy.v44JitterStrength != null ? strategy.v44JitterStrength : null,
    v45_profile_sweep: !!(strategy && strategy.v45ProfileSweep),
    v45_profile_name: strategy && strategy.v45ProfileName ? strategy.v45ProfileName : null,
    v45_profile_components: strategy && strategy.v45ProfileComponents ? strategy.v45ProfileComponents : null,
    v45_profile_intensity: strategy && strategy.v45ProfileIntensity != null ? strategy.v45ProfileIntensity : null,
    adaptive_beam: rs && rs.adaptive_beam ? rs.adaptive_beam : null,
    search_debug_v34: rs && rs.search_debug_v34 ? rs.search_debug_v34 : null,
    beam_clean_v38: rs && rs.v38_enabled ? {
      enabled: !!rs.v38_enabled,
      mode: rs.v38_mode || null,
      probe_top_n: rs.v38_probe_top_n,
      window_size_max: rs.v38_window_size_max || 0,
      deep_stride_min: rs.v38_deep_stride_min,
      selected_elite: rs.v38_selected_elite || 0,
      selected_line: rs.v38_selected_line || 0,
      selected_kill: rs.v38_selected_kill || 0,
      selected_survival: rs.v38_selected_survival || 0,
      selected_low_enemy: rs.v38_selected_low_enemy || 0,
      selected_deep_tail: rs.v38_selected_deep_tail || 0,
      selected_next_kill: rs.v42_selected_next_kill || 0,
      next_kill_enabled: !!rs.v42_next_kill_enabled,
      next_kill_probe_top_n: rs.v42_next_kill_probe_top_n_max || null,
      v44_lane_profile: rs.v44_lane_profile || null,
      selected_diversity_fill: rs.v38_selected_diversity_fill || 0,
      selected_score_fill: rs.v38_selected_score_fill || 0,
      best_line_score_max: rs.v38_best_line_score_max
    } : null
  };
}

function compareCoreResults(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a.win !== b.win) return a.win ? -1 : 1;
  var ae = a.finalState.enemies.size, be = b.finalState.enemies.size;
  if (ae !== be) return ae - be;
  if (a.win && a.planRaw.length !== b.planRaw.length) return a.planRaw.length - b.planRaw.length;
  if (a.finalState.pv !== b.finalState.pv) return b.finalState.pv - a.finalState.pv;
  if (a.planRaw.length !== b.planRaw.length) return a.planRaw.length - b.planRaw.length;
  return (b.finalScore || -Infinity) - (a.finalScore || -Infinity);
}

function solvePortfolio(state0, beamWidth, maxSteps, ctx, payload) {
  var budgetMs = effectiveTimeBudgetMsV58A1(payload, 55000);
  var started = Date.now();
  var deadlineMs = started + budgetMs;
  var strategies = makePortfolioStrategies(beamWidth, payload || {});
  var results = [];
  var best = null;

  for (var i = 0; i < strategies.length; i++) {
    var strategy = strategies[i];
    if (Date.now() >= deadlineMs) {
      results.push(summarizeStrategyResult(strategy, null, 0, "skipped", "budget épuisé", ctx));
      continue;
    }
    var sctx = cloneContextForStrategy(ctx, strategy, deadlineMs);
    var t0 = Date.now();
    var res = strategy.adaptiveBeam === true
      ? solveCoreAdaptiveBeamWithSafetyFallback(state0, strategy.beamWidth, strategy.maxSteps || maxSteps, sctx, strategy)
      : solveCore(state0, strategy.beamWidth, strategy.maxSteps || maxSteps, sctx, strategy);
    var dt = Date.now() - t0;
    if (res) {
      results.push(summarizeStrategyResult(strategy, res, dt, null, null, sctx));
      if (best === null || compareCoreResults(res, best) < 0) best = res;
    } else {
      results.push(summarizeStrategyResult(strategy, null, dt, "no_plan", "aucun état survivant", sctx));
    }
    // Si on a une victoire par beam large, inutile de relancer des variantes plus coûteuses ensuite.
    // Les stratégies précédentes restent affichées, et l'audit final porte sur la meilleure victoire.
    if (best && best.win && strategy.id === "beam_large") break;
  }

  if (!best) return null;
  best.portfolioResults = results;
  best.portfolioSummary = {
    enabled: true,
    total_elapsed_ms: Date.now() - started,
    budget_ms: budgetMs,
    budget_mode: "shared",
    effective_budget_ms: budgetMs,
    strategy_count: strategies.length,
    completed_count: results.filter(function (r) { return r.status !== "skipped"; }).length,
    winner_id: best.strategy && best.strategy.id,
    winner_label: best.strategy && best.strategy.label
  };
  return best;
}


// ============================================================
// LIMITED DISCREPANCY SEARCH V27
// ------------------------------------------------------------
// Idée : l'heuristique locale est souvent correcte, mais pas toujours.
// On explore d'abord les meilleurs choix locaux, puis on autorise progressivement
// quelques désaccords avec ce classement. Simulation inchangée ; seul l'ordre
// d'exploration change.
// ============================================================
function ldsDiscrepancyCost(rank) {
  if (rank <= 0) return 0;
  if (rank === 1) return 1;
  if (rank === 2) return 2;
  return 3; // les rangs lointains restent accessibles sans exploser le budget.
}
function makeLdsPassStats(pass, discBudget) {
  return {
    depth: pass,
    lds_pass: pass,
    discrepancy_budget: discBudget,
    expanded: 0,
    generated: 0,
    legal: 0,
    rejected: 0,
    rejected_by_reason: {},
    child_candidates: 0,
    child_considered: 0,
    discrepancy_cut: 0,
    top_action_cut: 0,
    pruned_tt_dominated: 0,
    pruned_useless_end_turn: 0,
    pruned_recent_cycle: 0,
    pruned_hp_bound_parent: 0,
    pruned_hp_bound_child: 0,
    tt_remembered_new: 0,
    tt_remembered_replaced: 0,
    wins_found: 0,
    best_enemies_remaining: null,
    best_score: null,
    max_depth_seen: 0,
    tt_size_after_pass: 0,
  };
}
function ldsTtDominates(tt, node, discLeft) {
  var s = node.state;
  var key = tacticalKey(s);
  var prev = tt.byTactical.get(key);
  if (prev === undefined) return { dominated: false, reason: "TT_NEW" };
  // Même état tactique : PV, profondeur ET discrepancy restant comptent.
  // Un état atteint avec plus de discrepancy restant peut encore explorer plus d'écarts.
  if ((prev.pv > s.pv && prev.discLeft >= discLeft) ||
      (prev.pv === s.pv && prev.depth <= node.depth && prev.discLeft >= discLeft)) {
    return { dominated: true, reason: "TT_DOMINATED", previous: prev };
  }
  return { dominated: false, reason: "TT_CAN_REPLACE", previous: prev };
}
function ldsRememberNode(tt, node, discLeft) {
  var s = node.state;
  var key = tacticalKey(s);
  var prev = tt.byTactical.get(key);
  var entry = { pv: s.pv, depth: node.depth, score: node.score, enemies: s.enemies.size, discLeft: discLeft };
  if (prev !== undefined) {
    if ((prev.pv > s.pv && prev.discLeft >= discLeft) ||
        (prev.pv === s.pv && prev.depth <= node.depth && prev.discLeft >= discLeft)) {
      tt.dominated++;
      return "TT_DOMINATED";
    }
    tt.replaced++;
  } else {
    tt.stored++;
  }
  tt.byTactical.set(key, entry);
  return prev === undefined ? "TT_NEW" : "TT_REPLACED";
}
function shouldPruneChildLds(parentNode, action, childNode, tt, discLeftAfter, stats) {
  var st = parentNode.state;
  var child = childNode.state;
  if (isUselessEndTurn(st, action, child)) {
    stats.pruned_useless_end_turn++;
    return { prune: true, reason: "USELESS_END_TURN" };
  }
  if (isRecentCycleDominated(parentNode, child, 24)) {
    stats.pruned_recent_cycle++;
    return { prune: true, reason: "RECENT_CYCLE_DOMINATED" };
  }
  var ttRes = ldsTtDominates(tt, childNode, discLeftAfter);
  if (ttRes.dominated) {
    stats.pruned_tt_dominated++;
    return { prune: true, reason: ttRes.reason };
  }
  return { prune: false, reason: ttRes.reason };
}
function compareLdsChildOrder(a, b) {
  if (a.node.state.enemies.size !== b.node.state.enemies.size) return a.node.state.enemies.size - b.node.state.enemies.size;
  if (a.node.score !== b.node.score) return b.node.score - a.node.score;
  if (a.node.state.pv !== b.node.state.pv) return b.node.state.pv - a.node.state.pv;
  return a.node.depth - b.node.depth;
}
function makeLdsRunSummary(passStats, ttSummaries, startedAt, timeBudgetHit, opts, bestNode, winNode) {
  var sum = {
    solver_engine: "lds_v27",
    strategy_label: "LDS V27",
    lds_max_discrepancy: opts.maxDiscrepancy,
    lds_top_actions: opts.topActions,
    lds_found_discrepancy: winNode ? winNode.lds_discrepancy_budget : null,
    lds_passes_completed: passStats.length,
    time_budget_hit: !!timeBudgetHit,
    elapsed_ms: Date.now() - startedAt,
    max_depth_seen: 0,
    expanded_total: 0,
    generated_total: 0,
    legal_total: 0,
    rejected_total: 0,
    discrepancy_cut: 0,
    top_action_cut: 0,
    pruned_tt_dominated: 0,
    pruned_useless_end_turn: 0,
    pruned_recent_cycle: 0,
    pruned_hp_bound_parent: 0,
    pruned_hp_bound_child: 0,
    tt_size: 0,
    tt_stored: 0,
    tt_replaced: 0,
    tt_dominated: 0,
    diversity_enabled: false,
    diversity_mode: "lds_ranked_actions"
  };
  for (var i = 0; i < passStats.length; i++) {
    var s = passStats[i];
    sum.expanded_total += s.expanded || 0;
    sum.generated_total += s.generated || 0;
    sum.legal_total += s.legal || 0;
    sum.rejected_total += s.rejected || 0;
    sum.discrepancy_cut += s.discrepancy_cut || 0;
    sum.top_action_cut += s.top_action_cut || 0;
    sum.pruned_tt_dominated += s.pruned_tt_dominated || 0;
    sum.pruned_useless_end_turn += s.pruned_useless_end_turn || 0;
    sum.pruned_recent_cycle += s.pruned_recent_cycle || 0;
    sum.pruned_hp_bound_parent += s.pruned_hp_bound_parent || 0;
    sum.pruned_hp_bound_child += s.pruned_hp_bound_child || 0;
    if ((s.max_depth_seen || 0) > sum.max_depth_seen) sum.max_depth_seen = s.max_depth_seen || 0;
  }
  for (var j = 0; j < ttSummaries.length; j++) {
    var t = ttSummaries[j];
    if ((t.size || 0) > sum.tt_size) sum.tt_size = t.size || 0;
    sum.tt_stored += t.stored || 0;
    sum.tt_replaced += t.replaced || 0;
    sum.tt_dominated += t.dominated || 0;
  }
  if (bestNode) {
    sum.best_enemies_remaining = bestNode.state.enemies.size;
    sum.best_score = bestNode.score;
    sum.best_depth = bestNode.depth;
  }
  return sum;
}
function solveLDS(state0, maxSteps, ctx, payload) {
  payload = payload || {};
  var budgetMs = effectiveTimeBudgetMsV58A1(payload, 55000);
  var started = Date.now();
  var deadlineMs = started + budgetMs;
  var opts = {
    maxDiscrepancy: Math.max(0, Math.min(40, payload.ldsMaxDiscrepancy != null ? Number(payload.ldsMaxDiscrepancy) || 0 : 6)),
    topActions: Math.max(1, Math.min(13, payload.ldsTopActions != null ? Number(payload.ldsTopActions) || 8 : 8))
  };
  var root = makeNode(state0, null, null, ctx, null, 0);
  var bestPartial = root;
  var bestWinning = null;
  var expanded = 0;
  var timeBudgetHit = false;
  var passStats = [];
  var ttSummaries = [];

  function updateBest(node) {
    if (!bestPartial || compareResultNodes(node, bestPartial) < 0) bestPartial = node;
  }

  function dfs(node, depth, discLeft, stats, tt, passBudget) {
    if ((stats.expanded & 255) === 0 && Date.now() >= deadlineMs) { timeBudgetHit = true; return true; }
    updateBest(node);
    if (isWin(node.state)) {
      bestWinning = node;
      bestWinning.lds_discrepancy_budget = passBudget;
      stats.wins_found++;
      return true;
    }
    if (depth >= maxSteps) return false;
    if (minHpToFinish(node.state) > node.state.pv) { stats.pruned_hp_bound_parent++; return false; }

    expanded++;
    stats.expanded++;
    if (depth > stats.max_depth_seen) stats.max_depth_seen = depth;

    var ex = expandForSearch(node.state, ctx);
    stats.generated += ex.all_count != null ? ex.all_count : ((ex.legal_count || 0) + (ex.rejected_count || 0));
    stats.legal += ex.legal_count != null ? ex.legal_count : ex.children.length;
    stats.rejected += ex.rejected_count || 0;
    if (ex.rejected_by_reason) {
      Object.keys(ex.rejected_by_reason).forEach(function (k) { stats.rejected_by_reason[k] = (stats.rejected_by_reason[k] || 0) + ex.rejected_by_reason[k]; });
    }

    var candidates = [];
    var childCount = ex.fast_v58a ? ex.states.length : ex.children.length;
    for (var i = 0; i < childCount; i++) {
      var action = ex.fast_v58a ? ex.actions[i] : ex.children[i][0];
      var child = ex.fast_v58a ? ex.states[i] : ex.children[i][1];
      var diag = ex.fast_v58a ? null : ex.children[i][2];
      var fastEffects = ex.fast_v58a ? ex.effects[i] : null;
      var childNode = makeSearchNodeV58A(child, node, action, ctx, diag, fastEffects, node.depth + 1);
      if (minHpToFinish(child) > child.pv) { stats.pruned_hp_bound_child++; continue; }
      candidates.push({ action: action, node: childNode });
    }
    candidates.sort(compareLdsChildOrder);
    stats.child_candidates += candidates.length;
    if (candidates.length > opts.topActions) stats.top_action_cut += (candidates.length - opts.topActions);

    var n = Math.min(opts.topActions, candidates.length);
    for (var r = 0; r < n; r++) {
      var cost = ldsDiscrepancyCost(r);
      if (cost > discLeft) { stats.discrepancy_cut++; continue; }
      var cn = candidates[r].node;
      var discAfter = discLeft - cost;
      var pr = shouldPruneChildLds(node, candidates[r].action, cn, tt, discAfter, stats);
      if (pr.prune) continue;
      var mem = ldsRememberNode(tt, cn, discAfter);
      if (mem === "TT_REPLACED") stats.tt_remembered_replaced++;
      else if (mem === "TT_NEW") stats.tt_remembered_new++;
      stats.child_considered++;
      if (dfs(cn, depth + 1, discAfter, stats, tt, passBudget)) return true;
      if (timeBudgetHit) return true;
    }
    return false;
  }

  for (var d = 0; d <= opts.maxDiscrepancy; d++) {
    if (Date.now() >= deadlineMs) { timeBudgetHit = true; break; }
    var stats = makeLdsPassStats(d, d);
    var tt = makeTranspositionTable();
    ldsRememberNode(tt, root, d);
    dfs(root, 0, d, stats, tt, d);
    stats.tt_size_after_pass = tt.byTactical.size;
    stats.best_enemies_remaining = bestPartial ? bestPartial.state.enemies.size : null;
    stats.best_score = bestPartial ? bestPartial.score : null;
    passStats.push(stats);
    ttSummaries.push({ size: tt.byTactical.size, stored: tt.stored, replaced: tt.replaced, dominated: tt.dominated });
    if (bestWinning || timeBudgetHit) break;
  }

  var resultNode = bestWinning || bestPartial;
  if (!resultNode) return null;
  var planRaw = [];
  for (var n2 = resultNode; n2 !== null && n2.action !== null; n2 = n2.parent) planRaw.push(n2.action);
  planRaw.reverse();
  var runSummary = makeLdsRunSummary(passStats, ttSummaries, started, timeBudgetHit, opts, bestPartial, bestWinning);
  return {
    planRaw: planRaw,
    win: !!bestWinning,
    finalState: resultNode.state,
    finalScore: resultNode.score,
    finalMetrics: resultNode.score_metrics || tacticalStateMetrics(resultNode.state, ctx),
    expanded: expanded,
    depthStats: passStats,
    runSummary: runSummary,
    strategy: { id: "lds_v27", label: "LDS V27", maxDiscrepancy: opts.maxDiscrepancy, topActions: opts.topActions }
  };
}

// ============================================================
// LIBELLÉS (directions ÉCRAN iso, cohérentes avec le rendu de bolgrot.html)
// ============================================================
function dirNameOrtho(dx, dy) {
  if (dx === 1 && dy === 0) return "bas-droite";
  if (dx === -1 && dy === 0) return "haut-gauche";
  if (dx === 0 && dy === 1) return "bas-gauche";
  if (dx === 0 && dy === -1) return "haut-droite";
  return "?";
}
function dirNameDiag(dx, dy) {
  if (dx === 1 && dy === 1) return "bas";
  if (dx === -1 && dy === -1) return "haut";
  if (dx === 1 && dy === -1) return "droite";
  if (dx === -1 && dy === 1) return "gauche";
  return "?";
}
function dirNameAny(dx, dy) {
  return (dx !== 0 && dy !== 0) ? dirNameDiag(dx, dy) : dirNameOrtho(dx, dy);
}
function actionLabel(a, st, ctx) {
  var W = ctx.W; var px = st.player % W, py = (st.player / W) | 0;
  if (a.kind === "end") return "FIN DE TOUR";
  if (a.kind === "astral") return "BOND ASTRAL " + dirNameOrtho(a.dx, a.dy) + " \u2192 (" + (px + a.dx) + "," + (py + a.dy) + ")";
  if (a.kind === "double") return "BOND DOUBLE " + dirNameOrtho(a.dx, a.dy) + " x2 \u2192 (" + (px + 2 * a.dx) + "," + (py + 2 * a.dy) + ")";
  if (a.kind === "immo") return "IMMOBILISME " + dirNameDiag(a.dx, a.dy) + " \u2192 cible (" + (px + a.dx) + "," + (py + a.dy) + ")";
  return "?";
}

// Case du feu tué par une action (ou null) — pour l'affichage / la L1.
function killedCellOf(a, st, ctx) {
  if (a.kind !== "astral" && a.kind !== "double") return null;
  var W = ctx.W, H = ctx.H;
  var px = st.player % W, py = (st.player / W) | 0;
  var dist = (a.kind === "double") ? 2 : 1;
  var tx = px + a.dx * dist, ty = py + a.dy * dist;
  if (tx < 0 || tx >= W || ty < 0 || ty >= H) return null;
  var target = ty * W + tx;
  return st.enemies.has(target) ? [tx, ty] : null;
}

function topLegalAlternatives(records, chosenAction, limit) {
  var arr = records.filter(function (r) { return r.ok && !sameAction(r.action_raw, chosenAction); });
  arr.sort(function (a, b) { return (b.score_total || -Infinity) - (a.score_total || -Infinity); });
  return arr.slice(0, limit == null ? 8 : limit);
}
function summarizeRejected(records, limit) {
  var counts = {};
  for (var i = 0; i < records.length; i++) incCounter(counts, records[i].reject_reason || "REJECTED");
  return { total: records.length, by_reason: counts, examples: records.slice(0, limit == null ? 12 : limit) };
}

// Audit par étape : depuis l'état avant action, liste l'action choisie, les alternatives légales,
// et les actions rejetées avec leurs raisons. C'est volontairement recalculé à froid pour
// rendre l'export autonome et vérifiable.
function buildPlanAudit(state0, planRaw, ctx) {
  var audits = [];
  var st = state0;
  for (var i = 0; i < planRaw.length; i++) {
    var a = planRaw[i];
    var expansion = expandDetailed(st, ctx);
    var chosen = null;
    for (var k = 0; k < expansion.all.length; k++) {
      if (sameAction(expansion.all[k].action_raw, a)) { chosen = expansion.all[k]; break; }
    }
    var sim = simulateActionDetailed(st, a, ctx);
    var audit = {
      step_index: i,
      state_before: summarizeStateLite(st, ctx),
      chosen_action: actionLabel(a, st, ctx),
      chosen: chosen || actionDiagnosticRecord(st, a, sim, ctx),
      legal_count: expansion.legal.length,
      rejected_count: expansion.rejected.length,
      legal_alternatives_top: topLegalAlternatives(expansion.legal, a, 8),
      rejected_summary: summarizeRejected(expansion.rejected, 12)
    };
    audits.push(audit);
    if (!sim.ok) break;
    st = sim.state;
  }
  return audits;
}

// Rejoue le plan -> états PRÉDITS pas à pas (base de comparaison pour la L1), enrichis V22.
function replayPlanToSteps(state0, planRaw, ctx, planAudit) {
  var steps = [];
  var st = state0;
  for (var i = 0; i < planRaw.length; i++) {
    var a = planRaw[i];
    var label = actionLabel(a, st, ctx);
    var killed = killedCellOf(a, st, ctx);
    var sim = simulateActionDetailed(st, a, ctx);
    if (!sim.ok) break;
    var ns = sim.state;
    var ev = scoreNodeDetailed(ns, ctx, st, a, sim);
    steps.push({
      step_index: i,
      action: label,
      action_raw: cloneAction(a),
      killed: killed,
      player: idxToCell(ns.player, ctx),
      enemies: Array.from(ns.enemies).sort(function (x, y) { return x - y; }).map(function (e) { return idxToCell(e, ctx); }),
      glyphs: Array.from(ns.glyphs || []).sort(function (x, y) { return x - y; }).map(function (g) { return idxToCell(g, ctx); }),
      glyphs_remaining: ns.glyphs ? ns.glyphs.size : 0,
      enemies_remaining: ns.enemies.size,
      pv: ns.pv, pa: ns.pa, doubles: ns.doubles, game_turn: ns.turn,
      score_total: ev.total,
      score_parts: ev.parts,
      score_metrics: ev.metrics,
      effects: sim.effects,
      risk: sim.risk,
      audit: planAudit ? planAudit[i] : null
    });
    st = ns;
  }
  return steps;
}

// ============================================================
// CONTEXTE & ÉTAT INITIAL (depuis un payload)
// ============================================================
function parseFutureGlyphWaves(raw) {
  var out = {};
  if (!raw) return out;
  Object.keys(raw).forEach(function (k) {
    var t = Number(k);
    if (!isFinite(t) || t < 1 || t > 6) return;
    var arr = raw[k] || [];
    var set = new Set();
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (!Array.isArray(c) || c.length < 2) continue;
      var x = Number(c[0]), y = Number(c[1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      x = Math.floor(x); y = Math.floor(y);
      var W0 = DEFAULT_BOARD[0].length, H0 = DEFAULT_BOARD.length;
      if (x < 0 || y < 0 || x >= W0 || y >= H0) continue;
      set.add(y * W0 + x);
    }
    out[t] = set;
  });
  return out;
}

function buildContext(payload) {
  var board = payload.board || DEFAULT_BOARD;
  var H = board.length;
  var W = board[0].length;
  var blocked = new Set();
  for (var gy = 0; gy < H; gy++) {
    var row = board[gy];
    for (var gx = 0; gx < W; gx++) {
      if (row[gx] === "#") blocked.add(gy * W + gx);
    }
  }
  var bol = payload.bolgrot || DEFAULT_BOLGROT;
  blocked.add(bol[1] * W + bol[0]);   // le bolgrot agit comme un mur
  var futureGlyphWaves = parseFutureGlyphWaves(payload.futureGlyphWaves || payload.future_glyph_waves || payload.future_glyphs_by_turn);

  return {
    W: W, H: H, blocked: blocked,
    cornerMode: payload.cornerMode || "current",    // V20 : "current" recommandé ; "reserved" conservé seulement en compat
    prudentAstralEmptyTarget: payload.prudentAstralEmptyTarget === true,
    prudentAstralKillCollision: payload.prudentAstralKillCollision === true,
    fatalAdjacentEmptyLanding: payload.fatalAdjacentEmptyLanding !== false,
    playerBlocksDiagonalCorner: payload.playerBlocksDiagonalCorner !== false,
    prudentLandingMultiClaim: payload.prudentLandingMultiClaim !== false,
    prudentRepulsedOriginReclaim: payload.prudentRepulsedOriginReclaim !== false,
    prudentChainPressureToPlayer: payload.prudentChainPressureToPlayer !== false,
    prudentDoubleDiagonalCornerIntermediatePressure: payload.prudentDoubleDiagonalCornerIntermediatePressure !== false,
    diversityEnabled: payload.diversityEnabled !== false,
    diversityEliteRatio: (payload.diversityEliteRatio != null ? Number(payload.diversityEliteRatio) : DIVERSITY_ELITE_RATIO_DEFAULT),
    // V34 : instrumentation de recherche uniquement. Ne change pas la simulation
    // ni le scoring par défaut ; ajoute des métriques Pareto/debug si demandé.
    searchDebugV34: payload.searchDebugV34 === true,
    paretoProbeTopN: Math.max(20, Math.min(500, Number(payload.paretoProbeTopN) || 120)),
    paretoProbeEvery: Math.max(1, Math.min(20, Number(payload.paretoProbeEvery) || 1)),
    // V38A : sélection multi-lanes. Ne change pas les règles de simulation.
    v38MultiLane: payload.v38MultiLane !== false,
    v38ProbeTopN: Math.max(40, Math.min(800, Number(payload.v38ProbeTopN) || 120)),
    // V42 : scoring expérimental T6 → T7 projeté. Désactivé par défaut et activé
    // uniquement par les stratégies qui le demandent.
    t6VirtualEndScore: payload.t6VirtualEndScore === true,
    // V43 : scoring expérimental “chercher le prochain kill”. Désactivé par défaut.
    nextKillSeekScore: payload.nextKillSeekScore === true,
    nextKillProbeTopN: Math.max(24, Math.min(300, Number(payload.nextKillProbeTopN) || 120)),
    v44StochasticRestart: payload.v44StochasticRestart === true,
    v44StochasticProfile: payload.v44StochasticProfile || 'mix',
    v44LaneProfile: payload.v44LaneProfile || null,
    v44StochasticSeed: payload.v44StochasticSeed || 'v44',
    v44JitterStrength: Math.max(0, Math.min(2, Number(payload.v44JitterStrength) || 0.35)),
    v45ProfileSweep: payload.v45ProfileSweep === true,
    v45ProfileName: payload.v45ProfileName || null,
    v45ProfileComponents: payload.v45ProfileComponents || null,
    v45ProfileIntensity: Math.max(0, Math.min(2.5, Number(payload.v45ProfileIntensity) || 1)),
    v45LateBias: payload.v45LateBias === true,
    adaptiveBeam: payload.adaptiveBeam === true,
    adaptiveBeamSchedule: Array.isArray(payload.adaptiveBeamSchedule) ? payload.adaptiveBeamSchedule.slice() : null,
    adaptiveSecondaryBeamSchedule: Array.isArray(payload.adaptiveSecondaryBeamSchedule) ? payload.adaptiveSecondaryBeamSchedule.slice() : (Array.isArray(payload.v56AdaptiveSecondaryBeamSchedule) ? payload.v56AdaptiveSecondaryBeamSchedule.slice() : null),
    v56AdaptiveSecondaryBeamSchedule: Array.isArray(payload.v56AdaptiveSecondaryBeamSchedule) ? payload.v56AdaptiveSecondaryBeamSchedule.slice() : null,
    adaptiveFallbackPolicy: payload.adaptiveFallbackPolicy || payload.v56AdaptiveFallbackPolicy || null,
    adaptiveBeamEscalation: payload.adaptiveBeamEscalation === true,
    adaptiveBeamEscalationFactor: payload.adaptiveBeamEscalationFactor || null,
    adaptiveBeamEscalationMaxMult: payload.adaptiveBeamEscalationMaxMult || null,
    adaptiveBeamEscalationMaxSteps: payload.adaptiveBeamEscalationMaxSteps || null,
    adaptiveFixedFallbackFraction: payload.adaptiveFixedFallbackFraction != null ? payload.adaptiveFixedFallbackFraction : null,
    adaptiveSafetyFallback: payload.adaptiveSafetyFallback !== false,
    // V58A.3 : sur l'outil final, le profil Adaptive V56E late ne doit plus
    // rester plafonné par l'ancien budget interne (~18 s). Si la page finale
    // demande explicitement le mode utilisateur, on donne presque tout le
    // budget global à la phase adaptive principale. Le fallback fixe reste
    // possible seulement s'il reste réellement du temps.
    adaptivePrimaryBudgetMs: payload.adaptivePrimaryBudgetMs != null ? Number(payload.adaptivePrimaryBudgetMs) : (
      (payload.finalUserSolverV58A4 === true || payload.finalUserSolverV58A3 === true || payload.finalUserSolverV58A1 === true) && payload.timeBudgetMs != null
        ? Math.max(500, Math.floor(Number(payload.timeBudgetMs) - Math.max(0, Number(payload.adaptiveFinalUserFallbackReserveMs) || 500)))
        : null
    ),
    adaptivePrimaryBudgetFraction: payload.adaptivePrimaryBudgetFraction != null ? Number(payload.adaptivePrimaryBudgetFraction) : null,
    adaptiveFallbackMinBudgetMs: payload.adaptiveFallbackMinBudgetMs != null ? Number(payload.adaptiveFallbackMinBudgetMs) : (
      (payload.finalUserSolverV58A4 === true || payload.finalUserSolverV58A3 === true || payload.finalUserSolverV58A1 === true) ? 500 : null
    ),
    adaptiveSmartEnemyThreshold: payload.adaptiveSmartEnemyThreshold != null ? Number(payload.adaptiveSmartEnemyThreshold) : null,
    adaptiveDualPhase2BudgetMs: payload.adaptiveDualPhase2BudgetMs != null ? Number(payload.adaptiveDualPhase2BudgetMs) : null,
    adaptiveDualPhase2Fraction: payload.adaptiveDualPhase2Fraction != null ? Number(payload.adaptiveDualPhase2Fraction) : null,
    adaptiveDualFixedReserveMs: payload.adaptiveDualFixedReserveMs != null ? Number(payload.adaptiveDualFixedReserveMs) : null,
    adaptiveDualFixedMinBudgetMs: payload.adaptiveDualFixedMinBudgetMs != null ? Number(payload.adaptiveDualFixedMinBudgetMs) : null,
    adaptiveTimeBoxPhase1BudgetMs: payload.adaptiveTimeBoxPhase1BudgetMs != null ? Number(payload.adaptiveTimeBoxPhase1BudgetMs) : null,
    adaptiveTimeBoxPhase2BudgetMs: payload.adaptiveTimeBoxPhase2BudgetMs != null ? Number(payload.adaptiveTimeBoxPhase2BudgetMs) : null,
    adaptiveTimeBoxFixedReserveMs: payload.adaptiveTimeBoxFixedReserveMs != null ? Number(payload.adaptiveTimeBoxFixedReserveMs) : null,
    adaptiveFinalUserFallbackReserveMs: payload.adaptiveFinalUserFallbackReserveMs != null ? Number(payload.adaptiveFinalUserFallbackReserveMs) : null,
    finalUserSolverV58A1: payload.finalUserSolverV58A1 === true || !!payload.solverProfileId || !!payload.solverProfileName,
    finalUserSolverV58A4: payload.finalUserSolverV58A4 === true,
    futureGlyphWaves: futureGlyphWaves,
    fastSearchPathV58A: payload.fastSearchPathV58A !== false,
    // V63B : résultat lean réservé au fast path de recherche.
    leanFastSearchResultV63B: payload.fastSearchPathV58A !== false && payload.leanFastSearchResultV63B !== false,
    // V61 : optimisation exacte de la sélection beam.
    // Mémoïse les scores de lanes et les clés de sélection pendant selectBeamV38.
    beamSelectionCacheV61: payload.beamSelectionCacheV61 !== false,
    // V62 : cache exact de scoreStateDetailed, attaché au contexte courant.
    scoringCacheV62: payload.scoringCacheV62 !== false,
  };
}

function buildInitialState(payload, ctx) {
  var W = ctx.W;
  var pl = payload.player || DEFAULT_PLAYER;
  var enemies = new Set();
  var elist = payload.enemies || [];
  for (var i = 0; i < elist.length; i++) enemies.add(elist[i][1] * W + elist[i][0]);
  var pv = (payload.pv != null) ? payload.pv : DEFAULT_PV;
  var pa = (payload.pa != null) ? payload.pa : DEFAULT_PA;
  var turn = (payload.turn != null) ? payload.turn : DEFAULT_TURN;
  var doubles = (payload.doubles != null) ? payload.doubles : 0;
  var glyphs = new Set();
  var glist = payload.glyphs || [];
  for (var gi = 0; gi < glist.length; gi++) glyphs.add(glist[gi][1] * W + glist[gi][0]);
  return mkState(pl[1] * W + pl[0], enemies, pv, pa, doubles, turn, glyphs);
}


// ============================================================
// SOLVABILITY LAB V29 — beams ciblés + variantes d'état initial
// ------------------------------------------------------------
// Objectif : distinguer un échec de recherche d'un état probablement déjà perdu.
// On garde très peu de stratégies : Beam exploration rapide et Beam exploration large.
// ============================================================
function normalizeStrategyIdSet(payload) {
  var raw = (payload && (payload.strategyIds || payload.enabledStrategyIds || payload.selectedStrategyIds)) || null;
  if (typeof raw === "string") raw = raw.split(/[;,\s]+/).filter(Boolean);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  var set = new Set();
  for (var i = 0; i < raw.length; i++) if (raw[i] != null && String(raw[i]).trim()) set.add(String(raw[i]).trim());
  return set.size ? set : null;
}
function makeV44StochasticStrategies(compact, payload, requested) {
  payload = payload || {};
  var count = Math.max(1, Math.min(12, Number(payload.stochasticRestartCount) || 4));
  var strength = Math.max(0, Math.min(2, Number(payload.stochasticJitterStrength) || 0.35));
  var seedBase = String(payload.stochasticSeed || payload.seed || 'v44');
  var profiles = ['mix', 'survival', 'line', 'conversion', 't6'];
  var out = [];
  for (var i = 0; i < count; i++) {
    var profile = profiles[i % profiles.length];
    out.push({
      id: 'beam_clean_v44_stochastic_' + (i + 1),
      label: 'Beam Clean stochastic #' + (i + 1) + ' · ' + profile,
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: profile === 'survival' ? 0.44 : (profile === 'line' ? 0.47 : 0.46),
      v38MultiLane: true,
      t6VirtualEndScore: profile === 't6',
      nextKillSeekScore: false,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120,
      v44StochasticRestart: true,
      v44StochasticProfile: profile,
      v44LaneProfile: profile,
      v44StochasticSeed: seedBase + ':restart:' + (i + 1),
      v44JitterStrength: strength
    });
  }
  return out;
}


function makeV45ProfileSweepStrategies(compact, payload, requested) {
  payload = payload || {};
  var defs = [
    { id: 'beam_clean_v45_line_mild', label: 'Beam Clean V45 · line mild', profile: 'line', intensity: 0.70, comps: { line: 0.70 }, elite: 0.48, lane: 'line' },
    { id: 'beam_clean_v45_line_current', label: 'Beam Clean V45 · line current', profile: 'line', intensity: 1.00, comps: { line: 1.00 }, elite: 0.47, lane: 'line' },
    { id: 'beam_clean_v45_line_strong', label: 'Beam Clean V45 · line strong', profile: 'line', intensity: 1.35, comps: { line: 1.25 }, elite: 0.46, lane: 'line' },

    { id: 'beam_clean_v45_survival_mild', label: 'Beam Clean V45 · survival mild', profile: 'survival', intensity: 0.70, comps: { survival: 0.70 }, elite: 0.46, lane: 'survival' },
    { id: 'beam_clean_v45_survival_current', label: 'Beam Clean V45 · survival current', profile: 'survival', intensity: 1.00, comps: { survival: 1.00 }, elite: 0.44, lane: 'survival' },
    { id: 'beam_clean_v45_survival_strong', label: 'Beam Clean V45 · survival strong', profile: 'survival', intensity: 1.35, comps: { survival: 1.25 }, elite: 0.42, lane: 'survival' },

    { id: 'beam_clean_v45_conversion_mild', label: 'Beam Clean V45 · conversion mild', profile: 'conversion', intensity: 0.70, comps: { conversion: 0.70 }, elite: 0.47, lane: 'conversion' },
    { id: 'beam_clean_v45_conversion_current', label: 'Beam Clean V45 · conversion current', profile: 'conversion', intensity: 1.00, comps: { conversion: 1.00 }, elite: 0.46, lane: 'conversion' },
    { id: 'beam_clean_v45_conversion_strong', label: 'Beam Clean V45 · conversion strong', profile: 'conversion', intensity: 1.35, comps: { conversion: 1.20 }, elite: 0.45, lane: 'conversion' },

    { id: 'beam_clean_v45_line_conversion', label: 'Beam Clean V45 · line + conversion', profile: 'line_conversion', intensity: 1.00, comps: { line: 0.85, conversion: 0.75 }, elite: 0.45, lane: 'line_conversion' },
    { id: 'beam_clean_v45_line_survival', label: 'Beam Clean V45 · line + survival', profile: 'line_survival', intensity: 1.00, comps: { line: 0.75, survival: 0.80 }, elite: 0.43, lane: 'line_survival' },
    { id: 'beam_clean_v45_conversion_t6', label: 'Beam Clean V45 · conversion + T6 virtual', profile: 'conversion_t6', intensity: 1.00, comps: { conversion: 0.80, t6: 0.85 }, elite: 0.46, lane: 'conversion_t6', t6: true }
  ];
  var allRequested = requested ? requested.has('beam_clean_v45_profile_sweep') : (payload.enableV45ProfileSweep === true || payload.v45ProfileSweep === true);
  var out = [];
  for (var i = 0; i < defs.length; i++) {
    var d = defs[i];
    if (!allRequested && !(requested && requested.has(d.id))) continue;
    out.push({
      id: d.id,
      label: d.label,
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: d.elite,
      v38MultiLane: true,
      t6VirtualEndScore: !!d.t6,
      nextKillSeekScore: false,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120,
      v45ProfileSweep: true,
      v45ProfileName: d.profile,
      v45ProfileComponents: d.comps,
      v45ProfileIntensity: d.intensity,
      v44LaneProfile: d.lane
    });
  }
  return out;
}

function makeSolvabilityStrategies(baseBeamWidth, payload) {
  payload = payload || {};
  var compact = Math.max(50, Math.min(12000, baseBeamWidth || 1800));
  var wide = Math.max(compact, Math.min(14000, payload.wideBeamWidth || 6500));
  var requested = normalizeStrategyIdSet(payload);
  function wants(id, legacyDefault) { return requested ? requested.has(id) : !!legacyDefault; }
  var arr = [];
  // Baseline disponible pour diagnostic, mais désactivé par défaut pour ne pas
  // consommer le budget du Beam Clean dans les benchmarks ordinaires.
  if (wants("beam_exploration_baseline", payload.enableBaselineBeam === true)) {
    arr.push({
      id: "beam_exploration_baseline",
      label: "Beam exploration baseline",
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: 0.42,
      v38MultiLane: false,
      t6VirtualEndScore: false,
      nextKillSeekScore: false
    });
  }
  if (wants("beam_clean_v38", true)) {
    arr.push({
      id: "beam_clean_v38",
      label: "Beam Clean V38",
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: 0.50,
      v38MultiLane: true,
      t6VirtualEndScore: false,
      nextKillSeekScore: false,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120
    });
  }
  if (wants("beam_clean_v42_t6_virtual", payload.enableT6VirtualEndScore === true || payload.t6VirtualEndScore === true)) {
    arr.push({
      id: "beam_clean_v42_t6_virtual",
      label: "Beam Clean + T6 Virtual End",
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: 0.50,
      v38MultiLane: true,
      t6VirtualEndScore: true,
      nextKillSeekScore: false,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120
    });
  }
  if (wants("beam_clean_v43_next_kill", payload.enableNextKillSeeker === true || payload.nextKillSeekScore === true)) {
    arr.push({
      id: "beam_clean_v43_next_kill",
      label: "Beam Clean + Next Kill Seeker",
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: 0.46,
      v38MultiLane: true,
      t6VirtualEndScore: false,
      nextKillSeekScore: true,
      nextKillProbeTopN: payload.nextKillProbeTopN != null ? Number(payload.nextKillProbeTopN) : 120,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120
    });
  }
  if (wants("beam_clean_v45_profile_sweep", payload.enableV45ProfileSweep === true || payload.v45ProfileSweep === true)) {
    var sweep = makeV45ProfileSweepStrategies(compact, payload, requested);
    for (var si = 0; si < sweep.length; si++) arr.push(sweep[si]);
  } else if (requested) {
    var sweepExact = makeV45ProfileSweepStrategies(compact, payload, requested);
    for (var sei = 0; sei < sweepExact.length; sei++) arr.push(sweepExact[sei]);
  }
  if (wants("beam_clean_v44_stochastic", payload.enableStochasticRestarts === true || payload.stochasticRestarts === true)) {
    var restarts = makeV44StochasticStrategies(compact, payload, requested);
    for (var ri = 0; ri < restarts.length; ri++) arr.push(restarts[ri]);
  }
  if (wants("beam_clean_v38_large", requested ? false : payload.enableLargeBeam !== false)) {
    arr.push({
      id: "beam_clean_v38_large",
      label: "Beam Clean V38 large",
      beamWidth: wide,
      diversityEnabled: true,
      diversityEliteRatio: 0.50,
      v38MultiLane: true,
      t6VirtualEndScore: false,
      nextKillSeekScore: false,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 160
    });
  }
  // Repli par défaut : Beam Clean V38 UNIQUEMENT quand aucune stratégie n'a été
  // explicitement demandée (requested == null, cas "aucun algo coché" de l'UI).
  // Si des strategyIds sont fournis mais qu'aucune stratégie intégrée ne
  // correspond, c'est normal : la stratégie demandée est ajoutée par une
  // extension qui enrobe cette fonction (profils de poids V47, Pareto V50) APRÈS
  // son retour. Injecter beam_clean_v38 ici créait une stratégie parasite qui
  // doublait le coût des benchmarks atomiques (ex. beam_clean_v47_weights).
  if (!arr.length && !requested) {
    arr.push({
      id: "beam_clean_v38",
      label: "Beam Clean V38",
      beamWidth: compact,
      diversityEnabled: true,
      diversityEliteRatio: 0.50,
      v38MultiLane: true,
      t6VirtualEndScore: false,
      nextKillSeekScore: false,
      v38ProbeTopN: payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120
    });
  }
  return arr;
}
function solveSolvabilityV29(state0, beamWidth, maxSteps, ctx, payload) {
  payload = payload || {};
  var budgetMs = effectiveTimeBudgetMsV58A1(payload, 55000);
  var started = Date.now();
  var perStrategyBudget = payload.strategyBudgetMode === "per_strategy" || payload.perStrategyBudget === true;
  var globalDeadlineMs = started + budgetMs;
  var strategies = makeSolvabilityStrategies(beamWidth, payload);
  var results = [];
  var best = null;
  for (var i = 0; i < strategies.length; i++) {
    var strategy = strategies[i];
    if (!perStrategyBudget && Date.now() >= globalDeadlineMs) {
      results.push(summarizeStrategyResult(strategy, null, 0, "skipped", "budget épuisé", ctx));
      continue;
    }
    var strategyDeadlineMs = perStrategyBudget ? (Date.now() + budgetMs) : globalDeadlineMs;
    var sctx = cloneContextForStrategy(ctx, strategy, strategyDeadlineMs);
    var t0 = Date.now();
    var res = strategy.adaptiveBeam === true
      ? solveCoreAdaptiveBeamWithSafetyFallback(state0, strategy.beamWidth, strategy.maxSteps || maxSteps, sctx, strategy)
      : solveCore(state0, strategy.beamWidth, strategy.maxSteps || maxSteps, sctx, strategy);
    var dt = Date.now() - t0;
    if (res) {
      results.push(summarizeStrategyResult(strategy, res, dt, null, null, sctx));
      if (best === null || compareCoreResults(res, best) < 0) best = res;
    } else {
      results.push(summarizeStrategyResult(strategy, null, dt, "no_plan", "aucun état survivant", sctx));
    }
  }
  if (!best) return null;
  best.portfolioResults = results;
  best.portfolioSummary = {
    enabled: true,
    lab_version: "V63B_lean_fast_search_result",
    total_elapsed_ms: Date.now() - started,
    budget_ms: budgetMs,
    budget_mode: perStrategyBudget ? "per_strategy" : "shared",
    effective_budget_ms: perStrategyBudget ? budgetMs * strategies.length : budgetMs,
    strategy_count: strategies.length,
    completed_count: results.filter(function (r) { return r.status !== "skipped"; }).length,
    winner_id: best.strategy && best.strategy.id,
    winner_label: best.strategy && best.strategy.label
  };
  return best;
}

// ============================================================
// ENTRÉE PRINCIPALE
// ============================================================
function solveBolgrot(payload) {
  payload = payload || {};
  if (payload.finalUserSolverV58A4 === true || payload.finalUserSolverV58A1 === true || payload.solverProfileId || payload.solverProfileName) {
    payload.timeBudgetMs = effectiveTimeBudgetMsV58A1(payload, 55000);
  }
  var ctx = buildContext(payload);
  var state0 = buildInitialState(payload, ctx);
  var beamWidth = payload.beamWidth || BEAM_WIDTH_DEFAULT;
  var maxSteps = payload.maxSteps || MAX_STEPS_DEFAULT;
  var solverEngine = payload.solverEngine || "lds_v27";

  if (isWin(state0)) {
    return { ok: true, reason: "goal_reached", win: true, plan_full: [], plan_full_steps: [], debug: { strategy: "already_done", solver_version: "V63B_lean_fast_search_result" } };
  }

  var searchCtx = cloneContextForStrategy(ctx, { diversityEnabled: ctx.diversityEnabled, diversityEliteRatio: ctx.diversityEliteRatio }, 0);
  searchCtx.deadlineMs = 0;
  var res;
  if (solverEngine === "portfolio_v26") {
    res = solvePortfolio(state0, beamWidth, maxSteps, ctx, payload || {});
  } else if (solverEngine === "solvability_v29") {
    res = solveSolvabilityV29(state0, beamWidth, maxSteps, ctx, payload || {});
  } else {
    searchCtx.auditDuringSearch = false;
    res = solveLDS(state0, maxSteps, searchCtx, payload || {});
  }
  if (res === null) {
    return { ok: false, reason: "no_plan", win: false, plan_full: [], plan_full_steps: [], portfolio_results: [], debug: { beam_width: beamWidth, max_steps: maxSteps, solver_engine: solverEngine, solver_version: "V63B_lean_fast_search_result" } };
  }


  // V27 : l'audit complet est reconstruit uniquement pour le plan retenu.
  var planAudit = buildPlanAudit(state0, res.planRaw, ctx);
  var steps = replayPlanToSteps(state0, res.planRaw, ctx, planAudit);
  var planLabels = steps.map(function (s) { return s.action; });

  return {
    ok: res.win,
    reason: res.win ? "ok" : "partial",
    win: res.win,
    plan_full: planLabels,
    plan_full_steps: steps,
    plan_audit: planAudit,
    portfolio_results: res.portfolioResults || [],
    debug: {
      enemies_start: state0.enemies.size,
      enemies_remaining: res.finalState.enemies.size,
      pv_final: res.finalState.pv,
      turns_final: res.finalState.turn,
      actions: res.planRaw.length,
      expanded_nodes: res.expanded,
      diagnostic_v58a4: {
        version: "V63B_lean_fast_search_result",
        fast_search_path_v58a: ctx.fastSearchPathV58A !== false,
        payload_fast_search_path_v58a: payload.fastSearchPathV58A !== false,
        lean_search_result_v63b: ctx.leanFastSearchResultV63B !== false,
        payload_lean_search_result_v63b: payload.leanFastSearchResultV63B !== false,
        beam_selection_cache_v61: ctx.beamSelectionCacheV61 !== false,
        payload_beam_selection_cache_v61: payload.beamSelectionCacheV61 !== false,
        scoring_cache_v62: ctx.scoringCacheV62 === true,
        payload_scoring_cache_v62: payload.scoringCacheV62 !== false,
        scoring_cache_stats_v62: v62ScoringCacheStats(ctx),
        time_budget_ms: payload.timeBudgetMs || null,
        ctx_adaptive_primary_budget_ms: ctx.adaptivePrimaryBudgetMs,
        ctx_adaptive_fallback_min_budget_ms: ctx.adaptiveFallbackMinBudgetMs,
        ctx_adaptive_fallback_policy: ctx.adaptiveFallbackPolicy,
        run_stop_reason: res.runSummary ? res.runSummary.adaptive_stop_reason : null,
        run_fast_search_path_v58a: res.runSummary ? res.runSummary.fast_search_path_v58a : null,
        adaptive_beam: res.runSummary ? (res.runSummary.adaptive_beam || null) : null
      },
      search_trace: { depth_stats: res.depthStats || [], run_summary: res.runSummary || {} },
      portfolio_summary: res.portfolioSummary || {},
      portfolio_results: res.portfolioResults || [],
      winning_strategy: res.strategy || null,
      final_score: res.finalScore,
      beam_width: beamWidth,
      max_steps: maxSteps,
      time_budget_ms: payload.timeBudgetMs || null,
      solver_engine: solverEngine,
      lds_max_discrepancy: payload.ldsMaxDiscrepancy,
      lds_top_actions: payload.ldsTopActions,
      diversity_enabled: ctx.diversityEnabled,
      diversity_elite_ratio: ctx.diversityEliteRatio,
      solver_version: "V63B_lean_fast_search_result",
      movement_model: "V20_identity_once_sequential_dynamic",
      normal_order: "v19_manh_cond_left_swap",
      immobilisme_order: "v19_manh_quadrant_origin_diff_angle",
      corner_mode: ctx.cornerMode,
      astral_dirs: "orthogonal_only",
      prudent_astral_empty_target_legacy_disabled_by_default: ctx.prudentAstralEmptyTarget,
      prudent_astral_kill_collision_legacy_disabled_by_default: ctx.prudentAstralKillCollision,
      fatal_adjacent_empty_landing: ctx.fatalAdjacentEmptyLanding,
      player_blocks_diagonal_corner: ctx.playerBlocksDiagonalCorner,
      prudent_landing_multi_claim: ctx.prudentLandingMultiClaim,
      prudent_repulsed_origin_reclaim: ctx.prudentRepulsedOriginReclaim,
      prudent_chain_pressure_to_player: ctx.prudentChainPressureToPlayer,
      prudent_double_diagonal_corner_intermediate_pressure: ctx.prudentDoubleDiagonalCornerIntermediatePressure,
    },
  };
}

function handleConfig() {
  return {
    ok: true,
    beam_width: BEAM_WIDTH_DEFAULT, max_steps: MAX_STEPS_DEFAULT, solver_version: "V63B_lean_fast_search_result",
    pv_start: DEFAULT_PV, pa_start: DEFAULT_PA, turn_start: DEFAULT_TURN, enemy_count: ENEMY_COUNT,
    default_board: DEFAULT_BOARD, default_player: DEFAULT_PLAYER.slice(), default_bolgrot: DEFAULT_BOLGROT.slice(),
    prudent_flags: {
      prudentAstralEmptyTarget: false,
      prudentAstralKillCollision: false,
      fatalAdjacentEmptyLanding: true,
      playerBlocksDiagonalCorner: true,
      prudentLandingMultiClaim: true,
      prudentRepulsedOriginReclaim: true,
      prudentChainPressureToPlayer: true,
      prudentDoubleDiagonalCornerIntermediatePressure: true,
    },
    diversity: {
      enabled: DIVERSITY_ENABLED_DEFAULT,
      elite_ratio: DIVERSITY_ELITE_RATIO_DEFAULT,
      min_bucket_slots: DIVERSITY_MIN_BUCKET_SLOTS,
    },
    lds: {
      max_discrepancy: 6,
      top_actions: 8,
    },
  };
}

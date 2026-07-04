/* bolgrot_weight_profiles.js — V48 paramétrage + mutations de poids.
   Extension non invasive : ajoute des stratégies de poids JSON sans modifier les règles. */
(function(){
  var G = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined' ? self : globalThis);

  function clone(obj) { return JSON.parse(JSON.stringify(obj || {})); }
  function num(x, def) { x = Number(x); return isFinite(x) ? x : (def || 0); }
  function slug(s) {
    return String(s || 'profile').toLowerCase()
      .normalize ? String(s || 'profile').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')
                 : String(s || 'profile').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  }
  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    str = String(str || 'v48');
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randn(rnd) {
    // Box-Muller borné indirectement par les clamps de mutation.
    var u = Math.max(1e-9, rnd());
    var v = Math.max(1e-9, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function weightProfilesDefault() {
    return [
      {
        id: 'weights_line_strong_seed',
        name: 'V47 JSON · line strong seed',
        description: 'Point de départ inspiré du signal V45 line strong. À muter ensuite.',
        scale: 1,
        beamWidthMultiplier: 1,
        diversityEliteRatio: 0.46,
        v38LaneProfile: 'line',
        weights: {
          enemies: -1200,
          pv: 420,
          mobility: 900,
          safeLandings: 250,
          maxLineRay: 16000,
          maxLineGlobal: 3600,
          alignment: 180,
          densityOver2: -7200,
          adjacentDensity: -9200,
          killTargets: 900,
          primaryClaims: -2600
        },
        thresholds: [
          { feature: 'maxLineRay', gte: 4, value: 8000 },
          { feature: 'maxLineRay', gte: 6, value: 19000 },
          { feature: 'maxLineRay', gte: 8, value: 33000 },
          { feature: 'maxLineRay', gte: 10, value: 22000 }
        ]
      }
    ];
  }

  function normalizeProfile(raw, idx) {
    raw = raw || {};
    var name = raw.name || raw.label || ('V47 weights #' + (idx + 1));
    var id = raw.id || ('beam_clean_v47_weights_' + slug(name || idx));
    if (String(id).indexOf('beam_clean_v47_') !== 0) id = 'beam_clean_v47_' + slug(id);
    return {
      id: id,
      name: name,
      label: raw.label || ('Beam Clean V47 · ' + name),
      description: raw.description || '',
      weights: clone(raw.weights || raw.features || {}),
      thresholds: Array.isArray(raw.thresholds) ? clone(raw.thresholds) : [],
      scale: num(raw.scale, 1) || 1,
      beamWidthMultiplier: Math.max(0.25, Math.min(4, num(raw.beamWidthMultiplier, 1) || 1)),
      diversityEliteRatio: raw.diversityEliteRatio != null ? Math.max(0.1, Math.min(1, num(raw.diversityEliteRatio, 0.46))) : 0.46,
      v38LaneProfile: raw.v38LaneProfile || raw.laneProfile || null,
      v38ProbeTopN: raw.v38ProbeTopN != null ? Math.max(40, Math.min(3000, num(raw.v38ProbeTopN, 120))) : null
    };
  }

  function parseWeightProfiles(raw) {
    if (typeof raw === 'string') raw = JSON.parse(raw);
    var arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.profiles) ? raw.profiles : [raw]);
    return arr.filter(Boolean).map(normalizeProfile);
  }

  function featureValue(feature, f) {
    switch (feature) {
      case 'enemies': return f.enemies;
      case 'pv': return f.pv;
      case 'mobility': return f.mobility;
      case 'safeLandings': return f.safeLandings;
      case 'openNeighbors': return f.openNeighbors;
      case 'primaryClaims': return f.primaryClaims;
      case 'killTargets': return f.killTargets;
      case 'killAstral': return f.killAstral;
      case 'killDouble': return f.killDouble;
      case 'immoOptions': return f.immoOptions;
      case 'maxLineRay': return f.maxLineRay;
      case 'maxLineGlobal': return f.maxLineGlobal;
      case 'alignment': return f.alignment;
      case 'density2': return f.density2;
      case 'densityOver2': return f.densityOver2;
      case 'adjacentDensity': return f.adjacentDensity;
      case 'killedAction': return f.killedAction;
      case 'endAction': return f.endAction;
      case 'immoAction': return f.immoAction;
      case 'noKillTarget': return f.noKillTarget;
      default: return f[feature] || 0;
    }
  }

  function lineMetricsFor(state, ctx) {
    try {
      if (typeof fireLineMetrics === 'function') return fireLineMetrics(state, ctx) || {};
    } catch (_e) {}
    return {};
  }

  function extractFeatures(state, ctx, parentState, action, actionDiag, ev) {
    var m = (ev && ev.metrics) || (typeof tacticalStateMetrics === 'function' ? tacticalStateMetrics(state, ctx) : {}) || {};
    var l = lineMetricsFor(state, ctx);
    var effects = (actionDiag && actionDiag.effects) || {};
    var maxLineRay = num(l.max_fire_line_ray, num(l.max_ray, num(m.max_fire_line_ray, 0)));
    var maxLineGlobal = num(l.max_fire_line_global, num(l.max_global, num(m.max_fire_line_global, 0)));
    var alignment = num(l.fire_alignment_score, num(l.alignment_score, num(m.fire_alignment_score, 0)));
    var density2 = num(l.local_density_cheb2, num(m.local_density_cheb2, 0));
    var adjacentDensity = num(l.adjacent_density, num(m.adjacent_density, 0));
    return {
      enemies: state && state.enemies ? state.enemies.size : 0,
      pv: state ? num(state.pv, 0) : 0,
      mobility: num(m.mobility_rough, 0),
      safeLandings: num(m.rough_safe_empty_landings, 0),
      openNeighbors: num(m.open_orthogonal_neighbors, 0),
      primaryClaims: num(m.primary_claims_to_player, 0),
      killTargets: num(m.kill_targets, 0),
      killAstral: num(m.kill_targets_astral, 0),
      killDouble: num(m.kill_targets_double, 0),
      immoOptions: num(m.immo_options, 0),
      maxLineRay: maxLineRay,
      maxLineGlobal: maxLineGlobal,
      alignment: alignment,
      density2: density2,
      densityOver2: Math.max(0, density2 - 2),
      adjacentDensity: adjacentDensity,
      killedAction: effects.killed ? 1 : 0,
      endAction: action && action.kind === 'end' ? 1 : 0,
      immoAction: action && action.kind === 'immo' ? 1 : 0,
      noKillTarget: num(m.kill_targets, 0) <= 0 ? 1 : 0
    };
  }

  function scoreWeightProfile(state, ctx, parentNodeOrState, action, actionDiag, ev) {
    var profile = ctx && ctx.v47WeightProfile;
    if (!profile || !profile.weights) return 0;
    var parentState = parentNodeOrState && (parentNodeOrState.state || parentNodeOrState);
    var f = extractFeatures(state, ctx, parentState, action, actionDiag, ev);
    var total = 0;
    var w = profile.weights || {};
    Object.keys(w).forEach(function (k) { total += featureValue(k, f) * num(w[k], 0); });
    var th = profile.thresholds || [];
    for (var i = 0; i < th.length; i++) {
      var t = th[i] || {};
      var v = featureValue(t.feature, f);
      if (t.gte != null && !(v >= num(t.gte, 0))) continue;
      if (t.gt != null && !(v > num(t.gt, 0))) continue;
      if (t.lte != null && !(v <= num(t.lte, 0))) continue;
      if (t.lt != null && !(v < num(t.lt, 0))) continue;
      total += num(t.value, 0);
    }
    return Math.round(total * (num(profile.scale, 1) || 1));
  }

  function mutateSigned(value, spread, rnd, zeroScale) {
    value = num(value, 0);
    spread = Math.max(0, Math.min(2, num(spread, 0.25)));
    if (value === 0) {
      var z = num(zeroScale, 1000) || 1000;
      return Math.round((rnd() * 2 - 1) * z * spread);
    }
    var sign = value < 0 ? -1 : 1;
    var mag = Math.abs(value);
    var factor = Math.exp(randn(rnd) * spread);
    factor = clamp(factor, Math.max(0.05, 1 - 3 * spread), 1 + 3 * spread);
    return Math.round(sign * mag * factor);
  }

  function mutateThreshold(t, spread, rnd) {
    t = clone(t || {});
    if (t.value != null) t.value = mutateSigned(t.value, spread, rnd, 1000);
    // Les seuils gte/gt/lte/lt restent stables par défaut : on cherche d'abord les poids.
    return t;
  }

  function mutateOneProfile(base, index, opts, rnd) {
    base = normalizeProfile(base || {}, index);
    opts = opts || {};
    var spread = Math.max(0, Math.min(2, num(opts.spread, 0.25)));
    var lockLane = opts.lockLane !== false;
    var mutateThresholds = opts.mutateThresholds !== false;
    var w = clone(base.weights || {});
    Object.keys(w).forEach(function (k) { w[k] = mutateSigned(w[k], spread, rnd, 800); });
    var th = (base.thresholds || []).map(function (t) { return mutateThresholds ? mutateThreshold(t, spread, rnd) : clone(t); });
    var laneChoices = ['line', 'survival', 'conversion', 'line_conversion', 'line_survival', 'conversion_t6'];
    var lane = base.v38LaneProfile || null;
    if (!lockLane && rnd() < 0.22) lane = laneChoices[Math.floor(rnd() * laneChoices.length)] || lane;
    var scale = clamp(num(base.scale, 1) * Math.exp(randn(rnd) * spread * 0.35), 0.15, 4);
    var elite = clamp(num(base.diversityEliteRatio, 0.46) + randn(rnd) * spread * 0.08, 0.25, 0.75);
    var beamMult = clamp(num(base.beamWidthMultiplier, 1) * Math.exp(randn(rnd) * spread * 0.25), 0.5, 1.8);
    return {
      id: 'weights_v48_mut_' + String(index + 1).padStart(3, '0') + '_' + slug(base.name || base.id || 'base'),
      name: 'V48 mutation ' + String(index + 1).padStart(3, '0') + ' · ' + (base.name || base.id || 'base'),
      label: 'Beam Clean V48 · mutation ' + String(index + 1).padStart(3, '0') + ' · ' + (base.name || base.id || 'base'),
      description: 'Mutation générée automatiquement depuis “' + (base.name || base.id || 'base') + '”.',
      scale: Math.round(scale * 1000) / 1000,
      beamWidthMultiplier: Math.round(beamMult * 1000) / 1000,
      diversityEliteRatio: Math.round(elite * 1000) / 1000,
      v38LaneProfile: lane,
      v38ProbeTopN: base.v38ProbeTopN || null,
      weights: w,
      thresholds: th,
      mutation: {
        version: 'V48',
        source_id: base.id,
        source_name: base.name,
        spread: spread
      }
    };
  }

  function mutateProfiles(rawProfiles, opts) {
    opts = opts || {};
    var bases = parseWeightProfiles(rawProfiles || weightProfilesDefault());
    var baseLimit = Math.max(1, Math.min(50, Math.floor(num(opts.baseLimit, bases.length || 1))));
    bases = bases.slice(0, baseLimit);
    var count = Math.max(1, Math.min(500, Math.floor(num(opts.count, 24))));
    var rnd = mulberry32(hashSeed(opts.seed || 'v48-mutations'));
    var includeBase = opts.includeBase === true;
    var out = includeBase ? bases.map(function (p) { return clone(p); }) : [];
    for (var i = 0; i < count; i++) {
      var b = bases[i % bases.length];
      out.push(mutateOneProfile(b, i, opts, rnd));
    }
    return out.map(normalizeProfile);
  }

  function patchScore() {
    if (typeof scoreNodeDetailed !== 'function' || scoreNodeDetailed.__v47Patched) return;
    var original = scoreNodeDetailed;
    var wrapped = function (state, ctx, parentNodeOrState, action, actionDiag) {
      var ev = original(state, ctx, parentNodeOrState, action, actionDiag);
      var bonus = scoreWeightProfile(state, ctx, parentNodeOrState, action, actionDiag, ev);
      if (bonus) {
        ev.parts = ev.parts || {};
        ev.parts.v47_weight_profile = bonus;
        ev.total += bonus;
      }
      return ev;
    };
    wrapped.__v47Patched = true;
    scoreNodeDetailed = wrapped;
  }

  function patchCloneContext() {
    if (typeof cloneContextForStrategy !== 'function' || cloneContextForStrategy.__v47Patched) return;
    var original = cloneContextForStrategy;
    var wrapped = function (ctx, strategy, deadlineMs) {
      var out = original(ctx, strategy, deadlineMs);
      if (strategy && strategy.v47WeightProfile) out.v47WeightProfile = normalizeProfile(strategy.v47WeightProfile, 0);
      return out;
    };
    wrapped.__v47Patched = true;
    cloneContextForStrategy = wrapped;
  }

  function patchSummaries() {
    if (typeof summarizeStrategyResult !== 'function' || summarizeStrategyResult.__v47Patched) return;
    var original = summarizeStrategyResult;
    var wrapped = function (strategy, res, elapsedMs, status, note, ctx) {
      var r = original(strategy, res, elapsedMs, status, note, ctx);
      if (strategy && strategy.v47WeightProfile) {
        r.v47_weight_profile = {
          id: strategy.v47WeightProfile.id,
          name: strategy.v47WeightProfile.name,
          weights: strategy.v47WeightProfile.weights,
          scale: strategy.v47WeightProfile.scale,
          thresholds: strategy.v47WeightProfile.thresholds || []
        };
      }
      return r;
    };
    wrapped.__v47Patched = true;
    summarizeStrategyResult = wrapped;
  }

  function adaptiveScheduleForProfile(baseBeamWidth, profile, payload) {
    payload = payload || {};
    var compact = Math.max(50, Math.min(12000, num(baseBeamWidth, 1800) || 1800));
    var raw = payload.adaptiveBeamSchedule || payload.v56AdaptiveBeamSchedule || null;
    if (!Array.isArray(raw) || raw.length === 0) raw = [100, 300, 600, 1000, compact];
    var mult = profile && profile.beamWidthMultiplier ? profile.beamWidthMultiplier : 1;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var base = Math.max(1, Math.floor(num(raw[i], 0)));
      if (!base) continue;
      var v = Math.max(50, Math.min(20000, Math.round(base * mult)));
      if (out.indexOf(v) < 0) out.push(v);
    }
    var finalBeam = Math.max(50, Math.min(20000, Math.round(compact * mult)));
    if (out.indexOf(finalBeam) < 0) out.push(finalBeam);
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function normalizeAdaptiveFallbackPolicyValue(v) {
    var raw = String(v || 'early').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (raw === 'off' || raw === 'none' || raw === 'pure' || raw === 'v56a' || raw === 'adaptive_only') return 'pure';
    if (raw === 'late' || raw === 'v56e_late' || raw === 'fallback_late') return 'late';
    if (raw === 'smart' || raw === 'v56e_smart' || raw === 'fallback_smart') return 'smart';
    if (raw === 'dual' || raw === 'v56f' || raw === 'v56f_dual' || raw === 'dual_adaptive' || raw === 'late_aggressive_pure_classic') return 'dual';
    if (raw === 'pure_first' || raw === 'v56g' || raw === 'v56g_pure_first' || raw === 'pure_classic_late_aggressive') return 'pure_first';
    if (raw === 'time_boxed' || raw === 'timeboxed' || raw === 'v56h' || raw === 'v56h_time_boxed' || raw === 'pure_then_aggressive_timeboxed') return 'time_boxed';
    return 'early';
  }

  function adaptiveFallbackPolicyLabel(policy) {
    if (policy === 'pure') return 'V56A pure';
    if (policy === 'late') return 'V56E late';
    if (policy === 'smart') return 'V56E smart';
    if (policy === 'dual') return 'V56F dual';
    if (policy === 'pure_first') return 'V56G pure-first';
    if (policy === 'time_boxed') return 'V56H time-boxed';
    return 'V56D early';
  }

  function profileStrategiesFromPayload(baseBeamWidth, payload, requested) {
    payload = payload || {};
    var should = requested ? requested.has('beam_clean_v47_weights') : (payload.enableV47WeightProfiles === true || payload.v47WeightProfilesEnabled === true);
    var adaptiveShould = requested ? requested.has('beam_clean_v47_weights_adaptive') : (payload.enableV56AdaptiveBeam === true || payload.v56AdaptiveBeam === true || payload.adaptiveBeam === true);
    var adaptiveFallbackPolicy = normalizeAdaptiveFallbackPolicyValue(payload.adaptiveFallbackPolicy || payload.v56AdaptiveFallbackPolicy || 'early');
    var raw = payload.v47WeightProfiles || payload.weightProfiles || [];
    var profiles = [];
    try { profiles = parseWeightProfiles(raw); } catch (e) { profiles = []; }
    if (!profiles.length && (should || adaptiveShould)) profiles = weightProfilesDefault().map(normalizeProfile);
    var out = [];
    var compact = Math.max(50, Math.min(12000, num(baseBeamWidth, 1800) || 1800));
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      var includeExact = requested && requested.has(p.id);
      var adaptiveId = p.id + '_adaptive_v56a';
      var includeAdaptiveExact = requested && requested.has(adaptiveId);
      if (should || includeExact) {
        out.push({
          id: p.id,
          label: p.label || ('Beam Clean V47 · ' + p.name),
          beamWidth: Math.max(50, Math.min(14000, Math.round(compact * (p.beamWidthMultiplier || 1)))),
          diversityEnabled: true,
          diversityEliteRatio: p.diversityEliteRatio != null ? p.diversityEliteRatio : 0.46,
          v38MultiLane: true,
          v38ProbeTopN: p.v38ProbeTopN || (payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120),
          v44LaneProfile: p.v38LaneProfile || null,
          v47WeightProfile: p
        });
      }
      if (adaptiveShould || includeAdaptiveExact) {
        var sched = adaptiveScheduleForProfile(compact, p, payload);
        var secondarySched = adaptiveScheduleForProfile(compact, p, { adaptiveBeamSchedule: payload.adaptiveSecondaryBeamSchedule || payload.v56AdaptiveSecondaryBeamSchedule || [100, 300, 600, 1000, compact] });
        out.push({
          id: adaptiveId,
          label: (p.label || ('Beam Clean V47 · ' + p.name)) + ' · Adaptive ' + adaptiveFallbackPolicyLabel(adaptiveFallbackPolicy),
          beamWidth: sched.length ? sched[sched.length - 1] : Math.max(50, Math.min(14000, Math.round(compact * (p.beamWidthMultiplier || 1)))),
          diversityEnabled: true,
          diversityEliteRatio: p.diversityEliteRatio != null ? p.diversityEliteRatio : 0.46,
          v38MultiLane: true,
          v38ProbeTopN: p.v38ProbeTopN || (payload.v38ProbeTopN != null ? Number(payload.v38ProbeTopN) : 120),
          v44LaneProfile: p.v38LaneProfile || null,
          v47WeightProfile: p,
          adaptiveBeam: true,
          adaptiveBeamSchedule: sched,
          adaptiveSecondaryBeamSchedule: secondarySched,
          v56AdaptiveSecondaryBeamSchedule: secondarySched,
          adaptiveBeamVersion: 'V56E_progressive_reservoir_policy',
          adaptiveFallbackPolicy: adaptiveFallbackPolicy,
          adaptiveSafetyFallback: adaptiveFallbackPolicy !== 'pure' && payload.adaptiveSafetyFallback !== false,
          adaptivePrimaryBudgetMs: payload.adaptivePrimaryBudgetMs != null ? Number(payload.adaptivePrimaryBudgetMs) : null,
          adaptivePrimaryBudgetFraction: payload.adaptivePrimaryBudgetFraction != null ? Number(payload.adaptivePrimaryBudgetFraction) : null,
          adaptiveFallbackMinBudgetMs: payload.adaptiveFallbackMinBudgetMs != null ? Number(payload.adaptiveFallbackMinBudgetMs) : null,
          adaptiveSmartEnemyThreshold: payload.adaptiveSmartEnemyThreshold != null ? Number(payload.adaptiveSmartEnemyThreshold) : null,
          adaptiveDualPhase2BudgetMs: payload.adaptiveDualPhase2BudgetMs != null ? Number(payload.adaptiveDualPhase2BudgetMs) : null,
          adaptiveDualPhase2Fraction: payload.adaptiveDualPhase2Fraction != null ? Number(payload.adaptiveDualPhase2Fraction) : null,
          adaptiveDualFixedReserveMs: payload.adaptiveDualFixedReserveMs != null ? Number(payload.adaptiveDualFixedReserveMs) : null,
          adaptiveDualFixedMinBudgetMs: payload.adaptiveDualFixedMinBudgetMs != null ? Number(payload.adaptiveDualFixedMinBudgetMs) : null,
          adaptiveDualPhase1BudgetMs: payload.adaptiveDualPhase1BudgetMs != null ? Number(payload.adaptiveDualPhase1BudgetMs) : null,
          adaptivePureFirstPhase1Fraction: payload.adaptivePureFirstPhase1Fraction != null ? Number(payload.adaptivePureFirstPhase1Fraction) : null,
          adaptivePureFirstReserveMs: payload.adaptivePureFirstReserveMs != null ? Number(payload.adaptivePureFirstReserveMs) : null,
          adaptivePureFirstMaxBudgetMs: payload.adaptivePureFirstMaxBudgetMs != null ? Number(payload.adaptivePureFirstMaxBudgetMs) : null,
          adaptiveTimeBoxPhase1BudgetMs: payload.adaptiveTimeBoxPhase1BudgetMs != null ? Number(payload.adaptiveTimeBoxPhase1BudgetMs) : null,
          adaptiveTimeBoxPhase2BudgetMs: payload.adaptiveTimeBoxPhase2BudgetMs != null ? Number(payload.adaptiveTimeBoxPhase2BudgetMs) : null,
          adaptiveTimeBoxFixedReserveMs: payload.adaptiveTimeBoxFixedReserveMs != null ? Number(payload.adaptiveTimeBoxFixedReserveMs) : null
        });
      }
    }
    return out;
  }

  function patchStrategies() {
    if (typeof makeSolvabilityStrategies !== 'function' || makeSolvabilityStrategies.__v47Patched) return;
    var original = makeSolvabilityStrategies;
    var wrapped = function (baseBeamWidth, payload) {
      payload = payload || {};
      var arr = original(baseBeamWidth, payload) || [];
      var requested = null;
      if (Array.isArray(payload.strategyIds) && payload.strategyIds.length) requested = new Set(payload.strategyIds);
      var extras = profileStrategiesFromPayload(baseBeamWidth, payload, requested);
      var seen = new Set(arr.map(function (s) { return s.id; }));
      for (var i = 0; i < extras.length; i++) {
        if (!seen.has(extras[i].id)) { arr.push(extras[i]); seen.add(extras[i].id); }
      }
      return arr;
    };
    wrapped.__v47Patched = true;
    makeSolvabilityStrategies = wrapped;
  }

  function install() {
    patchScore();
    patchCloneContext();
    patchSummaries();
    patchStrategies();
  }

  G.BolgrotWeightProfiles = {
    version: 'V49_weight_profiles_optimizer',
    defaultProfiles: weightProfilesDefault,
    mutate: mutateProfiles,
    parse: parseWeightProfiles,
    normalize: normalizeProfile,
    scoreBonus: scoreWeightProfile,
    install: install
  };
  install();
})();

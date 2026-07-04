/* bolgrot_api.js — Assemblage API BolgrotCore.
   V45 : export T6 Virtual End, Next Kill Seeker, stochastic et profile sweep. */

// ============================================================
// EXPORTS COMMUNS V38
// ============================================================
function __makeBolgrotCoreApi() {
  return {
    // Solveur / simulation
    solveBolgrot: solveBolgrot, handleConfig: handleConfig, solveLDS: solveLDS, solvePortfolio: solvePortfolio,
    solveCoreAdaptiveBeam: (typeof solveCoreAdaptiveBeam === 'function' ? solveCoreAdaptiveBeam : null),
    buildContext: buildContext, buildInitialState: buildInitialState,
    attractFires: attractFires, repulse: repulse, repulseDetailed: repulseDetailed,
    primaryStep: primaryStep, primaryDestination: primaryDestination, primaryClaimCounts: primaryClaimCounts,
    countPrimaryClaimsTo: countPrimaryClaimsTo, hasPrimaryClaimCollisionNear: hasPrimaryClaimCollisionNear,
    hasRepulsedOriginReclaimConflict: hasRepulsedOriginReclaimConflict,
    hasChainPressureToPlayer: hasChainPressureToPlayer,
    applyAction: applyAction, simulateActionDetailed: simulateActionDetailed, simulateActionFast: (typeof simulateActionFast === 'function' ? simulateActionFast : null), expandDetailed: expandDetailed,
    scoreStateDetailed: scoreStateDetailed, scoreNodeDetailed: scoreNodeDetailed, tacticalStateMetrics: tacticalStateMetrics,
    t6VirtualEndEvaluation: t6VirtualEndEvaluation,
    nextKillSeekEvaluation: nextKillSeekEvaluation,
    v44StochasticScoreBonus: (typeof v44StochasticScoreBonus === 'function' ? v44StochasticScoreBonus : null),
    v45ProfileScoreBonus: (typeof v45ProfileScoreBonus === 'function' ? v45ProfileScoreBonus : null),
    buildPlanAudit: buildPlanAudit, enumerateActions: enumerateActions,
    selectBeamV38: selectBeamV38, v38LinePlanningScore: v38LinePlanningScore, v38ActionProbeCached: v38ActionProbeCached,
    makeNodeFast: (typeof makeNodeFast === 'function' ? makeNodeFast : null),
    mkState: mkState, stateKey: stateKey, idxToCell: idxToCell,
    DEFAULT_BOARD: DEFAULT_BOARD, BOARD_DEF: DEFAULT_BOARD, DEFAULT_PLAYER: DEFAULT_PLAYER, DEFAULT_BOLGROT: DEFAULT_BOLGROT,
    // Détection screenshot
    analyzeImage: analyzeImage, analyzeImageData: analyzeImageData,
    findAnchors: findAnchors, detectEnemies: detectEnemies, detectGlyphs: detectGlyphs,
    isGlyphPixelRGB: isGlyphPixelRGB, screenToGridApprox: screenToGridApprox,
    DETECTION_CELLS: DETECTION_CELLS,
  };
}

var __BOLGROT_CORE_API = __makeBolgrotCoreApi();

if (typeof window !== 'undefined') window.BolgrotCore = __BOLGROT_CORE_API;
if (typeof self !== 'undefined') self.BolgrotCore = __BOLGROT_CORE_API;

if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof module === 'undefined') {
  self.onmessage = function (ev) {
    var msg = ev.data || {};
    try {
      if (msg.type === 'config') { self.postMessage({ type: 'result', body: handleConfig() }); return; }
      if (msg.type === 'solve') {
        var __doSolve = function () { self.postMessage({ type: 'result', body: solveBolgrot(msg.payload || {}) }); };
        if (typeof self.__ensureFlnWasm === 'function') {
          self.__ensureFlnWasm().then(__doSolve).catch(function (e) { self.postMessage({ type: 'error', message: String((e && e.stack) || e) }); });
        } else { __doSolve(); }
        return;
      }
      self.postMessage({ type: 'error', message: 'Route inconnue: ' + msg.type });
    } catch (e) {
      self.postMessage({ type: 'error', message: String((e && e.stack) || e) });
    }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = __BOLGROT_CORE_API;

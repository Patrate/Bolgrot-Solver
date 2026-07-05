/* bolgrot_detection_v68.js — Détection screenshot : ancrage, feux, glyphes, conversion écran/grille.
   V67.1 : ne confond pas visibilité de crop et preuve visuelle. Les feux forts au bord restent confirmés ;
   les panneaux UI flottants sont signalés par leur géométrie écran (traits rectilignes) et leur signature locale. */

// ============================================================
// DETECTION SCREENSHOT — source commune Solveur/Lab
// ============================================================
var DETECTION_CELLS = [];
for (var __gy=0; __gy<DEFAULT_BOARD.length; __gy++) {
  var __row = DEFAULT_BOARD[__gy];
  for (var __gx=0; __gx<__row.length; __gx++) {
    var __c = __row[__gx];
    if (__c === '.' || __c === 'P') DETECTION_CELLS.push({ gx: __gx, gy: __gy });
  }
}
var DETECTION_PLAYER_CELL = { gx: DEFAULT_PLAYER[0], gy: DEFAULT_PLAYER[1] };
var DETECTION_BOLGROT_CELL = { gx: DEFAULT_BOLGROT[0], gy: DEFAULT_BOLGROT[1] };
var DETECTION_PB_CELLS = new Set([
  DETECTION_PLAYER_CELL.gx + ',' + DETECTION_PLAYER_CELL.gy,
  DETECTION_BOLGROT_CELL.gx + ',' + DETECTION_BOLGROT_CELL.gy
]);

var DARK_MAX = 90;
var DARK_CHROMA = 30;
// Repli d'ancrage translucide : l'UI blanche du joueur/Bolgrot (labels "2"/"1") est dessinee
// par-dessus la scene, donc insensible a la transparence des entites (qui, elle, delave le sprite gris).
var WHITE_ANCHOR_MIN = 185;      // luminance mini d'un pixel d'UI blanche (min des canaux)
var WHITE_ANCHOR_CHROMA = 34;    // chroma maxi (blanc/gris clair, peu sature)
var LABEL_OFFSET_X = 0.69;       // decalage label -> centre de tuile, en unites de tuile (mesure)
var LABEL_OFFSET_Y = 0.05;
var LABEL_ORANGE_REJECT = 0.10; // un label pose sur >=10% d'orange est un oeil de feu translucide, pas un label
var MIN_BLOB_FRAC = 8e-5;
var MAX_BLOB_FRAC = 7e-4;
var FOOT_FRAC = 0.18;
var R_ISO = 0.50;
var ENEMY_THRESH = 0.11;
var FIRE_REVIEW_THRESH = 0.070;
var FIRE_MIN_COMPONENT_SHARE = 0.50;
var FIRE_STRONG_COMPONENT_SHARE = 0.50;
var FIRE_EDGE_GRADIENT = 58;
var FIRE_UI_EDGE_MIN_FRAC = 0.52;
var FIRE_PROFILE_NEAR = 0.34;
var GLYPH_MIN_COMPONENT = 80;
var GLYPH_MAX_COMPONENT = 6000;
var GLYPH_MIN_NORM = 0.045;
// Decoupage des glyphes fusionnes : deux glyphes violets adjacents peuvent se toucher dans le masque
// et ne former qu'un seul composant connexe (frequent quand la transparence delave/etale le violet).
var GLYPH_OVERSIZE_NORM = 0.9;   // au-dela de ~0.9*s^2, un composant couvre probablement 2 cellules
var GLYPH_CELL_FRAC = 0.20;      // fraction violette mini dans la fenetre d'une cellule pour compter un glyphe

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function isGlyphPixelRGB(r, g, b) {
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return b > 60 && r > 50 && b > g + 18 && r > g + 10 && (mx - mn) > 25;
}

function buildCanvasFromImage(img) {
  if (typeof document === 'undefined') throw new Error('buildCanvasFromImage nécessite un navigateur. Utilise analyzeImageData côté worker/node.');
  var w = img.width, h = img.height;
  var cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { canvas: cv, ctx: ctx, w: w, h: h };
}

// --- composantes connexes 4-connexes ---
function components(mask, w, h) {
  var lbl = new Int32Array(w*h);
  for (var ii=0; ii<lbl.length; ii++) lbl[ii] = -1;
  var stack = new Int32Array(w*h);
  var blobs = [];
  for (var i=0; i<w*h; i++) {
    if (!mask[i] || lbl[i] !== -1) continue;
    var id = blobs.length, sp = 0;
    stack[sp++] = i; lbl[i] = id;
    var n = 0, sx = 0, sy = 0, xmin = w, xmax = 0, ymin = h, ymax = 0, touch = false;
    while (sp > 0) {
      var p = stack[--sp], x = p % w, y = (p / w) | 0;
      n++; sx += x; sy += y;
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (x <= 1 || y <= 1 || x >= w-2 || y >= h-2) touch = true;
      if (x > 0 && mask[p-1] && lbl[p-1] === -1) { lbl[p-1] = id; stack[sp++] = p-1; }
      if (x < w-1 && mask[p+1] && lbl[p+1] === -1) { lbl[p+1] = id; stack[sp++] = p+1; }
      if (y > 0 && mask[p-w] && lbl[p-w] === -1) { lbl[p-w] = id; stack[sp++] = p-w; }
      if (y < h-1 && mask[p+w] && lbl[p+w] === -1) { lbl[p+w] = id; stack[sp++] = p+w; }
    }
    blobs.push({ size:n, cx:sx/n, cy:sy/n, xmin:xmin, xmax:xmax, ymin:ymin, ymax:ymax, touch:touch });
  }
  return blobs;
}

// Variante avec labels : utilisée une fois par screenshot pour mesurer la cohérence
// des masses orange à l’intérieur de chaque case, sans heuristique d’interface.
function labelMaskComponents(mask, w, h) {
  var lbl = new Int32Array(w*h);
  for (var ii=0; ii<lbl.length; ii++) lbl[ii] = -1;
  var stack = new Int32Array(w*h);
  var blobs = [];
  for (var i=0; i<w*h; i++) {
    if (!mask[i] || lbl[i] !== -1) continue;
    var id = blobs.length, sp = 0;
    stack[sp++] = i; lbl[i] = id;
    var n = 0, sx = 0, sy = 0, xmin = w, xmax = 0, ymin = h, ymax = 0;
    while (sp > 0) {
      var p = stack[--sp], x = p % w, y = (p / w) | 0;
      n++; sx += x; sy += y;
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (x > 0 && mask[p-1] && lbl[p-1] === -1) { lbl[p-1] = id; stack[sp++] = p-1; }
      if (x < w-1 && mask[p+1] && lbl[p+1] === -1) { lbl[p+1] = id; stack[sp++] = p+1; }
      if (y > 0 && mask[p-w] && lbl[p-w] === -1) { lbl[p-w] = id; stack[sp++] = p-w; }
      if (y < h-1 && mask[p+w] && lbl[p+w] === -1) { lbl[p+w] = id; stack[sp++] = p+w; }
    }
    blobs.push({ size:n, cx:sx/n, cy:sy/n, xmin:xmin, xmax:xmax, ymin:ymin, ymax:ymax });
  }
  return { labels:lbl, blobs:blobs };
}

function erodeMask3x3(mask, w, h) {
  var out = new Uint8Array(w*h);
  for (var y=1; y<h-1; y++) {
    var base = y*w;
    for (var x=1; x<w-1; x++) {
      var i = base + x;
      if (mask[i] && mask[i-1] && mask[i+1] && mask[i-w] && mask[i+w] &&
          mask[i-w-1] && mask[i-w+1] && mask[i+w-1] && mask[i+w+1]) out[i] = 1;
    }
  }
  return out;
}

function pruneSplitGlyphArtifacts(glyphs, s) {
  var out = (glyphs || []).slice();
  var smallMax = Math.max(260, 0.16*s*s), maxDist = Math.max(18, 0.75*s);
  while (out.length > 6) {
    var best = null;
    for (var i=0; i<out.length; i++) for (var j=i+1; j<out.length; j++) {
      var a=out[i], b=out[j], cheb=Math.max(Math.abs(a.gx-b.gx),Math.abs(a.gy-b.gy));
      if (cheb > 1 || a.size > smallMax || b.size > smallMax) continue;
      var dist=Math.hypot((a.cx||0)-(b.cx||0),(a.cy||0)-(b.cy||0));
      if (dist > maxDist) continue;
      var penalty=Math.max(a.size,b.size)+dist*3+(a.size+b.size)*0.05;
      if (!best || penalty < best.penalty) best={i:i,j:j,penalty:penalty};
    }
    if (!best) break;
    out.splice(out[best.i].size < out[best.j].size ? best.i : best.j, 1);
  }
  return out.sort(function(a,b){ return (a.gy-b.gy) || (a.gx-b.gx); });
}

function blobGlyphHits(glyphMask, w, h, blob, pad) {
  var x0=Math.max(0,(blob.xmin-pad)|0), x1=Math.min(w-1,(blob.xmax+pad)|0);
  var y0=Math.max(0,(blob.ymin-pad)|0), y1=Math.min(h-1,(blob.ymax+pad)|0), n=0;
  for (var y=y0;y<=y1;y++) { var base=y*w; for (var x=x0;x<=x1;x++) if (glyphMask[base+x]) n++; }
  return n;
}

function candidateAnchorBlobs(mask, w, h, glyphMask, minSz, maxSz, source) {
  return components(mask,w,h).filter(function(bb){
    return !bb.touch && bb.size >= minSz && bb.size <= maxSz &&
      bb.cx > 0.12*w && bb.cx < 0.92*w && bb.cy > 0.18*h && bb.cy < 0.82*h &&
      blobGlyphHits(glyphMask,w,h,bb,8) < 18;
  }).map(function(bb){ bb.anchor_source=source; return bb; });
}

function detectEnemiesFast(orange, w, h, s, Ox, Oy, r) {
  var tileH=2*s*r, hw=0.26*2*s, hh=0.34*tileH, ys=0.28*tileH, enemies=[];
  for (var i=0;i<DETECTION_CELLS.length;i++) {
    var cell=DETECTION_CELLS[i], ck=cell.gx+','+cell.gy;
    if (DETECTION_PB_CELLS.has(ck)) continue;
    var cx=Ox+(cell.gx-cell.gy)*s, cy=Oy+(cell.gx+cell.gy)*s*r-ys;
    var x0=Math.max(0,(cx-hw)|0),x1=Math.min(w,(cx+hw)|0),y0=Math.max(0,(cy-hh)|0),y1=Math.min(h,(cy+hh)|0);
    var cnt=0,tot=0,sx=0,sy=0;
    for (var y=y0;y<y1;y++) { var base=y*w; for (var x=x0;x<x1;x++) { tot++; if(orange[base+x]) { cnt++; sx+=x; sy+=y; } } }
    if (!tot) continue;
    var frac=cnt/tot;
    if (frac >= ENEMY_THRESH) enemies.push({gx:cell.gx,gy:cell.gy,frac:frac,ox:sx/cnt,oy:sy/cnt});
  }
  return enemies;
}
// Compatibilité API historique.
function detectEnemies(orange, w, h, s, Ox, Oy, r) { return detectEnemiesFast(orange,w,h,s,Ox,Oy,r); }

function scoreAnchorPairWithCalibration(L, R, field, orange, w, h, baseScore) {
  var s=(R.cx-L.cx)/10;
  // Les screenshots 4K peuvent produire un pas de grille supérieur à 90 px.
  // Le plafond reste présent pour éviter les couples d'ancres absurdes,
  // mais il est relevé pour accepter les captures très haute résolution.
  const maxScale = Math.min(220, Math.max(90, w * 0.045));
  if (!isFinite(s) || s<=15 || s>=maxScale) return null;
  var fit=computeVertical(field,w,h,s,L.cx,L.cy);
  var enemies=detectEnemiesFast(orange,w,h,s,L.cx,fit.Oy,fit.r);
  var ys=0.28*2*s*fit.r, dev=0;
  for (var i=0;i<enemies.length;i++) {
    var e=enemies[i], ex=L.cx+(e.gx-e.gy)*s, ey=fit.Oy+(e.gx+e.gy)*s*fit.r-ys;
    dev+=Math.hypot(e.ox-ex,e.oy-ey);
  }
  var meanDev=enemies.length?dev/enemies.length:999, resid=Math.abs(L.cy-R.cy);
  var score=baseScore+6.0*fit.onFrac+0.25*Math.min(enemies.length,36)-0.12*meanDev-
    Math.min(3.0,(resid/Math.max(1,s*fit.r))*0.35);
  if (enemies.length < 24) score -= (24-enemies.length)*0.85;
  if (fit.onFrac < 0.52) score -= (0.52-fit.onFrac)*10.0;
  if (enemies.length > 40) score -= (enemies.length-40)*0.40;
  var lH=L.ymax-L.ymin+1, rH=R.ymax-R.ymin+1, minAnchorHeightNorm=Math.min(lH/s,rH/s);
  if (minAnchorHeightNorm < 0.50) score -= (0.50-minAnchorHeightNorm)*18.0;
  var minAnchorSizeNorm=Math.min(L.size/(s*s),R.size/(s*s));
  if (minAnchorSizeNorm < 0.10) score -= (0.10-minAnchorSizeNorm)*16.0;
  if (enemies.length > 30) score -= (enemies.length-30)*0.65;
  return {score:score,baseScore:baseScore,s:s,onFrac:fit.onFrac,enemiesCount:enemies.length,meanDev:meanDev,resid:resid,
    source:L.anchor_source||R.anchor_source||'unknown',anchorMinHeightNorm:minAnchorHeightNorm,anchorMinSizeNorm:minAnchorSizeNorm};
}

function findAnchors(data, w, h) {
  var N=w*h, sprite=new Uint8Array(N), field=new Uint8Array(N), orange=new Uint8Array(N), glyphMask=new Uint8Array(N);
  for (var i=0,p=0;i<N;i++,p+=4) {
    var r=data[p],g=data[p+1],b=data[p+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b),glyphish=isGlyphPixelRGB(r,g,b);
    if (glyphish) glyphMask[i]=1;
    if (g>r+4 && g>80 && b>g-70 && b<g+50 && (r+g+b)>150) field[i]=1;
    if (r>150 && r>g+18 && g>b-5 && (r-b)>55) orange[i]=1;
    if (!glyphish && mx<DARK_MAX && (mx-mn)<DARK_CHROMA && b>=g-8 && r<=g+12) sprite[i]=1;
  }
  var minSz=MIN_BLOB_FRAC*N,maxSz=MAX_BLOB_FRAC*N;
  var rawBlobs=candidateAnchorBlobs(sprite,w,h,glyphMask,minSz,maxSz,'raw');
  var erodedBlobs=candidateAnchorBlobs(erodeMask3x3(sprite,w,h),w,h,glyphMask,minSz,maxSz,'eroded');
  var groups=[rawBlobs,erodedBlobs], blobs=rawBlobs.concat(erodedBlobs), best=null;
  for (var gi=0;gi<groups.length;gi++) {
    var group=groups[gi];
    for (var bi=0;bi<group.length;bi++) for (var bj=bi+1;bj<group.length;bj++) {
      var a=group[bi],c=group[bj],dy=Math.abs(a.cy-c.cy),dx=Math.abs(a.cx-c.cx);
      if (dx<=0.10*w || dx>=0.85*w || dy>Math.max(14,0.04*dx)) continue;
      var L=a.cx<c.cx?a:c,R=a.cx<c.cx?c:a,sim=Math.min(a.size,c.size)/Math.max(a.size,c.size);
      var centerPen=Math.abs(L.cx-w/2)/w,botPen=Math.max(0,(Math.max(a.cy,c.cy)-0.75*h))/h;
      var baseScore=sim-(dy/dx)*9.0-2.0*centerPen-3.0*botPen;
      var calibrated=scoreAnchorPairWithCalibration(L,R,field,orange,w,h,baseScore);
      if (!calibrated) continue;
      if (!best || calibrated.score>best.score) best={score:calibrated.score,pair_score:baseScore,validation:calibrated,player:L,bolgrot:R};
    }
  }

  // ---- Repli d'ancrage sur l'UI blanche (transparence des entites) --------------------------
  // Quand la transparence des entites est active en jeu, le fond vert du plateau transparait a
  // travers le sprite gris du joueur (pose sur la plateforme verte) : ses pixels virent "trop verts"
  // et "trop chromatiques", le masque sprite strict les rejette et le blob se fragmente sous minSz.
  // Plus d'ancre gauche -> calibrage a demi-echelle ou introuvable. Le label "2" (et le "1" du Bolgrot)
  // sont eux dessines par-dessus la scene et restent blancs et nets. On les detecte (blobs blancs hauts,
  // meme y, distants de 10*s) et on recale via le scoring existant, qui rejette le ghosting a petite
  // echelle. Cette detection tourne TOUJOURS et sa meilleure paire est mise en concurrence avec la
  // paire stricte via le meme scoring : sur une capture opaque la paire stricte domine (~12 vs ~10)
  // -> resultat inchange ; sur une capture translucide la paire stricte est fausse/faible/absente et
  // la paire de labels l'emporte. NB : un mauvais calibrage strict peut "ghoster" a >=24 feux, donc un
  // simple seuil de feux ne suffit pas a le detecter -> on laisse le scoring trancher.
  {
    var whiteMask = new Uint8Array(N);
    for (var wi=0, wp=0; wi<N; wi++, wp+=4) {
      var wr=data[wp], wg=data[wp+1], wb=data[wp+2];
      var wmx=Math.max(wr,wg,wb), wmn=Math.min(wr,wg,wb);
      if (wmn>WHITE_ANCHOR_MIN && (wmx-wmn)<WHITE_ANCHOR_CHROMA) whiteMask[wi]=1;
    }
    var whiteBlobs = components(whiteMask, w, h), labelBlobs = [];
    for (var li=0; li<whiteBlobs.length; li++) {
      var lbb=whiteBlobs[li], lw=lbb.xmax-lbb.xmin+1, lh=lbb.ymax-lbb.ymin+1;
      if (lbb.touch) continue;
      if (lh < lw*1.2) continue;                                   // un label est plus haut que large
      if (lh < 8 || lh > 0.05*h+20) continue;                      // borne de taille absolue
      if (lbb.size < Math.max(18, 2.5e-6*N) || lbb.size > 1.3e-4*N) continue;
      if (lbb.cx < 0.06*w || lbb.cx > 0.95*w || lbb.cy < 0.12*h || lbb.cy > 0.78*h) continue;
      // Rejet des yeux blancs des feux translucides : l'oeil est pose sur le corps orange du feu,
      // alors que les tuiles Joueur/Bolgrot ne contiennent pas d'orange. Discriminant tres net
      // (feu ~0.24 d'orange autour, label ~0.00).
      var opad=Math.max(6, lh|0);
      var ox0=Math.max(0,(lbb.xmin-opad)|0), ox1=Math.min(w,(lbb.xmax+opad)|0);
      var oy0=Math.max(0,(lbb.ymin-opad)|0), oy1=Math.min(h,(lbb.ymax+opad)|0);
      var ocnt=0, otot=0;
      for (var oy=oy0; oy<oy1; oy++){ var obase=oy*w; for (var oxx=ox0; oxx<ox1; oxx++){ otot++; if (orange[obase+oxx]) ocnt++; } }
      if (otot && ocnt/otot >= LABEL_ORANGE_REJECT) continue;
      labelBlobs.push(lbb);
    }
    var labelBest = null;
    for (var pi=0; pi<labelBlobs.length; pi++) for (var pj=0; pj<labelBlobs.length; pj++) {
      if (pi===pj) continue;
      var La=labelBlobs[pi], Ra=labelBlobs[pj], dxl=Ra.cx-La.cx, dyl=Math.abs(Ra.cy-La.cy);
      if (dxl < 0.05*w || dxl > 0.6*w) continue;                   // joueur -> Bolgrot : d differe de 10
      if (dyl > 0.05*dxl) continue;                                // meme k -> meme y ecran
      var sl = dxl/10; if (sl<12 || sl>110) continue;
      var Lc={cx:La.cx+LABEL_OFFSET_X*sl, cy:La.cy+LABEL_OFFSET_Y*sl, size:La.size};
      var Rc={cx:Ra.cx+LABEL_OFFSET_X*sl, cy:Ra.cy+LABEL_OFFSET_Y*sl, size:Ra.size};
      var calL = scoreAnchorPairWithCalibration(Lc, Rc, field, orange, w, h, 0);
      if (!calL) continue;
      if (!labelBest || calL.score>labelBest.score) labelBest={score:calL.score, pair_score:0, validation:calL, player:Lc, bolgrot:Rc};
    }
    if (labelBest && (!best || labelBest.score>best.score)) { best=labelBest; blobs=blobs.concat(labelBlobs); }
  }
  return {best:best,field:field,orange:orange,glyphMask:glyphMask,blobs:blobs};
}

function computeVertical(field, w, h, s, Ox, playerCy) {
  var r=R_ISO,tileH=2*s*r,Oy=(playerCy+FOOT_FRAC*tileH)-30*s*r,on=0;
  for (var i=0;i<DETECTION_CELLS.length;i++) {
    var cell=DETECTION_CELLS[i],k=cell.gx+cell.gy,d=cell.gx-cell.gy,px=(Ox+d*s)|0,py=(Oy+k*s*r)|0;
    if (px>=0 && px<w && py>=0 && py<h && field[py*w+px]) on++;
  }
  return {r:r,Oy:Oy,onFrac:on/DETECTION_CELLS.length};
}

function isValidPlayableCell(gx,gy) {
  return gy>=0 && gy<DEFAULT_BOARD.length && gx>=0 && gx<DEFAULT_BOARD[gy].length && (DEFAULT_BOARD[gy][gx]==='.' || DEFAULT_BOARD[gy][gx]==='P');
}
function screenToGridApprox(x,y,s,Ox,Oy,r) {
  var d=(x-Ox)/s,k=(y-Oy)/(s*r);
  return {gx:Math.round((k+d)/2),gy:Math.round((k-d)/2),d:d,k:k};
}

function fireWindow(cell, s, Ox, Oy, r) {
  var tileH=2*s*r, hw=0.26*2*s, hh=0.34*tileH, ys=0.28*tileH;
  var cx=Ox+(cell.gx-cell.gy)*s, cy=Oy+(cell.gx+cell.gy)*s*r-ys;
  return {cx:cx,cy:cy,x0:cx-hw,x1:cx+hw,y0:cy-hh,y1:cy+hh,expectedArea:(2*hw)*(2*hh)};
}

function localMaskEvidence(mask, labels, w, h, rawWindow) {
  var x0=Math.max(0,Math.floor(rawWindow.x0)),x1=Math.min(w,Math.ceil(rawWindow.x1));
  var y0=Math.max(0,Math.floor(rawWindow.y0)),y1=Math.min(h,Math.ceil(rawWindow.y1));
  var total=Math.max(0,(x1-x0)*(y1-y0)), hit=0,sx=0,sy=0,counts=new Map(), bins=new Float32Array(12);
  var rawW=Math.max(1,rawWindow.x1-rawWindow.x0),rawH=Math.max(1,rawWindow.y1-rawWindow.y0);
  for (var y=y0;y<y1;y++) {
    var base=y*w;
    for (var x=x0;x<x1;x++) {
      var ii=base+x;
      if (!mask[ii]) continue;
      hit++; sx+=x; sy+=y;
      var bx=Math.min(3,Math.max(0,Math.floor(((x-rawWindow.x0)/rawW)*4)));
      var by=Math.min(2,Math.max(0,Math.floor(((y-rawWindow.y0)/rawH)*3)));
      bins[by*4+bx]++;
      if (labels) { var id=labels[ii]; counts.set(id,(counts.get(id)||0)+1); }
    }
  }
  var largest=0;
  counts.forEach(function(v){ if(v>largest) largest=v; });
  if(hit) for(var bi=0;bi<bins.length;bi++) bins[bi]/=hit;
  return {count:hit,frac:total?hit/total:0,ox:hit?sx/hit:null,oy:hit?sy/hit:null,
    largestComponent:largest,largestShare:hit?largest/hit:0,
    visibleFraction:clamp01(total/Math.max(1,rawWindow.expectedArea)),componentCount:counts.size,
    profile:Array.prototype.slice.call(bins)};
}

function luminanceAt(data, index) { return 0.2126*data[index] + 0.7152*data[index+1] + 0.0722*data[index+2]; }

// L’UI Dofus est dessinée selon les axes écran : panneaux, bordures et séparateurs ont des traits
// horizontaux/verticaux longs. Le plateau et ses sprites sont au contraire principalement diagonaux ou courbes.
// On ne cherche donc pas « l'UI à droite » ou « l'UI en bas » : on mesure seulement cette signature locale.
function screenAlignedOverlayEvidence(data,w,h,rawWindow,s) {
  if(!data) return {score:0,verticalRun:0,horizontalRun:0,likely:false};
  var pad=Math.max(3,Math.round(0.44*s));
  var x0=Math.max(1,Math.floor(rawWindow.x0-pad)),x1=Math.min(w-1,Math.ceil(rawWindow.x1+pad));
  var y0=Math.max(1,Math.floor(rawWindow.y0-pad)),y1=Math.min(h-1,Math.ceil(rawWindow.y1+pad));
  var rw=Math.max(1,x1-x0),rh=Math.max(1,y1-y0),vBest=0,hBest=0;
  for(var x=x0;x<x1;x++) {
    var run=0;
    for(var y=y0;y<y1;y++) {
      var ia=(y*w+x-1)*4,ib=(y*w+x)*4;
      var edge=Math.abs(luminanceAt(data,ia)-luminanceAt(data,ib))>=FIRE_EDGE_GRADIENT;
      run=edge?run+1:0; if(run>vBest) vBest=run;
    }
  }
  for(var y=y0;y<y1;y++) {
    var hrun=0;
    for(var xx=x0;xx<x1;xx++) {
      var ja=((y-1)*w+xx)*4,jb=(y*w+xx)*4;
      var hedge=Math.abs(luminanceAt(data,ja)-luminanceAt(data,jb))>=FIRE_EDGE_GRADIENT;
      hrun=hedge?hrun+1:0; if(hrun>hBest) hBest=hrun;
    }
  }
  var score=Math.max(vBest/rh,hBest/rw),minPixels=Math.max(10,Math.round(0.36*s));
  return {score:score,verticalRun:vBest,horizontalRun:hBest,
    likely:score>=FIRE_UI_EDGE_MIN_FRAC && Math.max(vBest,hBest)>=minPixels};
}

function fireProfileDistance(a,b) {
  var pa=a.profile||[],pb=b.profile||[],d=0;
  for(var i=0;i<Math.min(pa.length,pb.length);i++) d+=Math.abs(pa[i]-pb[i]);
  d=0.72*d + 0.16*Math.min(1,Math.abs(a.frac-b.frac)/0.22) + 0.12*Math.min(1,Math.abs(a.largestShare-b.largestShare)/0.35);
  return d;
}

// Les vrais feux sont nombreux sur une même image. Une icône UI isolée qui passe le masque orange
// ne ressemble généralement à aucun feu voisin. Le test n'est jamais un rejet direct : il devient une alerte jaune.
function addFirePrototypeEvidence(all) {
  var pool=all.filter(function(ev){return ev.positive && ev.largestShare>=FIRE_STRONG_COMPONENT_SHARE && ev.visibleFraction>=0.72 && !ev.overlayLike;});
  for(var i=0;i<all.length;i++) {
    var ev=all[i],nearest=Infinity,support=0;
    if(ev.positive && ev.profile && pool.length>=8) {
      for(var j=0;j<pool.length;j++) {
        if(pool[j]===ev) continue;
        var d=fireProfileDistance(ev,pool[j]);
        if(d<nearest) nearest=d;
        if(d<=FIRE_PROFILE_NEAR) support++;
      }
    }
    ev.prototypeNearest=nearest;
    ev.prototypeSupport=support;
    ev.prototypeOutlier=!!(ev.positive && ev.visibleFraction>=0.72 && isFinite(nearest) && nearest>FIRE_PROFILE_NEAR && support===0);
  }
}

function confidenceFire(ev) {
  var fracScore=clamp01((ev.frac-0.06)/0.34), shapeScore=clamp01((ev.largestShare-0.22)/0.60);
  var raw=0.12+0.47*fracScore+0.35*shapeScore+0.06*ev.visibleFraction;
  if(ev.uiConcern) raw-=0.22;
  return clamp01(raw);
}
function fireReviewReasons(ev, state) {
  var reasons=[];
  if (state==='possible_missing') reasons.push('signal orange sous le seuil de confirmation');
  if (ev.largestShare < FIRE_MIN_COMPONENT_SHARE) reasons.push('masse orange fragmentée');
  if (ev.uiConcern) {
    reasons.push('structure d’interface rectiligne autour de la case');
    reasons.push('apparence orange atypique par rapport aux feux visibles');
  }
  // Le crop est une information d’observabilité, pas un veto sur un feu très net.
  if (ev.visibleFraction < 0.58 && state!=='confirmed') reasons.push('case largement hors image');
  return reasons;
}

function classifyFires(orange, orangeInfo, data, w, h, s, Ox, Oy, r) {
  var raw=[];
  for (var i=0;i<DETECTION_CELLS.length;i++) {
    var cell=DETECTION_CELLS[i],key=cell.gx+','+cell.gy;
    if (DETECTION_PB_CELLS.has(key)) continue;
    var win=fireWindow(cell,s,Ox,Oy,r),ev=localMaskEvidence(orange,orangeInfo.labels,w,h,win);
    ev.gx=cell.gx; ev.gy=cell.gy; ev.positive=ev.frac>=ENEMY_THRESH;
    ev.overlay=screenAlignedOverlayEvidence(data,w,h,win,s); ev.overlayLike=ev.overlay.likely;
    raw.push(ev);
  }
  addFirePrototypeEvidence(raw);
  var confirmed=[],suspects=[],evidence=[];
  for(var ri=0;ri<raw.length;ri++) {
    var ev=raw[ri]; ev.confidence=confidenceFire(ev);
    var strongVisual=ev.positive && ev.largestShare>=FIRE_STRONG_COMPONENT_SHARE;
    // Une bordure UI seule n'est pas une preuve : un feu réel peut être proche d'un panneau.
    // On exige aussi que sa signature orange soit isolée parmi les feux de la même image.
    ev.uiConcern=!!(ev.overlayLike && ev.prototypeOutlier);
    // Important : une fenêtre qui touche le bord ne rend pas un feu visible faux.
    var isStrong=strongVisual && !ev.uiConcern;
    var isPossibleMissing=!ev.positive && ev.frac>=FIRE_REVIEW_THRESH && ev.largestShare>=0.48 && ev.visibleFraction>=0.45;
    evidence.push({gx:ev.gx,gy:ev.gy,frac:ev.frac,largestComponent:ev.largestComponent,largestShare:ev.largestShare,
      visibleFraction:ev.visibleFraction,componentCount:ev.componentCount,confidence:ev.confidence,overlayScore:ev.overlay.score,
      overlayLike:ev.overlayLike,uiConcern:ev.uiConcern,prototypeNearest:isFinite(ev.prototypeNearest)?ev.prototypeNearest:null,prototypeSupport:ev.prototypeSupport,
      state:isStrong?'confirmed':(ev.positive?'uncertain_positive':(isPossibleMissing?'possible_missing':'empty'))});
    if(isStrong) {
      confirmed.push({gx:ev.gx,gy:ev.gy,frac:ev.frac,ox:ev.ox,oy:ev.oy,confidence:ev.confidence,
        largestComponent:ev.largestComponent,largestShare:ev.largestShare,visibleFraction:ev.visibleFraction,
        suspect:false,suspectReasons:[]});
    } else if(ev.positive || isPossibleMissing) {
      var state=ev.positive?'uncertain_positive':'possible_missing';
      suspects.push({gx:ev.gx,gy:ev.gy,kind:'fire',status:state,confidence:ev.confidence,frac:ev.frac,
        largestComponent:ev.largestComponent,largestShare:ev.largestShare,visibleFraction:ev.visibleFraction,
        overlayScore:ev.overlay.score,uiConcern:ev.uiConcern,prototypeNearest:isFinite(ev.prototypeNearest)?ev.prototypeNearest:null,prototypeSupport:ev.prototypeSupport,
        reasons:fireReviewReasons(ev,state),suspect:true});
    }
  }
  return {enemies:confirmed,suspects:suspects,evidence:evidence};
}

function confidenceGlyph(item) {
  var sizeScore=clamp01((item.sizeNorm-0.025)/0.18);
  var aspectScore=clamp01(1-Math.abs(Math.log(Math.max(0.01,item.aspect)/2))/Math.log(3));
  var alignScore=clamp01(1-item.gridResidual/0.32);
  return clamp01(0.18+0.38*sizeScore+0.26*aspectScore+0.18*alignScore);
}
function glyphReasons(item, confirmed) {
  var out=[];
  if (item.sizeNorm < GLYPH_MIN_NORM) out.push('signature violette trop petite');
  if (item.aspect < 1.20 || item.aspect > 3.40) out.push('forme non compatible avec un losange isométrique');
  if (item.gridResidual > 0.28) out.push('mal centré sur sa case');
  if (!confirmed && !out.length) out.push('signature violette ambiguë');
  return out;
}

function glyphCellPurpleEvidence(glyphMask, w, h, s, Ox, Oy, r, gx, gy) {
  var cx=Ox+(gx-gy)*s, cy=Oy+(gx+gy)*s*r, hw=0.55*s, hh=0.55*s*r;
  var x0=Math.max(0,(cx-hw)|0), x1=Math.min(w,(cx+hw)|0), y0=Math.max(0,(cy-hh)|0), y1=Math.min(h,(cy+hh)|0);
  var cnt=0, tot=0, sx=0, sy=0;
  for (var y=y0;y<y1;y++){ var base=y*w; for (var x=x0;x<x1;x++){ tot++; if (glyphMask[base+x]){ cnt++; sx+=x; sy+=y; } } }
  return { frac: tot?cnt/tot:0, count:cnt, px:cnt?sx/cnt:cx, py:cnt?sy/cnt:cy };
}

function classifyGlyphs(glyphMask, w, h, s, Ox, Oy, r, enemies) {
  var minNormPixels=Math.max(GLYPH_MIN_COMPONENT,Math.round(GLYPH_MIN_NORM*s*s));
  var raw=components(glyphMask,w,h), enemyCells=new Set((enemies||[]).map(function(e){return e.gx+','+e.gy;}));
  var confirmedByCell=new Map(), suspectByCell=new Map(), allCandidates=[];
  // Emet un candidat glyphe pour une empreinte violette a la position ecran (px,py). Chemin identique
  // au comportement historique : un composant de taille normale appelle emitAt une fois sur son centroide.
  function emitAt(px, py, size, wid, hei) {
    var gg=screenToGridApprox(px,py,s,Ox,Oy,r);
    if (!isValidPlayableCell(gg.gx,gg.gy)) return;
    var key=gg.gx+','+gg.gy;
    if (DETECTION_PB_CELLS.has(key) || enemyCells.has(key)) return;
    var gxFloat=(gg.k+gg.d)/2, gyFloat=(gg.k-gg.d)/2;
    var item={gx:gg.gx,gy:gg.gy,size:size,cx:px,cy:py,raw_d:gg.d,raw_k:gg.k,
      sizeNorm:size/Math.max(1,s*s),gridResidual:Math.hypot(gxFloat-gg.gx,gyFloat-gg.gy),
      width:wid,height:hei,aspect:wid/Math.max(1,hei)};
    item.confidence=confidenceGlyph(item);
    var strong=item.size>=minNormPixels && item.aspect>=1.20 && item.aspect<=3.40 && item.gridResidual<=0.28;
    item.reasons=glyphReasons(item,strong); allCandidates.push(Object.assign({state:strong?'confirmed':'uncertain_positive'},item));
    if (strong) {
      if (!confirmedByCell.has(key) || item.confidence>confirmedByCell.get(key).confidence) confirmedByCell.set(key,item);
    } else if (!suspectByCell.has(key) || item.confidence>suspectByCell.get(key).confidence) {
      suspectByCell.set(key,item);
    }
  }
  for (var i=0;i<raw.length;i++) {
    var bb=raw[i];
    if (bb.size<GLYPH_MIN_COMPONENT || bb.size>GLYPH_MAX_COMPONENT) continue;
    if (bb.xmin<=1 || bb.xmax>=w-2 || bb.ymax>=h-2 || bb.cx<=0.08*w || bb.cx>=0.95*w || bb.cy<0 || bb.cy>=0.95*h) continue;
    var wid=bb.xmax-bb.xmin+1, hei=bb.ymax-bb.ymin+1;
    // Composant sur-dimensionne = probablement 2 glyphes adjacents fusionnes -> redecoupage par cellule.
    // Les composants normaux suivent le chemin historique inchange (aucune regression sur l'opaque).
    if (bb.size > GLYPH_OVERSIZE_NORM*s*s) {
      var gc=screenToGridApprox(bb.cx,bb.cy,s,Ox,Oy,r), emitted=0;
      var nomW=Math.round(1.86*s), nomH=Math.round(0.93*s);
      for (var dgy=-1; dgy<=1; dgy++) for (var dgx=-1; dgx<=1; dgx++) {
        var cgx=gc.gx+dgx, cgy=gc.gy+dgy;
        if (!isValidPlayableCell(cgx,cgy)) continue;
        var ev=glyphCellPurpleEvidence(glyphMask,w,h,s,Ox,Oy,r,cgx,cgy);
        if (ev.frac < GLYPH_CELL_FRAC || ev.count < minNormPixels) continue;
        emitAt(ev.px, ev.py, ev.count, nomW, nomH); emitted++;
      }
      if (emitted===0) emitAt(bb.cx, bb.cy, bb.size, wid, hei);
    } else {
      emitAt(bb.cx, bb.cy, bb.size, wid, hei);
    }
  }
  var glyphs=pruneSplitGlyphArtifacts(Array.from(confirmedByCell.values()),s);
  var confirmedKeys=new Set(glyphs.map(function(g){return g.gx+','+g.gy;}));
  var suspects=[];
  suspectByCell.forEach(function(item,key){
    if (confirmedKeys.has(key)) return;
    suspects.push({gx:item.gx,gy:item.gy,kind:'glyph',status:'uncertain_positive',confidence:item.confidence,
      size:item.size,sizeNorm:item.sizeNorm,gridResidual:item.gridResidual,aspect:item.aspect,
      reasons:item.reasons,suspect:true});
  });
  for (var j=0;j<glyphs.length;j++) { glyphs[j].suspect=false; glyphs[j].suspectReasons=[]; }
  return {glyphs:glyphs,suspects:suspects,candidates:allCandidates};
}

// Compatibilité API historique : les appels externes obtiennent les glyphes confirmés.
function detectGlyphs(glyphMask,w,h,s,Ox,Oy,r,enemies) { return classifyGlyphs(glyphMask,w,h,s,Ox,Oy,r,enemies).glyphs; }

function reviewLevel(found, fit, resid, s, suspects) {
  var blockers=[];
  if (fit.onFrac < 0.38) blockers.push('recouvrement du plateau trop faible');
  if ((resid/Math.max(1,s*fit.r)) > 0.45) blockers.push('ancres Joueur/Bolgrot incohérentes');
  return {quality:blockers.length?'blocked':(suspects.length?'review':'ok'),blockers:blockers,requiresReview:!!suspects.length};
}

function analyzeImageData(imageData,w,h,canvasForOverlay) {
  var data=imageData.data||imageData, found=findAnchors(data,w,h);
  if (!found.best) return {ok:false,reason:'no_anchors',w:w,h:h,quality:'blocked',review:{quality:'blocked',blockers:['joueur ou Bolgrot introuvable'],requiresReview:true}};
  var P=found.best.player,B=found.best.bolgrot,s=(B.cx-P.cx)/10,Ox=P.cx,fit=computeVertical(found.field,w,h,s,Ox,P.cy);
  var tf=function(gx,gy){return{x:Ox+(gx-gy)*s,y:fit.Oy+(gx+gy)*s*fit.r};};
  var projP=tf(DETECTION_PLAYER_CELL.gx,DETECTION_PLAYER_CELL.gy),projB=tf(DETECTION_BOLGROT_CELL.gx,DETECTION_BOLGROT_CELL.gy),resid=Math.abs(P.cy-B.cy);
  var orangeInfo=labelMaskComponents(found.orange,w,h);
  var fireResult=classifyFires(found.orange,orangeInfo,data,w,h,s,Ox,fit.Oy,fit.r);
  var glyphResult=classifyGlyphs(found.glyphMask,w,h,s,Ox,fit.Oy,fit.r,fireResult.enemies);
  var suspects=fireResult.suspects.concat(glyphResult.suspects).sort(function(a,b){return (a.gy-b.gy)||(a.gx-b.gx)||String(a.kind).localeCompare(String(b.kind));});
  var review=reviewLevel(found,fit,resid,s,suspects);
  var ys=0.28*2*s*fit.r,dev=0;
  for (var i=0;i<fireResult.enemies.length;i++) {
    var e=fireResult.enemies[i],ex=Ox+(e.gx-e.gy)*s,ey=fit.Oy+(e.gx+e.gy)*s*fit.r-ys;
    dev+=Math.hypot(e.ox-ex,e.oy-ey);
  }
  var meanDev=fireResult.enemies.length?dev/fireResult.enemies.length:0;
  return {ok:true,w:w,h:h,scale:1,player:P,bolgrot:B,s:s,Ox:Ox,r:fit.r,Oy:fit.Oy,onFrac:fit.onFrac,resid:resid,tf:tf,projP:projP,projB:projB,
    enemies:fireResult.enemies,glyphs:glyphResult.glyphs,suspects:suspects,review:review,quality:review.quality,meanDev:meanDev,
    suspectCounts:{enemies:suspects.filter(function(v){return v.kind==='fire';}).length,glyphs:suspects.filter(function(v){return v.kind==='glyph';}).length},
    cellEvidence:{fires:fireResult.evidence,glyphCandidates:glyphResult.candidates},canvas:canvasForOverlay||null};
}

function analyzeImage(img) {
  var built=buildCanvasFromImage(img),imageData=built.ctx.getImageData(0,0,built.w,built.h);
  return analyzeImageData(imageData,built.w,built.h,built.canvas);
}

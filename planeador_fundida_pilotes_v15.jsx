import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  Upload, Download, AlertTriangle, CheckCircle2, Settings2,
  PlayCircle, RotateCcw, Layers, Check, Pencil, Trash2,
  ChevronLeft, ChevronRight, SkipBack, SkipForward,
  MessageSquare, Send, X, Bot, User
} from "lucide-react";

// ─── multi-machine constants ───────────────────────────────────────────────────
const MACHINE_COLORS = ["#FF7A3D","#3ED9C6","#D96BFF","#FFC53D"];
const MACHINE_NAMES  = ["Máquina 1","Máquina 2","Máquina 3","Máquina 4"];

// ─── helpers ──────────────────────────────────────────────────────────────────

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function buildConflicts(piles, radius) {
  const adj = new Map(piles.map((p) => [p.id, []]));
  for (let i = 0; i < piles.length; i++)
    for (let j = i + 1; j < piles.length; j++)
      if (dist(piles[i], piles[j]) <= radius) {
        adj.get(piles[i].id).push(piles[j].id);
        adj.get(piles[j].id).push(piles[i].id);
      }
  return adj;
}

const DIRECTIONS = {
  none:  { label: "Sin preferencia (más cercano)", vec: null },
  east:  { label: "Hacia el este (→)",  vec: { x:  1, y:  0 } },
  west:  { label: "Hacia el oeste (←)", vec: { x: -1, y:  0 } },
  north: { label: "Hacia el norte (↑)", vec: { x:  0, y:  1 } },
  south: { label: "Hacia el sur (↓)",   vec: { x:  0, y: -1 } },
};

function startForDirection(piles, dirKey) {
  const vec = DIRECTIONS[dirKey]?.vec;
  if (!vec) return piles[0];
  let best = piles[0], bestProj = Infinity;
  for (const p of piles) {
    const proj = p.x * vec.x + p.y * vec.y;
    if (proj < bestProj) { bestProj = proj; best = p; }
  }
  return best;
}

// Build nearest-neighbor path with optional direction bias + optional drawn-path ordering.
//
// Buffer-aware mode (when perDay/bufferDays/radius are provided): the curing
// buffer is baked into the ORDER itself instead of being applied afterwards.
// At every step we compute, for each remaining candidate, the earliest day it
// could legally be cast (same rule scheduleAlongPath uses: capacity per day +
// minimum bufferDays vs. any already-placed neighbor within radius). A
// candidate that would force the crew to wait gets penalized, so the greedy
// search prefers the nearest/most-aligned pile that is ALREADY allowed today
// — exactly the pattern found in the Viale reference sequence (median step
// ~20 m even with a ~2 m grid pitch, because immediate neighbors are skipped
// until enough time has passed, not because of a long-range detour).
function buildPath(piles, { startId, dirKey, manualIds, drawnOrder, perDay, bufferDays, radius }) {
  const remaining = new Map(piles.map((p) => [p.id, p]));
  const path = [];
  const vec = DIRECTIONS[dirKey]?.vec || null;

  const useBuffer = radius > 0 && bufferDays > 0 && perDay > 0;
  const adj = useBuffer ? buildConflicts(piles, radius) : null;
  const dayOf = new Map();
  const perDayCount = new Map();
  let currentDay = 1;

  // Earliest day this pile could be cast given what's placed so far (read-only).
  function earliestDay(pileId) {
    let day = 1;
    while (true) {
      const count = perDayCount.get(day) || 0;
      const ok = adj.get(pileId).every((nId) => {
        const nDay = dayOf.get(nId);
        return nDay === undefined || Math.abs(nDay - day) >= bufferDays;
      });
      if (count < perDay && ok) return day;
      day++;
    }
  }

  function place(p) {
    path.push(p);
    remaining.delete(p.id);
    if (useBuffer) {
      const d = earliestDay(p.id);
      dayOf.set(p.id, d);
      perDayCount.set(d, (perDayCount.get(d) || 0) + 1);
      if (d > currentDay) currentDay = d;
    }
  }

  // 1. manual forced order first
  for (const id of manualIds || []) {
    if (remaining.has(id)) place(remaining.get(id));
  }

  // 2. if a drawn path exists, use it as the ordering guide
  if (drawnOrder && drawnOrder.length) {
    for (const id of drawnOrder) {
      if (remaining.has(id)) place(remaining.get(id));
    }
  }

  // 3. seed with explicit start pile if nothing placed yet
  if (!path.length) {
    const start = (startId && remaining.get(startId)) || startForDirection([...remaining.values()], dirKey);
    place(start);
  }

  // 4. nearest-neighbor (+ direction bias + curing-buffer bias) for the rest
  while (remaining.size) {
    const last = path[path.length - 1];
    let best = null, bestScore = Infinity;
    for (const p of remaining.values()) {
      const d = dist(last, p);
      let score = d;
      if (vec && d > 0) {
        const align = ((p.x - last.x) * vec.x + (p.y - last.y) * vec.y) / d;
        score = d * (1 + 0.65 * (1 - align));
      }
      if (useBuffer) {
        const wait = Math.max(0, earliestDay(p.id) - currentDay);
        // Strongly prefer a pile that's ready today over a nearer one that's still curing —
        // matches the empirical Viale pattern (skip immediate neighbors, keep advancing).
        score = score * (1 + 4 * wait);
      }
      if (score < bestScore) { bestScore = score; best = p; }
    }
    place(best);
  }

  // Stash the day assignment on the array itself (non-breaking: arrays are objects)
  // so scheduleAlongPath can reuse it instead of recomputing with a naive scan.
  if (useBuffer) path.dayOf = dayOf;
  return path;
}

function scheduleAlongPath(orderedPiles, { perDay, bufferDays, radius }) {
  const adj = buildConflicts(orderedPiles, radius);
  // If buildPath already computed a buffer-aware day assignment for this exact
  // order, reuse it — recomputing with the naive left-to-right scan could
  // silently disagree with the order the path was built around.
  const dayOf = orderedPiles.dayOf ? new Map(orderedPiles.dayOf) : new Map();
  const perDayCount = new Map();
  if (orderedPiles.dayOf) {
    for (const d of dayOf.values()) perDayCount.set(d, (perDayCount.get(d) || 0) + 1);
  } else {
    for (const pile of orderedPiles) {
      let day = 1;
      while (true) {
        const count = perDayCount.get(day) || 0;
        const ok = adj.get(pile.id).every((nId) => {
          const nDay = dayOf.get(nId);
          return nDay === undefined || Math.abs(nDay - day) >= bufferDays;
        });
        if (count < perDay && ok) {
          dayOf.set(pile.id, day);
          perDayCount.set(day, count + 1);
          break;
        }
        day++;
      }
    }
  }

  const maxDay = Math.max(...[...dayOf.values()]);
  const byDay = [];
  for (let d = 1; d <= maxDay; d++) {
    const ps = orderedPiles.filter((p) => dayOf.get(p.id) === d);
    if (ps.length) byDay.push({ day: d, piles: ps });
  }

  const consecutive = [];
  for (let i = 0; i < orderedPiles.length - 1; i++)
    consecutive.push(dist(orderedPiles[i], orderedPiles[i + 1]));
  const totalDist = consecutive.reduce((a, b) => a + b, 0);
  const avgStep = consecutive.length ? totalDist / consecutive.length : 0;

  return { byDay, dayOf, maxDay, conflicts: adj, avgStep, totalDist, path: orderedPiles };
}

// Calendar: working-day index → real date
function getWorkingDate(startDateStr, wdIndex, skipSat, skipSun) {
  let d = new Date(startDateStr + "T00:00:00");
  let count = 0;
  for (let i = 0; i < 10000; i++) {
    const dow = d.getDay();           // 0=sun, 6=sat
    const skip = (skipSun && dow === 0) || (skipSat && dow === 6);
    if (!skip) { count++; if (count === wdIndex) return new Date(d); }
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function fmtDate(d) {
  return d.toLocaleDateString("es-CO", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric"
  });
}

const PALETTE = [
  "#FF7A3D","#FFC53D","#3ED9C6","#5AA9FF","#D96BFF",
  "#FF5C8A","#9CE85C","#FFA8E8","#6BD1FF","#FFDD57",
];
const colorForDay = (day) => PALETTE[(day - 1) % PALETTE.length];

function demoPiles() {
  const piles = [];
  let n = 1;
  const sp = [4, 7];
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      piles.push({
        id: `P-${String(n).padStart(2,"0")}`,
        name: `P-${String(n).padStart(2,"0")}`,
        x: col * sp[col % 2],
        y: row * sp[row % 2],
      });
      n++;
    }
  return piles;
}

function detectColumns(headerRow) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const headers = headerRow.map(norm);
  const find = (patterns) => headers.findIndex((h) => patterns.some((p) => p.test(h)));
  return {
    nameIdx:     find([/pilote/, /^nombre$/, /^id$/, /^numero$/, /^n[uú]mero$/, /^n°$/]),
    xIdx:        find([/^x$/, /este/, /easting/]),
    yIdx:        find([/^y$/, /norte/, /northing/]),
    edificioIdx: find([/edificio/, /torre/, /bloque/, /grupo/, /zona/, /building/, /block/, /tower/]),
  };
}

function parseManualIds(text, piles) {
  if (!text.trim()) return { ids: [], unknown: [] };
  const byName = new Map(piles.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const tokens = text.split(",").map((t) => t.trim()).filter(Boolean);
  const ids = [], unknown = [];
  for (const t of tokens) {
    const id = byName.get(t.toLowerCase());
    if (id) ids.push(id); else unknown.push(t);
  }
  return { ids, unknown };
}

// ─── SVG map geometry ─────────────────────────────────────────────────────────
// Convex hull (Graham scan) – returns subset of points forming the outer boundary
function convexHull(pts) {
  if (pts.length < 3) return pts;
  const sorted = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (O, A, B) => (A.x-O.x)*(B.y-O.y) - (A.y-O.y)*(B.x-O.x);
  const lower = [], upper = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length-1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

function useMapGeom(piles) {
  return useMemo(() => {
    if (!piles.length) return null;
    const xs = piles.map((p) => p.x), ys = piles.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 720, H = 480, pad = 60;
    const scale = Math.min((W - pad * 2) / Math.max(maxX - minX, 1),
                           (H - pad * 2) / Math.max(maxY - minY, 1));
    const toSvg = (p) => ({
      cx: pad + (p.x - minX) * scale,
      cy: H - (pad + (p.y - minY) * scale),
    });
    const fromSvg = (cx, cy) => ({
      x: (cx - pad) / scale + minX,
      y: (H - cy - pad) / scale + minY,
    });
    return { W, H, pad, scale, toSvg, fromSvg, minX, minY };
  }, [piles]);
}

// Build path guided by a freehand route polyline.
// routePts: array of {x, y} in REAL MODEL COORDS (same as pile.x, pile.y).
// The route encodes the preferred direction of advance from start to end.
// Algorithm:
//   1. Project each pile onto the route polyline → get a "progress" value 0..1
//   2. Start from the pile closest to the route START point
//   3. Nearest-neighbour with a strong penalty for backward movement along the route
//      (keeps the machine advancing forward, avoiding zones with exposed rebar)
function buildPathFromRoute(piles, routePts, bufferOpts) {
  const { perDay, bufferDays, radius } = bufferOpts || {};
  if (!piles.length) return [];
  if (!routePts || routePts.length < 2)
    return buildPath(piles, { startId:"", dirKey:"none", manualIds:[], drawnOrder:[], perDay, bufferDays, radius });

  // Use .x/.y fields (real model coords). Each routePt has {x, y} (and optionally {cx,cy}).
  const rpts = routePts.map(p => ({ x: p.x ?? p.cx, y: p.y ?? p.cy }));

  // Build segment list
  let totalLen = 0;
  const segs = [];
  for (let i = 0; i < rpts.length-1; i++) {
    const dx = rpts[i+1].x - rpts[i].x;
    const dy = rpts[i+1].y - rpts[i].y;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-9) continue;
    segs.push({ x0: rpts[i].x, y0: rpts[i].y, dx, dy, len, start: totalLen });
    totalLen += len;
  }
  if (!segs.length || totalLen < 1e-9)
    return buildPath(piles, { startId:"", dirKey:"none", manualIds:[], drawnOrder:[], perDay, bufferDays, radius });

  // Project a model-space point onto the polyline → returns progress 0..1
  function projectProgress(px, py) {
    let bestT = 0, bestDist = Infinity;
    for (const seg of segs) {
      const t = Math.max(0, Math.min(1,
        ((px - seg.x0)*seg.dx + (py - seg.y0)*seg.dy) / (seg.len * seg.len)));
      const qx = seg.x0 + t*seg.dx, qy = seg.y0 + t*seg.dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d < bestDist) {
        bestDist = d;
        bestT = (seg.start + t * seg.len) / totalLen;
      }
    }
    return bestT;
  }

  // Assign progress to every pile
  const withProgress = piles.map(p => ({ ...p, progress: projectProgress(p.x, p.y) }));

  // Find the pile closest to the route START point (first drawn point)
  const startX = rpts[0].x, startY = rpts[0].y;
  let startPile = withProgress[0], startDist = Infinity;
  for (const p of withProgress) {
    const d = Math.hypot(p.x - startX, p.y - startY);
    if (d < startDist) { startDist = d; startPile = p; }
  }

  // Build path with nearest-neighbour + forward-bias scoring (+ curing-buffer bias)
  const remaining = new Map(withProgress.map(p => [p.id, p]));
  const path = [];

  const useBuffer = radius > 0 && bufferDays > 0 && perDay > 0;
  const adj = useBuffer ? buildConflicts(piles, radius) : null;
  const dayOf = new Map();
  const perDayCount = new Map();
  let currentDay = 1;

  function earliestDay(pileId) {
    let day = 1;
    while (true) {
      const count = perDayCount.get(day) || 0;
      const ok = adj.get(pileId).every((nId) => {
        const nDay = dayOf.get(nId);
        return nDay === undefined || Math.abs(nDay - day) >= bufferDays;
      });
      if (count < perDay && ok) return day;
      day++;
    }
  }
  function place(p) {
    path.push(p);
    remaining.delete(p.id);
    if (useBuffer) {
      const d = earliestDay(p.id);
      dayOf.set(p.id, d);
      perDayCount.set(d, (perDayCount.get(d) || 0) + 1);
      if (d > currentDay) currentDay = d;
    }
  }

  place(startPile);

  while (remaining.size) {
    const last = path[path.length - 1];
    let best = null, bestScore = Infinity;

    for (const p of remaining.values()) {
      const d = Math.hypot(p.x - last.x, p.y - last.y);

      // Penalty for going backward: proportional to how far we'd retreat × route scale
      const retreat = Math.max(0, last.progress - p.progress);
      const backwardPenalty = retreat * totalLen * 4;

      // Small bonus for progress gap proximity (don't skip far-ahead piles)
      const forwardGap = Math.max(0, p.progress - last.progress);
      const skipPenalty = forwardGap * totalLen * 0.15;

      let score = d + backwardPenalty + skipPenalty;
      if (useBuffer) {
        const wait = Math.max(0, earliestDay(p.id) - currentDay);
        score = score * (1 + 4 * wait);
      }
      if (score < bestScore) { bestScore = score; best = p; }
    }
    place(best);
  }
  if (useBuffer) path.dayOf = dayOf;
  return path;
}

// ─── useZoomPan — zoom con rueda + pan con clic derecho/medio ─────────────────
// Usa viewBox dinámico para que los símbolos mantengan tamaño constante en pantalla.
function useZoomPan(W, H) {
  // vx,vy = esquina superior-izq del viewBox en coords modelo
  // vw,vh = ancho/alto del viewBox en coords modelo
  const [vb, setVb] = useState({ vx: 0, vy: 0, vw: W, vh: H });
  const panning = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // scale = cuántos px de pantalla por unidad de modelo (aprox, asumiendo SVG llena el ancho)
  const scale = W / vb.vw;

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    // fracción del SVG donde está el cursor
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top)  / rect.height;
    const factor = e.deltaY < 0 ? 1/1.18 : 1.18;
    setVb(prev => {
      const newVw = Math.min(W * 8, Math.max(W * 0.05, prev.vw * factor));
      const newVh = Math.min(H * 8, Math.max(H * 0.05, prev.vh * factor));
      // zoom toward cursor
      const newVx = prev.vx + (prev.vw - newVw) * fx;
      const newVy = prev.vy + (prev.vh - newVh) * fy;
      return { vx: newVx, vy: newVy, vw: newVw, vh: newVh };
    });
  }, [W, H]);

  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      panning.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!panning.current) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    // delta en coords modelo
    const dx = -(e.clientX - lastPos.current.x) * (vb.vw / rect.width);
    const dy = -(e.clientY - lastPos.current.y) * (vb.vh / rect.height);
    lastPos.current = { x: e.clientX, y: e.clientY };
    setVb(prev => ({ ...prev, vx: prev.vx + dx, vy: prev.vy + dy }));
  }, [vb.vw, vb.vh]);

  const stopPan = useCallback(() => { panning.current = false; }, []);
  const reset   = useCallback(() => setVb({ vx: 0, vy: 0, vw: W, vh: H }), [W, H]);

  const viewBox = `${vb.vx} ${vb.vy} ${vb.vw} ${vb.vh}`;
  const zoomPct = Math.round((W / vb.vw) * 100);

  // Converts a "screen px" size to model units at current zoom
  // so a symbol of `px` screen-pixels stays that size regardless of zoom
  const px = useCallback((screenPx) => screenPx * (vb.vw / W), [vb.vw, W]);

  return { vb, viewBox, scale, px, zoomPct, onWheel, onMouseDown, onMouseMove, stopPan, reset };
}

function ZoomControls({ onReset, zoomPct, style = {} }) {
  return (
    <div style={{ position:"absolute", top:8, right:8, display:"flex", flexDirection:"column", gap:3, zIndex:10, pointerEvents:"none", ...style }}>
      <div style={{ background:"rgba(6,31,48,0.9)", border:"1px solid var(--blue-line)", borderRadius:4, padding:"3px 9px", pointerEvents:"auto" }}>
        <div style={{ fontSize:9, fontFamily:"IBM Plex Mono,monospace", color:"var(--ink-dim)", textAlign:"center", marginBottom:2 }}>{zoomPct}%</div>
        <button onClick={onReset} title="Resetear vista (ver todo)"
          style={{ display:"block", width:"100%", background:"none", border:"none", color:"var(--cyan)", cursor:"pointer", fontSize:11, padding:"1px 0" }}>⌂ reset</button>
      </div>
      <div style={{ background:"rgba(6,31,48,0.8)", borderRadius:3, padding:"3px 7px", fontSize:8, fontFamily:"IBM Plex Mono,monospace", color:"var(--ink-dim)", textAlign:"center", lineHeight:1.5 }}>
        🖱 rueda=zoom<br/>clic der=pan
      </div>
    </div>
  );
}

// ─── ScaleControl — slider tipo Revit para tamaño de símbolos ─────────────────
function ScaleControl({ value, onChange }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(6,31,48,0.85)", border:"1px solid var(--blue-line)", borderRadius:4, padding:"4px 10px" }}>
      <span style={{ fontSize:9, fontFamily:"IBM Plex Mono,monospace", color:"var(--ink-dim)", whiteSpace:"nowrap" }}>Ø símbolo</span>
      <input type="range" min={3} max={20} step={1} value={value} onChange={e=>onChange(Number(e.target.value))}
        style={{ width:80, accentColor:"var(--cyan)" }}/>
      <span style={{ fontSize:9, fontFamily:"IBM Plex Mono,monospace", color:"var(--cyan)", minWidth:18 }}>{value}px</span>
    </div>
  );
}

// ─── SVG Pile Driver Icon ──────────────────────────────────────────────────────
function PileDriverIcon({ cx, cy, color, size = 18, label = "" }) {
  return (
    <g transform={`translate(${cx},${cy})`}>
      <circle r={size * 1.2} fill={color} opacity="0.15" />
      <rect x={-size*.55} y={size*.1} width={size*1.1} height={size*.32} rx="2" fill={color} opacity="0.9" />
      <rect x={-size*.07} y={-size*.88} width={size*.14} height={size} rx="1" fill={color} opacity="0.95" />
      <rect x={-size*.2}  y={-size*.92} width={size*.4} height={size*.2} rx="2" fill={color} />
      <line x1={-size*.05} y1={-size*.7} x2={-size*.32} y2={size*.08} stroke={color} strokeWidth="1" opacity="0.55" />
      <line x1={size*.05}  y1={-size*.7} x2={size*.32}  y2={size*.08} stroke={color} strokeWidth="1" opacity="0.55" />
      <rect x={-size*.62} y={size*.36} width={size*.25} height={size*.16} rx="2" fill={color} opacity="0.7" />
      <rect x={size*.37}  y={size*.36} width={size*.25} height={size*.16} rx="2" fill={color} opacity="0.7" />
      {label && <text x={0} y={size*.8} textAnchor="middle" fontSize="8" fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">{label}</text>}
    </g>
  );
}

// ─── RouteCanvas — dibuja ruta libre de dirección (NO selecciona pilotes) ─────
// routePts = array of {cx,cy} in MODEL space (toSvg coords)
// ─── MachineDrawingCanvas — mismo mecanismo de "tocar pilotes en orden" que
// DrawingCanvas (modo 1 máquina), pero acotado a los pilotes de una máquina.
// Reemplaza al antiguo RouteCanvas (que dibujaba una curva libre y proyectaba
// los pilotes sobre ella con vecino-más-cercano + sesgo hacia adelante — un
// mecanismo distinto al de 1 máquina, y la causa de la inconsistencia reportada).
function MachineDrawingCanvas({ allPiles, mapGeom, machineIdx, machineGroups, drawnOrder, onOrderChange }) {
  const svgRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [stroke, setStroke] = useState([]);
  const [symSize, setSymSize] = useState(7);
  const color = MACHINE_COLORS[machineIdx];
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);
  const myPiles = allPiles.filter(p => machineGroups[machineIdx]?.has(p.id));
  const ordered = drawnOrder || [];

  function svgPoint(e) {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top)  / rect.height;
    return { cx: zoom.vb.vx + fx * zoom.vb.vw, cy: zoom.vb.vy + fy * zoom.vb.vh };
  }

  function startDraw(e) {
    if (e.button === 1 || e.button === 2) { zoom.onMouseDown(e); return; }
    e.preventDefault(); setDrawing(true); const pt = svgPoint(e); if (pt) setStroke([pt]);
  }
  function moveDraw(e) {
    zoom.onMouseMove(e);
    if (!drawing) return; e.preventDefault(); const pt = svgPoint(e); if (!pt) return;
    setStroke((prev) => { const last = prev[prev.length-1]; if (last && Math.hypot(pt.cx-last.cx, pt.cy-last.cy) < zoom.px(3)) return prev; return [...prev, pt]; });
  }
  function endDraw() {
    zoom.stopPan();
    if (!drawing) return; setDrawing(false); if (!stroke.length) return;
    const snapDist = zoom.px(symSize + 5);
    const touched = []; const seenIds = new Set();
    for (const pt of stroke) {
      let bestId = null, bestD = Infinity;
      for (const p of myPiles) {
        const { cx, cy } = mapGeom.toSvg(p);
        const d = Math.hypot(pt.cx - cx, pt.cy - cy);
        if (d < snapDist && d < bestD) { bestD = d; bestId = p.id; }
      }
      if (bestId && !seenIds.has(bestId)) { seenIds.add(bestId); touched.push(bestId); }
    }
    setStroke([]);
    onOrderChange(machineIdx, touched);
  }
  function clearDraw() { setStroke([]); onOrderChange(machineIdx, []); }

  const R  = zoom.px(symSize);
  const fz = zoom.px(Math.max(5, symSize - 1));

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className="field-label flex items-center gap-1" style={{color}}>
          <Pencil size={12}/> Puntero de ruta — {MACHINE_NAMES[machineIdx]} ({myPiles.length} pilotes)
        </span>
        <button onClick={clearDraw} className="btn-ghost text-xs" style={{padding:"4px 10px"}}><Trash2 size={12}/> Limpiar trazo</button>
        <button onClick={zoom.reset} className="btn-ghost text-xs" style={{padding:"4px 10px"}}>⌂ Ver todo</button>
        <ScaleControl value={symSize} onChange={setSymSize}/>
      </div>
      <div style={{ position:"relative" }}>
        <svg ref={svgRef} viewBox={zoom.viewBox} width="100%"
          style={{ background:"var(--blue-deep)", borderRadius:3, cursor:drawing?"crosshair":"grab", touchAction:"none", display:"block" }}
          onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
          onMouseDown={startDraw} onMouseMove={moveDraw} onMouseUp={endDraw} onMouseLeave={endDraw}
          onTouchStart={startDraw} onTouchMove={moveDraw} onTouchEnd={endDraw}>
          <BuildingOutlines piles={allPiles} mapGeom={mapGeom} zoom={zoom}/>
          {/* Other machines' piles — shown dimmed for context, not selectable here */}
          {allPiles.filter(p=>!machineGroups[machineIdx]?.has(p.id)).map(p=>{
            const{cx,cy}=mapGeom.toSvg(p);
            const ownerMi=[0,1,2,3].find(mi=>mi!==machineIdx&&machineGroups[mi]?.has(p.id));
            const oc=ownerMi!==undefined?MACHINE_COLORS[ownerMi]:"#2A4A5A";
            return (<circle key={p.id} cx={cx} cy={cy} r={R} fill={oc} fillOpacity="0.3" stroke={oc} strokeOpacity="0.4" strokeWidth={zoom.px(0.8)}/>);
          })}
          {/* This machine's piles — tap/drag across them in order */}
          {myPiles.map((p) => {
            const { cx, cy } = mapGeom.toSvg(p);
            const idx = ordered.indexOf(p.id); const hit = idx !== -1;
            return (
              <g key={p.id}>
                <circle cx={cx} cy={cy} r={R} fill={hit?color:"#1B3A4A"} stroke={color} strokeWidth={zoom.px(1.5)}/>
                {hit && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">{idx+1}</text>}
                <text x={cx} y={cy-R-zoom.px(2)} textAnchor="middle" fontSize={fz} fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
              </g>
            );
          })}
          {stroke.length > 1 && (
            <polyline points={stroke.map(pt=>`${pt.cx},${pt.cy}`).join(" ")}
              fill="none" stroke={color} strokeWidth={zoom.px(2.5)} strokeOpacity="0.75" strokeLinecap="round" strokeLinejoin="round"/>
          )}
        </svg>
        <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>
      {ordered.length > 0 && <p className="mono text-xs mt-2" style={{color}}>✓ {ordered.length}/{myPiles.length} pilotes trazados — el resto se completa automáticamente.</p>}
      {ordered.length === 0 && <p className="mono text-xs mt-2" style={{color:"var(--ink-dim)"}}>Rueda=zoom · clic der=pan · clic izq+arrastrar=trazar ruta tocando los pilotes de {MACHINE_NAMES[machineIdx]}.</p>}
    </div>
  );
}

// ─── Multi-machine Navisworks simulation ──────────────────────────────────────
function MultiNavisworksPlayer({ machineResults, mapGeom, radius, startDate, skipSat, skipSun, allPiles }) {
  const projectEnd = Math.max(...machineResults.map(r => r.maxDay));
  const [simDay, setSimDay] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [symSize, setSymSize] = useState(6);
  const intervalRef = useRef(null);
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);

  useEffect(() => { setSimDay(1); setPlaying(false); }, [machineResults]);
  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setSimDay(d => { if (d >= projectEnd) { setPlaying(false); return d; } return d + 1; });
      }, 900);
    } else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [playing, projectEnd]);

  const date = getWorkingDate(startDate, simDay, skipSat, skipSun);

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <div className="field-label mb-1">Simulación constructiva · múltiples máquinas</div>
          <div className="mono text-sm font-bold" style={{ color:"var(--orange)" }}>Día {simDay} / {projectEnd} &nbsp;·&nbsp; {fmtDate(date)}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn-ghost" style={{padding:"6px 10px"}} onClick={() => { setPlaying(false); setSimDay(1); }}><SkipBack size={14}/></button>
          <button className="btn-ghost" style={{padding:"6px 10px"}} onClick={() => setSimDay(d => Math.max(1,d-1))}><ChevronLeft size={14}/></button>
          <button className="btn-primary" style={{padding:"7px 16px"}} onClick={() => setPlaying(p => !p)}>{playing ? "⏸ Pausar" : "▶ Play"}</button>
          <button className="btn-ghost" style={{padding:"6px 10px"}} onClick={() => setSimDay(d => Math.min(projectEnd,d+1))}><ChevronRight size={14}/></button>
          <button className="btn-ghost" style={{padding:"6px 10px"}} onClick={() => { setPlaying(false); setSimDay(projectEnd); }}><SkipForward size={14}/></button>
          <ScaleControl value={symSize} onChange={setSymSize}/>
          <button onClick={zoom.reset} className="btn-ghost" style={{padding:"6px 10px"}}>⌂</button>
        </div>
      </div>
      <input type="range" min={1} max={projectEnd} value={simDay} onChange={e => { setPlaying(false); setSimDay(Number(e.target.value)); }} style={{width:"100%",accentColor:"var(--orange)",marginBottom:12}}/>

      <div style={{position:"relative"}}>
        <svg viewBox={zoom.viewBox} width="100%"
          style={{background:"var(--blue-deep)",borderRadius:3,cursor:"grab",display:"block"}}
          onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
          onMouseDown={zoom.onMouseDown} onMouseMove={zoom.onMouseMove}
          onMouseUp={zoom.stopPan} onMouseLeave={zoom.stopPan}>
          {/* Building outlines */}
          {allPiles && <BuildingOutlines piles={allPiles} mapGeom={mapGeom} zoom={zoom}/>}
          {machineResults.map((result) => {
            const mColor = MACHINE_COLORS[result.machineIdx];
            const todaySet = new Set((result.byDay.find(b => b.day === simDay)?.piles || []).map(p => p.id));
            const doneSet  = new Set(result.path.filter(p => (result.dayOf.get(p.id)||0) < simDay).map(p => p.id));
            const R  = zoom.px(symSize);
            const fz = zoom.px(Math.max(5, symSize - 1));
            return (
              <g key={result.machineIdx}>
                {result.path.map(p => {
                  const {cx,cy} = mapGeom.toSvg(p);
                  const isToday = todaySet.has(p.id), isDone = doneSet.has(p.id);
                  const fill = isToday ? mColor : isDone ? "#2A3A42" : "#162A38";
                  return (
                    <g key={p.id}>
                      {isToday && <>
                        <circle cx={cx} cy={cy} r={zoom.px(symSize*2)} fill={mColor} fillOpacity="0.1" stroke={mColor} strokeOpacity="0.4" strokeDasharray={`${zoom.px(4)} ${zoom.px(3)}`} strokeWidth={zoom.px(1)}/>
                        <circle cx={cx} cy={cy} r={zoom.px(symSize*1.8)} fill="none" stroke={mColor} strokeOpacity="0.4" strokeWidth={zoom.px(2.5)}>
                          <animate attributeName="r" values={`${zoom.px(symSize*1.4)};${zoom.px(symSize*2.8)};${zoom.px(symSize*1.4)}`} dur="1.4s" repeatCount="indefinite"/>
                          <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="1.4s" repeatCount="indefinite"/>
                        </circle>
                      </>}
                      <circle cx={cx} cy={cy} r={R} fill={fill} stroke={isToday ? mColor : isDone ? "#1A2A32" : "#1A3040"} strokeWidth={zoom.px(isToday ? 2 : 1)}/>
                      <text x={cx} y={cy - R - zoom.px(2)} textAnchor="middle" fontSize={fz} fill={isDone?"#4A6070":"var(--ink-dim)"} fontFamily="IBM Plex Mono,monospace">{p.name}</text>
                      {isToday && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">HOY</text>}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
        <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>

      <div className="flex flex-wrap gap-4 mt-3 text-xs mono">
        {machineResults.map(r => {
          const finished = r.maxDay < simDay;
          const today = [...r.dayOf.values()].filter(d => d === simDay).length;
          const done  = [...r.dayOf.values()].filter(d => d < simDay).length;
          return <span key={r.machineIdx} style={{color:MACHINE_COLORS[r.machineIdx]}}>● {MACHINE_NAMES[r.machineIdx]}: {finished ? "✓ Liberada día "+r.maxDay : today > 0 ? `${today} pilotes hoy` : `${r.path.length-done} pendientes`}</span>;
        })}
      </div>
    </div>
  );
}

// ─── MeasureTool (herramienta de medición manual) ────────────────────────────
function MeasureTool({ piles, mapGeom }) {
  const svgRef = useRef(null);
  const [points, setPoints] = useState([]);
  const [hover, setHover] = useState(null);
  function svgPt(e) {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { cx: (e.clientX-rect.left)*mapGeom.W/rect.width, cy: (e.clientY-rect.top)*mapGeom.H/rect.height };
  }
  function snapToPile(cx, cy) {
    let best = null, bestD = Infinity;
    for (const p of piles) { const {cx:px,cy:py} = mapGeom.toSvg(p); const d = Math.hypot(cx-px,cy-py); if (d<22&&d<bestD){bestD=d;best=p;} }
    if (best) { const {cx:px,cy:py}=mapGeom.toSvg(best); return {cx:px,cy:py,x:best.x,y:best.y,label:best.name,snapped:true}; }
    const model = mapGeom.fromSvg(cx,cy); return {cx,cy,x:model.x,y:model.y,label:null,snapped:false};
  }
  const handleClick = e => { if (points.length>=2){setPoints([]);return;} const raw=svgPt(e); if(!raw)return; setPoints(prev=>[...prev,snapToPile(raw.cx,raw.cy)]); };
  const handleMove = e => { const raw=svgPt(e); if(!raw)return; setHover(snapToPile(raw.cx,raw.cy)); };
  const measured = points.length===2 ? Math.sqrt((points[1].x-points[0].x)**2+(points[1].y-points[0].y)**2) : null;
  const mid = points.length===2 ? {cx:(points[0].cx+points[1].cx)/2,cy:(points[0].cy+points[1].cy)/2} : null;
  const angle = points.length===2 ? Math.atan2(points[1].cy-points[0].cy,points[1].cx-points[0].cx)*180/Math.PI : 0;
  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className="field-label" style={{color:"var(--cyan)"}}>✦ Medición manual — clic en dos puntos para medir · tercer clic limpia</span>
        {points.length>0 && <button onClick={()=>setPoints([])} className="btn-ghost text-xs" style={{padding:"4px 10px"}}><Trash2 size={12}/> Limpiar</button>}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${mapGeom.W} ${mapGeom.H}`} width="100%"
        style={{background:"var(--blue-deep)",borderRadius:3,cursor:"crosshair"}}
        onClick={handleClick} onMouseMove={handleMove} onMouseLeave={()=>setHover(null)}>
        {piles.map(p => { const {cx,cy}=mapGeom.toSvg(p); const isAnc=points.some(pt=>pt.label===p.name); return (
          <g key={p.id}>
            <circle cx={cx} cy={cy} r={8} fill={isAnc?"var(--cyan)":"var(--blue-panel)"} stroke={isAnc?"var(--cyan)":"#3B8BBA"} strokeWidth="1.5"/>
            <text x={cx} y={cy-12} textAnchor="middle" fontSize="9" fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
          </g>
        ); })}
        {hover && points.length<2 && <circle cx={hover.cx} cy={hover.cy} r={hover.snapped?12:5} fill="none" stroke="var(--cyan)" strokeWidth={hover.snapped?1.5:1} strokeDasharray={hover.snapped?"none":"3 2"} opacity="0.8"/>}
        {points.length===1 && hover && <line x1={points[0].cx} y1={points[0].cy} x2={hover.cx} y2={hover.cy} stroke="var(--cyan)" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.6"/>}
        {points.length===2 && <>
          {points.map((pt,i) => { const perp={dx:Math.sin(angle*Math.PI/180)*8,dy:-Math.cos(angle*Math.PI/180)*8}; return <g key={i}><line x1={pt.cx-perp.dx} y1={pt.cy-perp.dy} x2={pt.cx+perp.dx} y2={pt.cy+perp.dy} stroke="var(--cyan)" strokeWidth="1.5"/><circle cx={pt.cx} cy={pt.cy} r={4} fill="var(--cyan)"/></g>; })}
          <line x1={points[0].cx} y1={points[0].cy} x2={points[1].cx} y2={points[1].cy} stroke="var(--cyan)" strokeWidth="1.5"/>
          <g transform={`translate(${mid.cx},${mid.cy}) rotate(${Math.abs(angle)>90?angle+180:angle})`}>
            <rect x={-38} y={-14} width={76} height={18} rx={3} fill="var(--blue-panel)" stroke="var(--cyan)" strokeWidth="1"/>
            <text x={0} y={0} textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight="700" fill="var(--cyan)" fontFamily="IBM Plex Mono,monospace">{measured?.toFixed(2)} m</text>
          </g>
          {points.map((pt,i) => <text key={i} x={pt.cx+(i===0?-6:6)} y={pt.cy+20} textAnchor={i===0?"end":"start"} fontSize="8" fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{pt.label||`(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`}</text>)}
        </>}
      </svg>
      {measured !== null && (
        <div className="panel p-3 mt-3 flex items-center gap-6 flex-wrap">
          <div><div className="field-label">Distancia</div><div className="mono text-xl font-bold mt-1" style={{color:"var(--cyan)"}}>{measured.toFixed(3)} m</div></div>
          <div><div className="field-label">Punto A</div><div className="mono text-xs mt-1">{points[0].label||`X=${points[0].x.toFixed(2)} Y=${points[0].y.toFixed(2)}`}</div></div>
          <div><div className="field-label">Punto B</div><div className="mono text-xs mt-1">{points[1].label||`X=${points[1].x.toFixed(2)} Y=${points[1].y.toFixed(2)}`}</div></div>
          <div><div className="field-label">ΔX / ΔY</div><div className="mono text-xs mt-1">{Math.abs(points[1].x-points[0].x).toFixed(3)} m / {Math.abs(points[1].y-points[0].y).toFixed(3)} m</div></div>
        </div>
      )}
    </div>
  );
}

// ─── Claude Chat Assistant ─────────────────────────────────────────────────────
function ClaudeChat({ piles, drawnOrders, numMachines, onApplyChanges }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{ role:"assistant", text:"Hola 👷 Puedo ayudarte a:\n• Mover pilotes a otra máquina\n• Cambiar el orden dentro de una máquina\n\nEjemplo: \"Mueve P-03 y P-05 a la Máquina 2\"" }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:"smooth"}); }, [messages]);

  async function send() {
    if (!input.trim() || loading) return;
    const userMsg = input.trim(); setInput(""); setLoading(true);
    setMessages(prev => [...prev, {role:"user",text:userMsg}]);
    const ctx = Array.from({length:numMachines},(_,mi) => ({
      machine: MACHINE_NAMES[mi], index: mi,
      piles: (drawnOrders[mi]||[]).map(id => piles.find(p=>p.id===id)?.name).filter(Boolean)
    }));
    const sys = `Eres un asistente de planificación de piloteado. Estado actual: ${JSON.stringify(ctx)}. Pilotes disponibles: ${piles.map(p=>p.name).join(", ")}.
Responde SOLO con JSON sin markdown: {"message":"descripción breve","changes":[{"type":"reassign","pileNames":["P-01"],"toMachine":1},{"type":"reorder","machineIndex":0,"moveFirst":"P-03","before":"P-01"}]}. Si no puedes: changes:[].`;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:600,system:sys,messages:[{role:"user",content:userMsg}]})});
      const data = await resp.json();
      const raw = data.content?.find(b=>b.type==="text")?.text||"{}";
      let parsed; try { parsed=JSON.parse(raw.replace(/```json|```/g,"").trim()); } catch { parsed={message:"No pude interpretar.",changes:[]}; }
      setMessages(prev=>[...prev,{role:"assistant",text:parsed.message||"Hecho."}]);
      if (parsed.changes?.length) onApplyChanges(parsed.changes);
    } catch { setMessages(prev=>[...prev,{role:"assistant",text:"Error de conexión."}]); }
    setLoading(false);
  }
  if (!open) return (
    <button onClick={()=>setOpen(true)} className="btn-primary" style={{position:"fixed",bottom:24,right:24,borderRadius:999,padding:"12px 20px",zIndex:1000,boxShadow:"0 4px 24px rgba(0,0,0,0.5)"}}>
      <MessageSquare size={17}/> Asistente Claude
    </button>
  );
  return (
    <div style={{position:"fixed",bottom:24,right:24,zIndex:1000,width:360,background:"var(--blue-panel)",border:"1px solid var(--blue-line)",borderRadius:8,boxShadow:"0 8px 32px rgba(0,0,0,0.6)",display:"flex",flexDirection:"column",maxHeight:500}}>
      <div style={{padding:"11px 15px",borderBottom:"1px solid var(--blue-line)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div className="flex items-center gap-2"><Bot size={14} style={{color:"var(--cyan)"}}/><span className="mono text-sm font-bold" style={{color:"var(--cyan)"}}>Asistente de planificación</span></div>
        <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",color:"var(--ink-dim)",cursor:"pointer"}}><X size={14}/></button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"11px 13px",display:"flex",flexDirection:"column",gap:9,minHeight:180}}>
        {messages.map((m,i) => (
          <div key={i} style={{display:"flex",gap:7,alignItems:"flex-start",flexDirection:m.role==="user"?"row-reverse":"row"}}>
            <div style={{width:24,height:24,borderRadius:999,background:m.role==="user"?"var(--orange)":"rgba(127,217,240,0.15)",border:`1px solid ${m.role==="user"?"var(--orange)":"var(--cyan)"}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {m.role==="user"?<User size={12} style={{color:"#061F30"}}/>:<Bot size={12} style={{color:"var(--cyan)"}}/>}
            </div>
            <div style={{background:m.role==="user"?"rgba(255,122,61,0.1)":"rgba(127,217,240,0.06)",border:`1px solid ${m.role==="user"?"rgba(255,122,61,0.25)":"rgba(127,217,240,0.15)"}`,borderRadius:6,padding:"7px 10px",maxWidth:"84%"}}>
              <p className="mono text-xs" style={{color:"var(--ink)",whiteSpace:"pre-wrap",lineHeight:1.5}}>{m.text}</p>
            </div>
          </div>
        ))}
        {loading && <div className="flex items-center gap-2"><Bot size={12} style={{color:"var(--cyan)"}}/><span className="mono text-xs" style={{color:"var(--ink-dim)"}}>Procesando...</span></div>}
        <div ref={bottomRef}/>
      </div>
      <div style={{padding:"9px 11px",borderTop:"1px solid var(--blue-line)",display:"flex",gap:7}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder='Ej: "mueve P-03 a Máquina 2"' style={{flex:1,background:"var(--blue-deep)",border:"1px solid var(--blue-line)",color:"var(--ink)",borderRadius:4,padding:"6px 9px",fontFamily:"IBM Plex Mono,monospace",fontSize:12}}/>
        <button onClick={send} disabled={loading||!input.trim()} className="btn-primary" style={{padding:"6px 11px"}}><Send size={13}/></button>
      </div>
    </div>
  );
}

function DrawingCanvas({ piles, mapGeom, radius, onOrderChange }) {
  const svgRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [stroke, setStroke] = useState([]);
  const [ordered, setOrdered] = useState([]);
  const [symSize, setSymSize] = useState(7);
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);

  function svgPoint(e) {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top)  / rect.height;
    return { cx: zoom.vb.vx + fx * zoom.vb.vw, cy: zoom.vb.vy + fy * zoom.vb.vh };
  }

  function startDraw(e) {
    if (e.button === 1 || e.button === 2) { zoom.onMouseDown(e); return; }
    e.preventDefault(); setDrawing(true); const pt = svgPoint(e); if (pt) setStroke([pt]);
  }
  function moveDraw(e) {
    zoom.onMouseMove(e);
    if (!drawing) return; e.preventDefault(); const pt = svgPoint(e); if (!pt) return;
    setStroke((prev) => { const last = prev[prev.length-1]; if (last && Math.hypot(pt.cx-last.cx, pt.cy-last.cy) < zoom.px(3)) return prev; return [...prev, pt]; });
  }
  function endDraw() {
    zoom.stopPan();
    if (!drawing) return; setDrawing(false); if (!stroke.length) return;
    const snapDist = zoom.px(symSize + 5);
    const touched = []; const seenIds = new Set();
    for (const pt of stroke) {
      let bestId = null, bestD = Infinity;
      for (const p of piles) {
        const { cx, cy } = mapGeom.toSvg(p);
        const d = Math.hypot(pt.cx - cx, pt.cy - cy);
        if (d < snapDist && d < bestD) { bestD = d; bestId = p.id; }
      }
      if (bestId && !seenIds.has(bestId)) { seenIds.add(bestId); touched.push(bestId); }
    }
    setOrdered(touched); onOrderChange(touched);
  }
  function clearDraw() { setStroke([]); setOrdered([]); onOrderChange([]); }

  const R  = zoom.px(symSize);
  const fz = zoom.px(Math.max(6, symSize - 1));

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className="field-label flex items-center gap-1"><Pencil size={12}/> Puntero de ruta</span>
        <button onClick={clearDraw} className="btn-ghost text-xs" style={{padding:"4px 10px"}}><Trash2 size={12}/> Limpiar trazo</button>
        <button onClick={zoom.reset} className="btn-ghost text-xs" style={{padding:"4px 10px"}}>⌂ Ver todo</button>
        <ScaleControl value={symSize} onChange={setSymSize}/>
      </div>
      <div style={{ position:"relative" }}>
        <svg ref={svgRef} viewBox={zoom.viewBox} width="100%"
          style={{ background:"var(--blue-deep)", borderRadius:3, cursor:drawing?"crosshair":"grab", touchAction:"none", display:"block" }}
          onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
          onMouseDown={startDraw} onMouseMove={moveDraw} onMouseUp={endDraw} onMouseLeave={endDraw}
          onTouchStart={startDraw} onTouchMove={moveDraw} onTouchEnd={endDraw}>
          {piles.map((p) => {
            const { cx, cy } = mapGeom.toSvg(p);
            const idx = ordered.indexOf(p.id); const hit = idx !== -1;
            return (
              <g key={p.id}>
                <circle cx={cx} cy={cy} r={R} fill={hit?"#FF7A3D":"#1B3A4A"} stroke={hit?"#FF7A3D":"#3B8BBA"} strokeWidth={zoom.px(1.5)}/>
                {hit && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">{idx+1}</text>}
                <text x={cx} y={cy-R-zoom.px(2)} textAnchor="middle" fontSize={fz} fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
              </g>
            );
          })}
          {stroke.length > 1 && (
            <polyline points={stroke.map(pt=>`${pt.cx},${pt.cy}`).join(" ")}
              fill="none" stroke="var(--orange)" strokeWidth={zoom.px(2.5)} strokeOpacity="0.75" strokeLinecap="round" strokeLinejoin="round"/>
          )}
        </svg>
        <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>
      {ordered.length > 0 && <p className="mono text-xs mt-2" style={{color:"var(--cyan)"}}>✓ {ordered.length} pilotes trazados — el resto se completa automáticamente.</p>}
      {ordered.length === 0 && <p className="mono text-xs mt-2" style={{color:"var(--ink-dim)"}}>Rueda=zoom · clic der=pan · clic izq+arrastrar=trazar ruta.</p>}
    </div>
  );
}

// ─── Navisworks-style simulation ──────────────────────────────────────────────

function NavisworksPlayer({ result, mapGeom, radius, startDate, skipSat, skipSun, allPiles }) {
  const [simDay, setSimDay] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [symSize, setSymSize] = useState(7);
  const intervalRef = useRef(null);
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);

  useEffect(() => { setSimDay(1); setPlaying(false); }, [result]);

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setSimDay((d) => {
          if (d >= result.maxDay) { setPlaying(false); return d; }
          return d + 1;
        });
      }, 900);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [playing, result.maxDay]);

  const piles = result.path;
  const date = getWorkingDate(startDate, simDay, skipSat, skipSun);
  const todayPiles = new Set((result.byDay.find((b) => b.day === simDay)?.piles || []).map((p) => p.id));
  const donePiles  = new Set(piles.filter((p) => (result.dayOf.get(p.id) || 0) < simDay).map((p) => p.id));
  const machinePos = useMemo(() => {
    const soFar = piles.filter(p => (result.dayOf.get(p.id)||0) <= simDay);
    return soFar.length ? soFar[soFar.length-1] : null;
  }, [simDay, piles, result]);

  return (
    <div className="panel p-4">
      {/* header */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <div className="field-label mb-1">Simulación constructiva · estilo Navisworks</div>
          <div className="mono text-sm font-bold" style={{ color: "var(--orange)" }}>
            Día {simDay} / {result.maxDay} &nbsp;·&nbsp; {fmtDate(date)}
          </div>
        </div>
        {/* playback controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => { setPlaying(false); setSimDay(1); }}><SkipBack size={14} /></button>
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => setSimDay((d) => Math.max(1, d - 1))}><ChevronLeft size={14} /></button>
          <button className="btn-primary" style={{ padding: "7px 16px" }} onClick={() => setPlaying((p) => !p)}>
            {playing ? "⏸ Pausar" : "▶ Play"}
          </button>
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => setSimDay((d) => Math.min(result.maxDay, d + 1))}><ChevronRight size={14} /></button>
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => { setPlaying(false); setSimDay(result.maxDay); }}><SkipForward size={14} /></button>
          <ScaleControl value={symSize} onChange={setSymSize}/>
          <button onClick={zoom.reset} className="btn-ghost" style={{padding:"6px 10px"}}>⌂</button>
        </div>
      </div>

      {/* timeline scrubber */}
      <input
        type="range" min={1} max={result.maxDay} value={simDay}
        onChange={(e) => { setPlaying(false); setSimDay(Number(e.target.value)); }}
        style={{ width: "100%", accentColor: "var(--orange)", marginBottom: 12 }}
      />

      <div style={{ position:"relative" }}>
      <svg viewBox={zoom.viewBox} width="100%"
        style={{ background: "var(--blue-deep)", borderRadius: 3, cursor:"grab", display:"block" }}
        onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
        onMouseDown={zoom.onMouseDown} onMouseMove={zoom.onMouseMove}
        onMouseUp={zoom.stopPan} onMouseLeave={zoom.stopPan}>
        {allPiles && <BuildingOutlines piles={allPiles} mapGeom={mapGeom} zoom={zoom}/>}
        {piles.map((p) => {
          const { cx, cy } = mapGeom.toSvg(p);
          const isToday = todayPiles.has(p.id);
          const isDone  = donePiles.has(p.id);
          const R  = zoom.px(symSize);
          const fz = zoom.px(Math.max(5, symSize - 1));

          const fill   = isToday ? colorForDay(simDay) : isDone ? "#3A4A52" : "#1B3A4A";
          const stroke = isToday ? colorForDay(simDay) : isDone ? "#2A3A42" : "#2A4A5A";
          const textC  = isToday ? "#061F30" : isDone ? "#607080" : "#4A7090";

          return (
            <g key={p.id}>
              {isToday && (
                <>
                  <circle cx={cx} cy={cy} r={zoom.px(symSize*2)} fill={colorForDay(simDay)} fillOpacity="0.12" stroke={colorForDay(simDay)} strokeOpacity="0.5" strokeDasharray={`${zoom.px(4)} ${zoom.px(3)}`} strokeWidth={zoom.px(1)} />
                  <circle cx={cx} cy={cy} r={zoom.px(symSize*1.8)} fill="none" stroke={colorForDay(simDay)} strokeOpacity="0.4" strokeWidth={zoom.px(3)}>
                    <animate attributeName="r" values={`${zoom.px(symSize*1.4)};${zoom.px(symSize*2.8)};${zoom.px(symSize*1.4)}`} dur="1.4s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="1.4s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
              <circle cx={cx} cy={cy} r={R} fill={fill} stroke={stroke} strokeWidth={zoom.px(isToday ? 2 : 1)} />
              <text x={cx} y={cy - R - zoom.px(2)} textAnchor="middle" fontSize={fz} fill={textC} fontFamily="IBM Plex Mono, monospace">{p.name}</text>
              <text x={cx} y={cy + R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill={isToday ? "#061F30" : textC} fontFamily="IBM Plex Mono, monospace">{isDone ? "✓" : isToday ? "HOY" : ""}</text>
            </g>
          );
        })}
      </svg>
      <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>
      <div className="flex flex-wrap gap-4 mt-3 items-start">
        <div className="flex items-center gap-4 text-xs mono flex-wrap" style={{ color: "var(--ink-dim)" }}>
          <span><span style={{ color: colorForDay(simDay) }}>●</span> Fundiendo hoy ({todayPiles.size})</span>
          <span><span style={{ color: "#3A4A52" }}>●</span> Ya fundidos ({donePiles.size})</span>
          <span><span style={{ color: "#1B3A4A" }}>●</span> Pendientes ({piles.length - todayPiles.size - donePiles.size})</span>
        </div>
        {todayPiles.size > 0 && (
          <div className="mono text-xs ml-auto" style={{ color: "var(--cyan)" }}>
            Hoy: {[...todayPiles].join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MachineAssignRow — assigns piles by name prefix to a machine ─────────────
function MachineAssignRow({ mi, piles, machineGroups, onAssign, onClear }) {
  const [prefix, setPrefix] = useState("");
  const color = MACHINE_COLORS[mi];
  const count = machineGroups[mi]?.size || 0;
  // auto-suggest prefixes from pile names
  const prefixSuggestions = useMemo(() => {
    const seen = new Map();
    for (const p of piles) {
      const parts = p.name.match(/^([A-Za-z]+)/);
      if (parts) { const k = parts[1]; seen.set(k, (seen.get(k)||0)+1); }
    }
    return [...seen.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k])=>k);
  }, [piles]);

  return (
    <div style={{ marginBottom:8, padding:"8px 10px", background:"rgba(6,31,48,0.5)", border:`1px solid ${color}30`, borderRadius:4 }}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="mono text-xs font-bold" style={{color, minWidth:70}}>● M{mi+1}</span>
        <span className="mono text-xs" style={{color:"var(--ink-dim)"}}>{count} pilotes asignados</span>
        {count>0&&<button onClick={()=>onClear(mi)} className="btn-ghost" style={{padding:"2px 7px",fontSize:10,border:`1px solid ${color}50`,color:"var(--ink-dim)"}}>✕ limpiar</button>}
      </div>
      <div className="flex gap-2 flex-wrap mb-1">
        {prefixSuggestions.map(s=>(
          <button key={s} onClick={()=>{setPrefix(s);}} className="btn-ghost"
            style={{padding:"2px 7px",fontSize:10,borderColor:prefix===s?color:"var(--blue-line)",color:prefix===s?color:"var(--ink-dim)"}}>
            {s}…
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="text" value={prefix} onChange={e=>setPrefix(e.target.value)}
          placeholder="Prefijo (ej: CM, T1, PT1)" onKeyDown={e=>{if(e.key==="Enter")onAssign(prefix,mi);}}
          style={{flex:1,fontSize:11,padding:"5px 8px"}}/>
        <button onClick={()=>onAssign(prefix,mi)} className="btn-ghost"
          style={{padding:"5px 10px",fontSize:11,borderColor:color,color}}>→ M{mi+1}</button>
      </div>
      <p className="mono text-xs mt-1" style={{color:"var(--ink-dim)"}}>
        {count>0&&`Incluye: ${[...machineGroups[mi]].slice(0,5).map(id=>piles.find(p=>p.id===id)?.name).filter(Boolean).join(", ")}${count>5?` +${count-5} más`:""}`}
      </p>
    </div>
  );
}

// ─── BuildingOutlines — draws convex hull per building on SVG ─────────────────
function BuildingOutlines({ piles, mapGeom, zoom }) {
  // Group piles by edificio (from column) or by prefix if no edificio
  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const p of piles) {
      // Use edificio field if present, else extract prefix from name
      const key = p.edificio || (p.name.match(/^([A-Za-z0-9_\-]+?)\s*[Pp]/)?.[1] ?? p.name.match(/^([A-Za-z]+)/)?.[1] ?? "");
      if (!key) continue;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(p);
    }
    return byGroup;
  }, [piles]);

  const BCOLORS = ["#7FD9F0","#FFC53D","#D96BFF","#FF5C8A","#9CE85C","#6BD1FF","#FFA8E8"];
  const groupKeys = [...groups.keys()];

  return (
    <>
      {groupKeys.map((key, ki) => {
        const grp = groups.get(key);
        if (grp.length < 2) return null;
        const hull = convexHull(grp.map(p => mapGeom.toSvg(p)).map(({cx,cy})=>({x:cx,y:cy})));
        if (hull.length < 2) return null;
        const color = BCOLORS[ki % BCOLORS.length];
        const pts = hull.map(h=>`${h.x},${h.y}`).join(" ");
        // centroid for label
        const cx = hull.reduce((s,h)=>s+h.x,0)/hull.length;
        const cy = hull.reduce((s,h)=>s+h.y,0)/hull.length;
        return (
          <g key={key}>
            <polygon points={pts} fill={color} fillOpacity="0.06" stroke={color} strokeOpacity="0.5"
              strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(5)} ${zoom.px(3)}`}/>
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
              fontSize={zoom.px(11)} fontWeight="700" fill={color} fillOpacity="0.8"
              fontFamily="IBM Plex Sans,sans-serif">{key}</text>
          </g>
        );
      })}
    </>
  );
}

// ─── GanttChart — diagrama de Gantt por máquina con fechas ──────────────────
function GanttChart({ machines, startDate, skipSat, skipSun, projectEnd }) {
  const BAR_H = 32, LABEL_W = 90, DAY_W = 28, HEADER_H = 52, PAD = 12;
  const totalDays = projectEnd;
  const svgW = LABEL_W + totalDays * DAY_W + PAD * 2;
  const svgH = HEADER_H + machines.length * (BAR_H + 8) + PAD;

  // Generate week markers
  const weekMarkers = [];
  for (let d = 1; d <= totalDays; d++) {
    const date = getWorkingDate(startDate, d, skipSat, skipSun);
    if (date.getDay() === 1 || d === 1) weekMarkers.push({ d, date });
  }

  return (
    <div style={{overflowX:"auto", marginTop:8}}>
      <svg width={svgW} height={svgH} style={{display:"block",fontFamily:"IBM Plex Mono,monospace"}}>
        {/* Background */}
        <rect width={svgW} height={svgH} fill="var(--blue-deep)" rx="4"/>

        {/* Day columns background alternating */}
        {Array.from({length:totalDays},(_,i)=>(
          <rect key={i} x={LABEL_W + i*DAY_W} y={0} width={DAY_W} height={svgH}
            fill={i%2===0?"rgba(255,255,255,0.02)":"transparent"}/>
        ))}

        {/* Week/date header */}
        {weekMarkers.map(({d,date}) => {
          const x = LABEL_W + (d-1)*DAY_W;
          const label = date.toLocaleDateString("es-CO",{day:"2-digit",month:"short"});
          return (
            <g key={d}>
              <line x1={x} y1={HEADER_H-4} x2={x} y2={svgH} stroke="var(--blue-line)" strokeWidth="0.5" strokeDasharray="3 3"/>
              <text x={x+2} y={HEADER_H-20} fontSize="8" fill="var(--ink-dim)" dominantBaseline="middle"
                transform={`rotate(-45,${x+2},${HEADER_H-20})`}>{label}</text>
              <text x={x+2} y={HEADER_H-8} fontSize="7" fill="#4A6A7A">Día {d}</text>
            </g>
          );
        })}

        {/* Today line if within range */}
        <line x1={LABEL_W} y1={HEADER_H-4} x2={LABEL_W + totalDays*DAY_W} y2={HEADER_H-4}
          stroke="var(--blue-line)" strokeWidth="1"/>

        {/* Machine rows */}
        {machines.map((m, rowIdx) => {
          const y = HEADER_H + rowIdx * (BAR_H + 8);
          const col = MACHINE_COLORS[m.machineIdx];
          const maxDay = m.maxDay;

          return (
            <g key={m.machineIdx}>
              {/* Row label */}
              <text x={LABEL_W - 6} y={y + BAR_H/2} textAnchor="end" dominantBaseline="middle"
                fontSize="10" fontWeight="700" fill={col}>M{m.machineIdx+1}</text>
              <text x={LABEL_W - 6} y={y + BAR_H/2 + 10} textAnchor="end" dominantBaseline="middle"
                fontSize="8" fill="var(--ink-dim)">{m.path.length}p</text>

              {/* Full duration bar background */}
              <rect x={LABEL_W} y={y+4} width={maxDay*DAY_W} height={BAR_H-8}
                fill={col} fillOpacity="0.12" rx="3" stroke={col} strokeOpacity="0.3" strokeWidth="1"/>

              {/* Per-day blocks colored by density */}
              {m.byDay.map(({day, piles:ps}) => {
                const x = LABEL_W + (day-1)*DAY_W;
                const density = ps.length;
                return (
                  <g key={day}>
                    <rect x={x+1} y={y+5} width={DAY_W-2} height={BAR_H-10}
                      fill={col} fillOpacity={0.3 + density*0.15} rx="2"/>
                    {DAY_W >= 22 && <text x={x+DAY_W/2} y={y+BAR_H/2} textAnchor="middle"
                      dominantBaseline="middle" fontSize="8" fill={col} fontWeight="700">{ps.length}</text>}
                  </g>
                );
              })}

              {/* Start and end date labels */}
              {(() => {
                const startD = getWorkingDate(startDate, 1, skipSat, skipSun);
                const endD   = getWorkingDate(startDate, maxDay, skipSat, skipSun);
                const fmtShort = d => d.toLocaleDateString("es-CO",{day:"2-digit",month:"short"});
                return <>
                  <text x={LABEL_W + 3} y={y + BAR_H - 6} fontSize="7" fill={col} fillOpacity="0.9">
                    {fmtShort(startD)}
                  </text>
                  <text x={LABEL_W + maxDay*DAY_W - 3} y={y + BAR_H - 6} textAnchor="end"
                    fontSize="7" fill={col} fillOpacity="0.9">
                    {fmtShort(endD)}
                  </text>
                </>;
              })()}

              {/* Liberation marker if finishes early */}
              {maxDay < totalDays && (
                <g>
                  <line x1={LABEL_W+maxDay*DAY_W} y1={y+2} x2={LABEL_W+maxDay*DAY_W} y2={y+BAR_H+2}
                    stroke={col} strokeWidth="2" strokeDasharray="4 2"/>
                  <text x={LABEL_W+maxDay*DAY_W+3} y={y+BAR_H/2} dominantBaseline="middle"
                    fontSize="8" fill={col} opacity="0.8">✓ libre</text>
                </g>
              )}
            </g>
          );
        })}

        {/* Legend */}
        <text x={LABEL_W} y={svgH-4} fontSize="8" fill="var(--ink-dim)">
          Número en bloque = pilotes fundidos ese día · simultaniedad = barras solapadas en tiempo
        </text>
      </svg>
    </div>
  );
}

// ─── Plan view components with zoom/pan ───────────────────────────────────────
function PlanViewSingle({ result, piles, mapGeom, radius, adjustedResult, postponed }) {
  const svgRef = useRef(null);
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);
  const [symSize, setSymSize] = useState(7);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState([]);
  const [hover, setHover] = useState(null);

  // Use adjusted result if imprevistos exist, otherwise original
  const displayResult = (adjustedResult && postponed && postponed.size > 0) ? adjustedResult : result;

  function svgCoord(e) {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { cx: zoom.vb.vx + ((e.clientX-rect.left)/rect.width)*zoom.vb.vw,
              cy: zoom.vb.vy + ((e.clientY-rect.top)/rect.height)*zoom.vb.vh };
  }
  function snapPile(cx, cy) {
    let best=null, bestD=Infinity;
    for (const p of piles) { const s=mapGeom.toSvg(p); const d=Math.hypot(cx-s.cx,cy-s.cy); if(d<zoom.px(20)&&d<bestD){bestD=d;best=p;} }
    if (best) { const s=mapGeom.toSvg(best); return {cx:s.cx,cy:s.cy,x:best.x,y:best.y,label:best.name}; }
    const m=mapGeom.fromSvg(cx,cy); return {cx,cy,x:m.x,y:m.y,label:null};
  }
  function handleSvgClick(e) {
    if (!measureMode) return;
    if (measurePts.length >= 2) { setMeasurePts([]); return; }
    const raw=svgCoord(e); if (!raw) return;
    setMeasurePts(prev => [...prev, snapPile(raw.cx,raw.cy)]);
  }
  function handleSvgMove(e) {
    if (!measureMode) { zoom.onMouseMove(e); return; }
    const raw=svgCoord(e); if (!raw) return;
    setHover(snapPile(raw.cx,raw.cy));
  }
  const measured = measurePts.length===2 ? Math.hypot(measurePts[1].x-measurePts[0].x, measurePts[1].y-measurePts[0].y) : null;

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="field-label">Color = día · línea punteada = ruta · círculo punteado = radio de exclusión</div>
        <button onClick={zoom.reset} className="btn-ghost text-xs" style={{padding:"3px 8px"}}>⌂ Ver todo</button>
        <ScaleControl value={symSize} onChange={setSymSize}/>
        <button onClick={()=>{setMeasureMode(m=>!m);setMeasurePts([]);setHover(null);}}
          className="btn-ghost text-xs"
          style={{padding:"3px 10px", borderColor:measureMode?"var(--cyan)":"var(--blue-line)", color:measureMode?"var(--cyan)":"var(--ink)"}}>
          ✦ {measureMode ? "Salir medición" : "Medir distancia"}
        </button>
        {postponed && postponed.size > 0 && (
          <span className="mono text-xs" style={{color:"var(--orange)"}}>⚠ {postponed.size} imprevisto(s) — mostrando secuencia ajustada</span>
        )}
      </div>
      <div style={{ position:"relative" }}>
        <svg ref={svgRef} viewBox={zoom.viewBox} width="100%"
          style={{ background:"var(--blue-deep)", borderRadius:3, cursor:measureMode?"crosshair":"grab", display:"block" }}
          onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
          onMouseDown={e=>{ if(!measureMode) zoom.onMouseDown(e); }}
          onMouseMove={handleSvgMove}
          onMouseUp={e=>{ if(!measureMode) zoom.stopPan(); }}
          onMouseLeave={e=>{ zoom.stopPan(); setHover(null); }}
          onClick={handleSvgClick}>
          <BuildingOutlines piles={piles} mapGeom={mapGeom} zoom={zoom}/>
          {radius > 0 && piles.map(p => {
            const{cx,cy}=mapGeom.toSvg(p);
            return (
              <circle key={`rad-${p.id}`} cx={cx} cy={cy} r={radius*mapGeom.scale}
                fill="none" stroke="var(--orange)" strokeOpacity="0.35"
                strokeWidth={zoom.px(1)} strokeDasharray={`${zoom.px(3)} ${zoom.px(3)}`}/>
            );
          })}
          <polyline
            points={displayResult.path.map(p=>{ const{cx,cy}=mapGeom.toSvg(p); return`${cx},${cy}`; }).join(" ")}
            fill="none" stroke="var(--cyan)" strokeOpacity="0.35" strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(4)} ${zoom.px(6)}`}/>
          {piles.map(p => {
            const{cx,cy}=mapGeom.toSvg(p);
            const day = displayResult.dayOf.get(p.id);
            const isPostponed = postponed && postponed.has(p.id) && !postponed.get(p.id)?.rescheduleDate;
            const isRescheduled = postponed && postponed.has(p.id) && postponed.get(p.id)?.rescheduleDate;
            const R=zoom.px(symSize); const fz=zoom.px(Math.max(6,symSize-1));
            const fillColor = isPostponed ? "#FF7A3D" : isRescheduled ? "var(--cyan)" : colorForDay(day);
            return (
              <g key={p.id}>
                {isPostponed && <circle cx={cx} cy={cy} r={R*1.6} fill="none" stroke="var(--orange)" strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(3)} ${zoom.px(2)}`} strokeOpacity="0.7"/>}
                <circle cx={cx} cy={cy} r={R} fill={fillColor} stroke="#061F30" strokeWidth={zoom.px(1.5)} fillOpacity={isPostponed?0.4:1}/>
                <text x={cx} y={cy-R-zoom.px(2)} textAnchor="middle" fontSize={fz} fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
                <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">
                  {isPostponed ? "⚠" : day}
                </text>
              </g>
            );
          })}
          {/* Measurement overlay */}
          {measureMode && hover && measurePts.length < 2 && (
            <circle cx={hover.cx} cy={hover.cy} r={zoom.px(10)} fill="none" stroke="var(--cyan)" strokeWidth={zoom.px(1.5)} strokeOpacity="0.8"/>
          )}
          {measureMode && measurePts.length === 1 && hover && (
            <line x1={measurePts[0].cx} y1={measurePts[0].cy} x2={hover.cx} y2={hover.cy}
              stroke="var(--cyan)" strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(5)} ${zoom.px(3)}`} opacity="0.7"/>
          )}
          {measureMode && measurePts.map((pt,i) => (
            <circle key={i} cx={pt.cx} cy={pt.cy} r={zoom.px(5)} fill="var(--cyan)" stroke="#061F30" strokeWidth={zoom.px(1)}/>
          ))}
          {measureMode && measured !== null && (() => {
            const mx=(measurePts[0].cx+measurePts[1].cx)/2, my=(measurePts[0].cy+measurePts[1].cy)/2;
            const ang=Math.atan2(measurePts[1].cy-measurePts[0].cy,measurePts[1].cx-measurePts[0].cx)*180/Math.PI;
            return (
              <g transform={`translate(${mx},${my}) rotate(${Math.abs(ang)>90?ang+180:ang})`}>
                <rect x={-zoom.px(34)} y={-zoom.px(10)} width={zoom.px(68)} height={zoom.px(18)} rx={zoom.px(3)} fill="var(--blue-panel)" stroke="var(--cyan)" strokeWidth={zoom.px(0.8)}/>
                <text textAnchor="middle" dominantBaseline="central" fontSize={zoom.px(9)} fontWeight="700" fill="var(--cyan)" fontFamily="IBM Plex Mono,monospace">{measured.toFixed(2)} m</text>
              </g>
            );
          })()}
        </svg>
        <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>
      {measureMode && measured !== null && (
        <div className="flex items-center gap-6 mt-2 flex-wrap">
          <span className="mono text-sm font-bold" style={{color:"var(--cyan)"}}>✦ {measured.toFixed(3)} m</span>
          <span className="mono text-xs" style={{color:"var(--ink-dim)"}}>{measurePts[0].label||`(${measurePts[0].x.toFixed(1)},${measurePts[0].y.toFixed(1)})`} → {measurePts[1].label||`(${measurePts[1].x.toFixed(1)},${measurePts[1].y.toFixed(1)})`}</span>
          <button onClick={()=>setMeasurePts([])} className="btn-ghost" style={{padding:"2px 8px",fontSize:10}}>Limpiar</button>
        </div>
      )}
      {!measureMode && <p className="mono text-xs mt-2" style={{color:"var(--ink-dim)"}}>Número = día asignado · rueda=zoom · clic der=pan</p>}
    </div>
  );
}

function PlanViewMulti({ machines, piles, mapGeom, radius, postponed }) {
  const svgRef = useRef(null);
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);
  const [symSize, setSymSize] = useState(7);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState([]);
  const [hover, setHover] = useState(null);

  function svgCoord(e) {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { cx: zoom.vb.vx + ((e.clientX-rect.left)/rect.width)*zoom.vb.vw,
              cy: zoom.vb.vy + ((e.clientY-rect.top)/rect.height)*zoom.vb.vh };
  }
  function snapPile(cx, cy) {
    let best=null, bestD=Infinity;
    for (const p of piles) { const s=mapGeom.toSvg(p); const d=Math.hypot(cx-s.cx,cy-s.cy); if(d<zoom.px(20)&&d<bestD){bestD=d;best=p;} }
    if (best) { const s=mapGeom.toSvg(best); return {cx:s.cx,cy:s.cy,x:best.x,y:best.y,label:best.name}; }
    const m=mapGeom.fromSvg(cx,cy); return {cx,cy,x:m.x,y:m.y,label:null};
  }
  function handleSvgClick(e) {
    if (!measureMode) return;
    if (measurePts.length >= 2) { setMeasurePts([]); return; }
    const raw=svgCoord(e); if (!raw) return;
    setMeasurePts(prev => [...prev, snapPile(raw.cx,raw.cy)]);
  }
  function handleSvgMove(e) {
    if (!measureMode) { zoom.onMouseMove(e); return; }
    const raw=svgCoord(e); if (!raw) return;
    setHover(snapPile(raw.cx,raw.cy));
  }
  const measured = measurePts.length===2 ? Math.hypot(measurePts[1].x-measurePts[0].x, measurePts[1].y-measurePts[0].y) : null;

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="field-label">Color = máquina · número = día de fundida · círculo punteado = radio de exclusión</div>
        <button onClick={zoom.reset} className="btn-ghost text-xs" style={{padding:"3px 8px"}}>⌂ Ver todo</button>
        <ScaleControl value={symSize} onChange={setSymSize}/>
        <button onClick={()=>{setMeasureMode(m=>!m);setMeasurePts([]);setHover(null);}}
          className="btn-ghost text-xs"
          style={{padding:"3px 10px", borderColor:measureMode?"var(--cyan)":"var(--blue-line)", color:measureMode?"var(--cyan)":"var(--ink)"}}>
          ✦ {measureMode ? "Salir medición" : "Medir distancia"}
        </button>
        {postponed && postponed.size > 0 && (
          <span className="mono text-xs" style={{color:"var(--orange)"}}>⚠ {postponed.size} imprevisto(s) activos</span>
        )}
      </div>
      <div style={{ position:"relative" }}>
        <svg ref={svgRef} viewBox={zoom.viewBox} width="100%"
          style={{ background:"var(--blue-deep)", borderRadius:3, cursor:measureMode?"crosshair":"grab", display:"block" }}
          onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
          onMouseDown={e=>{ if(!measureMode) zoom.onMouseDown(e); }}
          onMouseMove={handleSvgMove}
          onMouseUp={e=>{ if(!measureMode) zoom.stopPan(); }}
          onMouseLeave={e=>{ zoom.stopPan(); setHover(null); }}
          onClick={handleSvgClick}>
          <BuildingOutlines piles={piles} mapGeom={mapGeom} zoom={zoom}/>
          {radius > 0 && piles.map(p => {
            const{cx,cy}=mapGeom.toSvg(p);
            return (
              <circle key={`rad-${p.id}`} cx={cx} cy={cy} r={radius*mapGeom.scale}
                fill="none" stroke="var(--orange)" strokeOpacity="0.35"
                strokeWidth={zoom.px(1)} strokeDasharray={`${zoom.px(3)} ${zoom.px(3)}`}/>
            );
          })}
          {machines.map(m => (
            <polyline key={m.machineIdx} points={m.path.map(p=>{const{cx,cy}=mapGeom.toSvg(p);return`${cx},${cy}`;}).join(" ")}
              fill="none" stroke={MACHINE_COLORS[m.machineIdx]} strokeOpacity="0.3" strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(4)} ${zoom.px(6)}`}/>
          ))}
          {machines.map(m => m.path.map(p => {
            const{cx,cy}=mapGeom.toSvg(p); const day=m.dayOf.get(p.id); const col=MACHINE_COLORS[m.machineIdx];
            const isPostponed = postponed && postponed.has(p.id) && !postponed.get(p.id)?.rescheduleDate;
            const isRescheduled = postponed && postponed.has(p.id) && postponed.get(p.id)?.rescheduleDate;
            const R=zoom.px(symSize); const fz=zoom.px(Math.max(6,symSize-1));
            return (<g key={p.id}>
              {isPostponed && <circle cx={cx} cy={cy} r={R*1.6} fill="none" stroke="var(--orange)" strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(3)} ${zoom.px(2)}`} strokeOpacity="0.8"/>}
              <circle cx={cx} cy={cy} r={R} fill={isRescheduled?"var(--cyan)":col} stroke="#061F30" strokeWidth={zoom.px(1.5)} fillOpacity={isPostponed?0.35:1}/>
              <text x={cx} y={cy-R-zoom.px(2)} textAnchor="middle" fontSize={fz} fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
              {!isPostponed && day && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">{day}</text>}
              {isPostponed && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">⚠</text>}
            </g>);
          }))}
          {machines.map(m => { const first=m.path[0]; if(!first)return null; const{cx,cy}=mapGeom.toSvg(first); const col=MACHINE_COLORS[m.machineIdx]; const R=zoom.px(symSize+2); return <g key={m.machineIdx}><circle cx={cx} cy={cy} r={R} fill="none" stroke={col} strokeWidth={zoom.px(2.5)}/><text x={cx} y={cy+zoom.px(4)} textAnchor="middle" fontSize={zoom.px(symSize)} fontWeight="700" fill={col} fontFamily="IBM Plex Mono,monospace">M{m.machineIdx+1}</text></g>; })}
          {/* Measurement overlay */}
          {measureMode && hover && measurePts.length < 2 && (
            <circle cx={hover.cx} cy={hover.cy} r={zoom.px(10)} fill="none" stroke="var(--cyan)" strokeWidth={zoom.px(1.5)} strokeOpacity="0.8"/>
          )}
          {measureMode && measurePts.length === 1 && hover && (
            <line x1={measurePts[0].cx} y1={measurePts[0].cy} x2={hover.cx} y2={hover.cy}
              stroke="var(--cyan)" strokeWidth={zoom.px(1.5)} strokeDasharray={`${zoom.px(5)} ${zoom.px(3)}`} opacity="0.7"/>
          )}
          {measureMode && measurePts.map((pt,i) => (
            <circle key={i} cx={pt.cx} cy={pt.cy} r={zoom.px(5)} fill="var(--cyan)" stroke="#061F30" strokeWidth={zoom.px(1)}/>
          ))}
          {measureMode && measured !== null && (() => {
            const mx=(measurePts[0].cx+measurePts[1].cx)/2, my=(measurePts[0].cy+measurePts[1].cy)/2;
            const ang=Math.atan2(measurePts[1].cy-measurePts[0].cy,measurePts[1].cx-measurePts[0].cx)*180/Math.PI;
            return (
              <g transform={`translate(${mx},${my}) rotate(${Math.abs(ang)>90?ang+180:ang})`}>
                <rect x={-zoom.px(34)} y={-zoom.px(10)} width={zoom.px(68)} height={zoom.px(18)} rx={zoom.px(3)} fill="var(--blue-panel)" stroke="var(--cyan)" strokeWidth={zoom.px(0.8)}/>
                <text textAnchor="middle" dominantBaseline="central" fontSize={zoom.px(9)} fontWeight="700" fill="var(--cyan)" fontFamily="IBM Plex Mono,monospace">{measured.toFixed(2)} m</text>
              </g>
            );
          })()}
        </svg>
        <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>
      {measureMode && measured !== null && (
        <div className="flex items-center gap-6 mt-2 flex-wrap">
          <span className="mono text-sm font-bold" style={{color:"var(--cyan)"}}>✦ {measured.toFixed(3)} m</span>
          <span className="mono text-xs" style={{color:"var(--ink-dim)"}}>{measurePts[0].label||`(${measurePts[0].x.toFixed(1)},${measurePts[0].y.toFixed(1)})`} → {measurePts[1].label||`(${measurePts[1].x.toFixed(1)},${measurePts[1].y.toFixed(1)})`}</span>
          <button onClick={()=>setMeasurePts([])} className="btn-ghost" style={{padding:"2px 8px",fontSize:10}}>Limpiar</button>
        </div>
      )}
      {!measureMode && <div className="flex gap-4 mt-2 flex-wrap">
        {machines.map(m=><span key={m.machineIdx} className="mono text-xs flex items-center gap-1"><span style={{color:MACHINE_COLORS[m.machineIdx]}}>●</span> {MACHINE_NAMES[m.machineIdx]} · {m.path.length} pilotes · {m.totalDist.toFixed(1)} m · {m.maxDay} días</span>)}
      </div>}
    </div>
  );
}

// ─── AdjustedSimPlayer — simulación liviana para la vista de imprevistos ────────
function AdjustedSimPlayer({ result, piles, mapGeom, radius, startDate, skipSat, skipSun, postponed }) {
  const zoom = useZoomPan(mapGeom.W, mapGeom.H);
  const [simDay, setSimDay] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [symSize, setSymSize] = useState(6);
  const intervalRef = useRef(null);
  const maxDay = result.maxDay || 1;

  useEffect(() => { setSimDay(1); setPlaying(false); }, [result]);
  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setSimDay(d => { if (d >= maxDay) { setPlaying(false); return d; } return d + 1; });
      }, 900);
    } else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [playing, maxDay]);

  const date = getWorkingDate(startDate, simDay, skipSat, skipSun);
  const todaySet = new Set((result.byDay.find(b => b.day === simDay)?.piles || []).map(p => p.id));
  const doneSet  = new Set(result.path.filter(p => (result.dayOf.get(p.id)||0) < simDay).map(p => p.id));

  return (
    <div className="panel p-3" style={{ borderColor:"var(--cyan)" }}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="mono text-sm font-bold" style={{ color:"var(--orange)" }}>
          Día {simDay} / {maxDay} &nbsp;·&nbsp; {fmtDate(date)}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <button className="btn-ghost" style={{padding:"4px 8px"}} onClick={() => { setPlaying(false); setSimDay(1); }}>⏮</button>
          <button className="btn-ghost" style={{padding:"4px 8px"}} onClick={() => setSimDay(d => Math.max(1,d-1))}>‹</button>
          <button className="btn-primary" style={{padding:"5px 14px",fontSize:12}} onClick={() => setPlaying(p => !p)}>{playing ? "⏸" : "▶"}</button>
          <button className="btn-ghost" style={{padding:"4px 8px"}} onClick={() => setSimDay(d => Math.min(maxDay,d+1))}>›</button>
          <button className="btn-ghost" style={{padding:"4px 8px"}} onClick={() => { setPlaying(false); setSimDay(maxDay); }}>⏭</button>
          <ScaleControl value={symSize} onChange={setSymSize}/>
        </div>
      </div>
      <input type="range" min={1} max={maxDay} value={simDay} onChange={e => { setPlaying(false); setSimDay(Number(e.target.value)); }}
        style={{width:"100%",accentColor:"var(--cyan)",marginBottom:8}}/>
      <div style={{position:"relative"}}>
        <svg viewBox={zoom.viewBox} width="100%"
          style={{background:"var(--blue-deep)",borderRadius:3,cursor:"grab",display:"block"}}
          onWheel={zoom.onWheel} onContextMenu={e=>e.preventDefault()}
          onMouseDown={zoom.onMouseDown} onMouseMove={zoom.onMouseMove}
          onMouseUp={zoom.stopPan} onMouseLeave={zoom.stopPan}>
          <BuildingOutlines piles={piles} mapGeom={mapGeom} zoom={zoom}/>
          {radius > 0 && piles.map(p => {
            const{cx,cy}=mapGeom.toSvg(p);
            return <circle key={`r-${p.id}`} cx={cx} cy={cy} r={radius*mapGeom.scale} fill="none" stroke="var(--orange)" strokeOpacity="0.2" strokeWidth={zoom.px(0.8)} strokeDasharray={`${zoom.px(3)} ${zoom.px(3)}`}/>;
          })}
          {/* Ruta ajustada */}
          <polyline
            points={result.path.map(p=>{ const{cx,cy}=mapGeom.toSvg(p); return`${cx},${cy}`; }).join(" ")}
            fill="none" stroke="var(--cyan)" strokeOpacity="0.25" strokeWidth={zoom.px(1.2)} strokeDasharray={`${zoom.px(4)} ${zoom.px(6)}`}/>
          {piles.map(p => {
            const{cx,cy}=mapGeom.toSvg(p);
            const isToday = todaySet.has(p.id);
            const isDone  = doneSet.has(p.id);
            const isPostponed = postponed && postponed.has(p.id) && !postponed.get(p.id)?.rescheduleDate;
            const R  = zoom.px(symSize);
            const fz = zoom.px(Math.max(5, symSize-1));
            const fillColor = isToday ? "var(--cyan)" : isDone ? "#2A3A42" : isPostponed ? "#FF7A3D" : "#162A38";
            return (
              <g key={p.id}>
                {isToday && <>
                  <circle cx={cx} cy={cy} r={zoom.px(symSize*2)} fill="var(--cyan)" fillOpacity="0.08" stroke="var(--cyan)" strokeOpacity="0.35" strokeDasharray={`${zoom.px(4)} ${zoom.px(3)}`} strokeWidth={zoom.px(1)}/>
                  <circle cx={cx} cy={cy} r={zoom.px(symSize*1.6)} fill="none" stroke="var(--cyan)" strokeOpacity="0.5" strokeWidth={zoom.px(2)}>
                    <animate attributeName="r" values={`${zoom.px(symSize*1.2)};${zoom.px(symSize*2.4)};${zoom.px(symSize*1.2)}`} dur="1.4s" repeatCount="indefinite"/>
                    <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="1.4s" repeatCount="indefinite"/>
                  </circle>
                </>}
                {isPostponed && !isToday && <circle cx={cx} cy={cy} r={R*1.5} fill="none" stroke="var(--orange)" strokeWidth={zoom.px(1.2)} strokeDasharray={`${zoom.px(3)} ${zoom.px(2)}`} strokeOpacity="0.7"/>}
                <circle cx={cx} cy={cy} r={R} fill={fillColor} stroke={isToday?"var(--cyan)":isDone?"#1A2A32":"#1A3040"} strokeWidth={zoom.px(isToday?2:1)} fillOpacity={isPostponed&&!isToday?0.4:1}/>
                <text x={cx} y={cy-R-zoom.px(2)} textAnchor="middle" fontSize={fz} fill={isDone?"#4A6070":"var(--ink-dim)"} fontFamily="IBM Plex Mono,monospace">{p.name}</text>
                {isToday && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">HOY</text>}
                {isPostponed && !isToday && <text x={cx} y={cy+R*0.4} textAnchor="middle" fontSize={fz} fontWeight="700" fill="#061F30" fontFamily="IBM Plex Mono,monospace">⚠</text>}
              </g>
            );
          })}
        </svg>
        <ZoomControls onReset={zoom.reset} zoomPct={zoom.zoomPct}/>
      </div>
      <div className="flex gap-4 mt-2 flex-wrap mono text-xs" style={{color:"var(--ink-dim)"}}>
        <span>✓ Fundidos: {[...doneSet].length}</span>
        <span style={{color:"var(--cyan)"}}>⬤ Hoy: {todaySet.size}</span>
        <span>Pendientes: {piles.length - [...doneSet].length - todaySet.size}</span>
        {postponed && postponed.size > 0 && <span style={{color:"var(--orange)"}}>⚠ Imprevistos: {postponed.size}</span>}
      </div>
    </div>
  );
}

// ─── PostponePanel ─────────────────────────────────────────────────────────────
// Permite marcar pilotes como pospuestos y reprogramarlos en una fecha específica.
// postponed: Map<pileId, { reason:string, rescheduleDate:string|null }>
function PostponePanel({ result, piles, startDate, skipSat, skipSun, perDay, bufferDays, radius, postponed, onPostponedChange, mapGeom, adjustedResult }) {
  const [selectedId, setSelectedId]   = useState("");
  const [reason, setReason]           = useState("");
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [editingId, setEditingId]     = useState(null);
  const [rescheduleInputVal, setRescheduleInputVal] = useState("");
  const [subTab, setSubTab]           = useState("cronograma"); // "cronograma" | "plano" | "sim"
  const [simDay, setSimDay]           = useState(1);
  const [simPlaying, setSimPlaying]   = useState(false);
  const simRef = useRef(null);

  // Convierte fecha real → día de obra (inverso de getWorkingDate)
  function workingDayFromDate(dateStr) {
    if (!dateStr) return null;
    const target = new Date(dateStr + "T00:00:00");
    let d = new Date(startDate + "T00:00:00");
    let count = 0;
    for (let i = 0; i < 10000; i++) {
      const dow = d.getDay();
      const skip = (skipSun && dow === 0) || (skipSat && dow === 6);
      if (!skip) {
        count++;
        if (d.toDateString() === target.toDateString()) return count;
      }
      if (d > target) return null;
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  function handlePostpone() {
    if (!selectedId) return;
    const next = new Map(postponed);
    next.set(selectedId, { reason: reason || "Imprevisto en terreno", rescheduleDate: rescheduleDate || null });
    onPostponedChange(next);
    setSelectedId(""); setReason(""); setRescheduleDate("");
  }

  function handleRemove(id) {
    const next = new Map(postponed);
    next.delete(id);
    onPostponedChange(next);
    if (editingId === id) setEditingId(null);
  }

  function handleReschedule(id, dateStr) {
    const next = new Map(postponed);
    const entry = next.get(id);
    if (entry) { next.set(id, { ...entry, rescheduleDate: dateStr }); onPostponedChange(next); }
    setEditingId(null);
  }

  // Pilotes aún sin posponer
  const available = result.path.filter(p => !postponed.has(p.id));

  // Recalcula el cronograma ajustado:
  // - Los pospuestos sin fecha de reprogramación se saltan del slot original y
  //   el algoritmo reasigna la capacidad de ese día al siguiente pilote disponible.
  // - Los pospuestos CON fecha se insertan en el día de obra equivalente.
  const adjustedSchedule = useMemo(() => {
    if (!result) return null;
    const postponedIds = new Set(postponed.keys());
    // Pilotes que siguen en secuencia normal (sin posponer o ya reprogramados)
    const normalPath = result.path.filter(p => !postponedIds.has(p.id));

    // Recalcular días para la secuencia normal usando scheduleAlongPath simplificado
    const adj = buildConflicts(normalPath, radius);
    const dayOf = new Map();
    const perDayCount = new Map();
    for (const pile of normalPath) {
      let day = 1;
      while (true) {
        const count = perDayCount.get(day) || 0;
        const ok = adj.get(pile.id).every(nId => {
          const nDay = dayOf.get(nId);
          return nDay === undefined || Math.abs(nDay - day) >= bufferDays;
        });
        if (count < perDay && ok) {
          dayOf.set(pile.id, day);
          perDayCount.set(day, count + 1);
          break;
        }
        day++;
      }
    }

    // Insertar pospuestos con fecha de reprogramación
    for (const [id, info] of postponed) {
      if (info.rescheduleDate) {
        const wDay = workingDayFromDate(info.rescheduleDate);
        if (wDay) dayOf.set(id, wDay);
      }
    }

    // Construir byDay
    const allIds = [...dayOf.keys()];
    const maxDay = allIds.length ? Math.max(...[...dayOf.values()]) : 1;
    const byDay = [];
    for (let d = 1; d <= maxDay; d++) {
      const ps = result.path.filter(p => dayOf.get(p.id) === d);
      if (ps.length) byDay.push({ day: d, piles: ps });
    }

    // Sugerencia: qué fundir mientras se resuelve el imprevisto
    // = el primer pilote disponible en el día original del pospuesto
    const suggestions = new Map();
    for (const [id] of postponed) {
      const origDay = result.dayOf.get(id);
      if (origDay !== undefined) {
        const candidates = normalPath.filter(p => dayOf.get(p.id) === origDay);
        if (candidates.length) suggestions.set(id, candidates.map(p => p.name));
      }
    }

    return { byDay, dayOf, maxDay, suggestions };
  }, [result, postponed, perDay, bufferDays, radius, startDate, skipSat, skipSun]);

  const postponedList = [...postponed.entries()];

  return (
    <div className="panel p-4" style={{ borderColor:"var(--orange)" }}>
      <div className="field-label mb-3" style={{ color:"var(--orange)" }}>⚠ Gestión de imprevistos · Posponer pilotes</div>

      {/* Formulario para posponer */}
      <div style={{ background:"rgba(255,122,61,0.06)", border:"1px solid rgba(255,122,61,0.2)", borderRadius:4, padding:"12px", marginBottom:12 }}>
        <div className="flex flex-col gap-2">
          <div>
            <label className="field-label" style={{ marginBottom:4 }}>Pilote afectado</label>
            <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
              style={{ background:"var(--blue-deep)", border:"1px solid var(--blue-line)", color:"var(--ink)", borderRadius:3, padding:"6px 8px", fontFamily:"IBM Plex Mono,monospace", width:"100%" }}>
              <option value="">— seleccionar pilote —</option>
              {available.map(p => {
                const day = result.dayOf.get(p.id);
                const date = day ? fmtDate(getWorkingDate(startDate, day, skipSat, skipSun)) : "";
                return <option key={p.id} value={p.id}>{p.name}  (Día {day} · {date})</option>;
              })}
            </select>
          </div>
          <div>
            <label className="field-label" style={{ marginBottom:4 }}>Motivo del imprevisto</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)}
              placeholder="Ej: Obstáculo en terreno, condición climática..."
              style={{ background:"var(--blue-deep)", border:"1px solid var(--blue-line)", color:"var(--ink)", borderRadius:3, padding:"6px 8px", fontFamily:"IBM Plex Mono,monospace", width:"100%" }}/>
          </div>
          <div>
            <label className="field-label" style={{ marginBottom:4 }}>Fecha de reprogramación (dejar vacío si aún no se sabe)</label>
            <input type="date" value={rescheduleDate} onChange={e => setRescheduleDate(e.target.value)}
              style={{ background:"var(--blue-deep)", border:"1px solid var(--blue-line)", color:"var(--ink)", borderRadius:3, padding:"6px 8px", fontFamily:"IBM Plex Mono,monospace", width:"100%" }}/>
          </div>
          <button onClick={handlePostpone} disabled={!selectedId} className="btn-primary" style={{ alignSelf:"flex-start", marginTop:4 }}>
            ⚠ Marcar como pospuesto
          </button>
        </div>
      </div>

      {/* Lista de pospuestos */}
      {postponedList.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="field-label mb-1">Pilotes pospuestos</div>
          {postponedList.map(([id, info]) => {
            const pile = piles.find(p => p.id === id);
            const origDay = result.dayOf.get(id);
            const origDate = origDay ? fmtDate(getWorkingDate(startDate, origDay, skipSat, skipSun)) : "—";
            const suggestion = adjustedSchedule?.suggestions.get(id);
            const reschedWDay = info.rescheduleDate ? workingDayFromDate(info.rescheduleDate) : null;
            return (
              <div key={id} style={{ background:"rgba(255,122,61,0.08)", border:"1px solid rgba(255,122,61,0.3)", borderRadius:4, padding:"10px 12px" }}>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <span className="mono text-sm font-bold" style={{ color:"var(--orange)" }}>{pile?.name || id}</span>
                    <span className="mono text-xs ml-2" style={{ color:"var(--ink-dim)" }}>Programado: Día {origDay} ({origDate})</span>
                  </div>
                  <button onClick={() => handleRemove(id)} className="btn-ghost" style={{ padding:"2px 8px", fontSize:10, color:"var(--ink-dim)" }}>✕ Quitar</button>
                </div>
                <p className="mono text-xs mt-1" style={{ color:"var(--ink-dim)" }}>Motivo: {info.reason}</p>
                {suggestion && !info.rescheduleDate && (
                  <p className="mono text-xs mt-1" style={{ color:"var(--cyan)" }}>
                    💡 Sugerencia mientras se resuelve: fundir <strong>{suggestion.join(", ")}</strong>
                  </p>
                )}
                {info.rescheduleDate ? (
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="mono text-xs" style={{ color:"var(--cyan)" }}>
                      ✓ Reprogramado para: {fmtDate(new Date(info.rescheduleDate + "T00:00:00"))}
                      {reschedWDay ? ` (Día de obra ${reschedWDay})` : " (fecha fuera del rango laboral)"}
                    </span>
                    <button onClick={() => setEditingId(id)} className="btn-ghost" style={{ padding:"2px 8px", fontSize:10 }}>✎ Cambiar fecha</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="mono text-xs" style={{ color:"var(--orange)" }}>⏳ Pendiente de reprogramar</span>
                    <button onClick={() => setEditingId(editingId === id ? null : id)} className="btn-ghost" style={{ padding:"2px 8px", fontSize:10 }}>📅 Definir fecha</button>
                  </div>
                )}
                {editingId === id && (
                  <div className="flex gap-2 mt-2 items-center flex-wrap">
                    <input type="date" defaultValue={info.rescheduleDate || ""}
                      ref={el => { if (el) el.dataset.rescheduleFor = id; }}
                      onChange={e => setRescheduleInputVal(e.target.value)}
                      style={{ background:"var(--blue-deep)", border:"1px solid var(--cyan)", color:"var(--ink)", borderRadius:3, padding:"4px 8px", fontFamily:"IBM Plex Mono,monospace", fontSize:12 }}/>
                    <button className="btn-primary" style={{ padding:"4px 12px", fontSize:11 }}
                      onClick={() => { if (rescheduleInputVal) handleReschedule(id, rescheduleInputVal); }}>
                      ✓ Confirmar
                    </button>
                    <button className="btn-ghost" style={{ padding:"4px 10px", fontSize:11 }} onClick={() => { setEditingId(null); setRescheduleInputVal(""); }}>Cancelar</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Sub-tabs: Cronograma / Plano / Simulación ajustados ─────────── */}
      {postponedList.length > 0 && adjustedSchedule && (
        <div style={{ marginTop:16 }}>
          <div style={{ borderBottom:"1px solid var(--blue-line)", display:"flex", gap:0, marginBottom:12 }}>
            {[
              { key:"cronograma", label:"📋 Cronograma ajustado" },
              { key:"plano",      label:"🗺 Vista en planta" },
              { key:"sim",        label:"▶ Simulación ajustada" },
            ].map(t => (
              <button key={t.key}
                className={`tab${subTab===t.key?" active":""}`}
                style={{ fontSize:11, padding:"6px 12px" }}
                onClick={() => { setSubTab(t.key); if(t.key==="sim") setSimDay(1); }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* CRONOGRAMA AJUSTADO */}
          {subTab === "cronograma" && (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr>
                    <th className="th">Día</th>
                    <th className="th">Fecha</th>
                    <th className="th">Pilotes</th>
                    <th className="th">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustedSchedule.byDay.map(({ day, piles: ps }) => {
                    const date = getWorkingDate(startDate, day, skipSat, skipSun);
                    const hasPostponed = ps.some(p => postponed.has(p.id));
                    const hasRescheduled = ps.some(p => { const inf = postponed.get(p.id); return inf && inf.rescheduleDate; });
                    return (
                      <tr key={day} style={{ background: hasRescheduled ? "rgba(127,217,240,0.05)" : hasPostponed ? "rgba(255,122,61,0.05)" : "transparent" }}>
                        <td className="td"><span className="day-chip" style={{ background: hasRescheduled ? "var(--cyan)" : colorForDay(day), color:"#061F30" }}>{day}</span></td>
                        <td className="td mono" style={{ fontSize:12 }}>{fmtDate(date)}</td>
                        <td className="td mono" style={{ fontSize:12 }}>
                          {ps.map(p => {
                            const inf = postponed.get(p.id);
                            if (inf) return <span key={p.id} style={{ color:"var(--cyan)", marginRight:6 }}>🔄 {p.name}</span>;
                            return <span key={p.id} style={{ marginRight:6 }}>{p.name}</span>;
                          })}
                        </td>
                        <td className="td mono" style={{ fontSize:11 }}>
                          {hasRescheduled ? <span style={{ color:"var(--cyan)" }}>↩ Reprogramado</span> : <span style={{ color:"var(--ink-dim)" }}>Normal</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* VISTA EN PLANTA AJUSTADA */}
          {subTab === "plano" && mapGeom && (() => {
            const dispResult = adjustedResult || { ...result, dayOf: adjustedSchedule.dayOf, byDay: adjustedSchedule.byDay, maxDay: adjustedSchedule.maxDay };
            return (
              <PlanViewSingle
                result={dispResult}
                piles={piles}
                mapGeom={mapGeom}
                radius={radius}
                adjustedResult={null}
                postponed={postponed}
              />
            );
          })()}

          {/* SIMULACIÓN AJUSTADA */}
          {subTab === "sim" && mapGeom && (() => {
            const dispResult = adjustedResult || { ...result, dayOf: adjustedSchedule.dayOf, byDay: adjustedSchedule.byDay, maxDay: adjustedSchedule.maxDay };
            const maxDay = dispResult.maxDay || 1;
            return (
              <AdjustedSimPlayer
                result={dispResult}
                piles={piles}
                mapGeom={mapGeom}
                radius={radius}
                startDate={startDate}
                skipSat={skipSat}
                skipSun={skipSun}
                postponed={postponed}
              />
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── ProjectLibrary ────────────────────────────────────────────────────────────
// Gestiona proyectos y sus secuencias guardadas usando window.storage persistente.
function ProjectLibrary({ currentResult, currentMultiResult, currentPiles, startDate, skipSat, skipSun,
  currentPostponed, currentPerDay, currentRadius, currentBufferHours, currentNumMachines,
  currentMachineGroups, currentDrawnOrders, currentExecutionLog, onLoadSequence }) {
  const [open, setOpen]               = useState(false);
  const [projects, setProjects]       = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [newProjectName, setNewProjectName]   = useState("");
  const [newSeqName, setNewSeqName]           = useState("");
  const [loading, setLoading]         = useState(false);
  const [saveMsg, setSaveMsg]         = useState("");
  const [updatingSeqId, setUpdatingSeqId]     = useState(null); // id de secuencia a sobreescribir

  // Carga proyectos desde storage al abrir
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.storage.get("projects_library").then(res => {
      if (res && res.value) {
        try { setProjects(JSON.parse(res.value)); } catch { setProjects([]); }
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [open]);

  async function persist(next) {
    setProjects(next);
    await window.storage.set("projects_library", JSON.stringify(next));
  }

  function createProject() {
    if (!newProjectName.trim()) return;
    const next = [...projects, { id: Date.now().toString(), name: newProjectName.trim(), sequences: [] }];
    persist(next);
    setNewProjectName("");
    setActiveProjectId(next[next.length - 1].id);
  }

  const [confirmDeletePid, setConfirmDeletePid] = useState(null);

  function deleteProject(pid) {
    if (confirmDeletePid === pid) {
      persist(projects.filter(p => p.id !== pid));
      if (activeProjectId === pid) setActiveProjectId(null);
      setConfirmDeletePid(null);
    } else {
      setConfirmDeletePid(pid);
      setTimeout(() => setConfirmDeletePid(null), 4000); // auto-cancel after 4s
    }
  }

  function saveSequence(pid) {
    if (!newSeqName.trim()) return;
    // Serialize Maps → plain objects so JSON.stringify works correctly
    const baseSnap = {
      startDate, skipSat, skipSun, piles: currentPiles,
      perDay: currentPerDay, radius: currentRadius, bufferHours: currentBufferHours,
      numMachines: currentNumMachines,
      // machineGroups: Set[] → array of arrays for JSON
      machineGroups: (currentMachineGroups || []).map(s => [...(s||[])]),
      drawnOrders: currentDrawnOrders || [[],[],[],[]],
      // postponed: Map → array of [id, info] entries
      postponed: [...(currentPostponed || new Map()).entries()],
    };
    const snap = currentMultiResult
      ? { ...baseSnap, type: "multi", multiResult: serializeMultiResult(currentMultiResult) }
      : currentResult
      ? { ...baseSnap, type: "single", result: serializeResult(currentResult) }
      : null;
    if (!snap) { setSaveMsg("Primero calcula una secuencia."); setTimeout(() => setSaveMsg(""), 2500); return; }
    const seq = { id: Date.now().toString(), name: newSeqName.trim(), createdAt: new Date().toISOString(), snap };
    const next = projects.map(p => p.id === pid ? { ...p, sequences: [...p.sequences, seq] } : p);
    persist(next);
    setNewSeqName("");
    const nPostponed = (currentPostponed||new Map()).size;
    setSaveMsg(`✓ "${seq.name}" guardada${nPostponed>0?` · ${nPostponed} imprevisto(s) incluidos`:""}.`);
    setTimeout(() => setSaveMsg(""), 3000);
  }

  function deleteSequence(pid, sid) {
    const next = projects.map(p => p.id === pid ? { ...p, sequences: p.sequences.filter(s => s.id !== sid) } : p);
    persist(next);
  }

  // Sobreescribe una secuencia existente con el estado actual
  function updateSequence(pid, sid) {
    const baseSnap = {
      startDate, skipSat, skipSun, piles: currentPiles,
      perDay: currentPerDay, radius: currentRadius, bufferHours: currentBufferHours,
      numMachines: currentNumMachines,
      machineGroups: (currentMachineGroups || []).map(s => [...(s||[])]),
      drawnOrders: currentDrawnOrders || [[],[],[],[]],
      postponed: [...(currentPostponed || new Map()).entries()],
      executionLog: [...(currentExecutionLog || new Map()).entries()],
    };
    const snap = currentMultiResult
      ? { ...baseSnap, type: "multi", multiResult: serializeMultiResult(currentMultiResult) }
      : currentResult
      ? { ...baseSnap, type: "single", result: serializeResult(currentResult) }
      : null;
    if (!snap) { setSaveMsg("Primero calcula una secuencia antes de actualizar."); setTimeout(() => setSaveMsg(""), 3000); setUpdatingSeqId(null); return; }
    const now = new Date().toISOString();
    const next = projects.map(proj => proj.id !== pid ? proj : {
      ...proj,
      sequences: proj.sequences.map(s => s.id !== sid ? s : { ...s, snap, updatedAt: now }),
    });
    persist(next);
    const nPostponed = (currentPostponed||new Map()).size;
    setSaveMsg(`✓ Secuencia actualizada${nPostponed>0?` · ${nPostponed} imprevisto(s) guardados`:""}.`);
    setTimeout(() => setSaveMsg(""), 3000);
    setUpdatingSeqId(null);
  }

  function loadSequence(seq) {
    onLoadSequence(seq.snap);
    setOpen(false);
  }

  const activeProject = projects.find(p => p.id === activeProjectId);

  if (!open) return (
    <button onClick={() => setOpen(true)} className="btn-ghost"
      style={{ position:"fixed", bottom:90, right:24, borderRadius:999, padding:"10px 18px", zIndex:1000, boxShadow:"0 4px 20px rgba(0,0,0,0.5)", borderColor:"var(--cyan)", color:"var(--cyan)" }}>
      📁 Mis proyectos
    </button>
  );

  return (
    <div style={{ position:"fixed", bottom:24, right:400, zIndex:1000, width:420, maxHeight:580, background:"var(--blue-panel)", border:"1px solid var(--cyan)", borderRadius:8, boxShadow:"0 8px 32px rgba(0,0,0,0.6)", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Header */}
      <div style={{ padding:"11px 15px", borderBottom:"1px solid var(--blue-line)", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <span className="mono text-sm font-bold" style={{ color:"var(--cyan)" }}>📁 Biblioteca de proyectos</span>
        <button onClick={() => setOpen(false)} style={{ background:"none", border:"none", color:"var(--ink-dim)", cursor:"pointer" }}><X size={14}/></button>
      </div>

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>
        {/* Columna izquierda: lista de proyectos */}
        <div style={{ width:160, borderRight:"1px solid var(--blue-line)", display:"flex", flexDirection:"column", flexShrink:0 }}>
          <div style={{ padding:"8px 10px", borderBottom:"1px solid var(--blue-line)" }}>
            <div className="field-label mb-1" style={{ fontSize:9 }}>Nuevo proyecto</div>
            <div className="flex gap-1">
              <input type="text" value={newProjectName} onChange={e => setNewProjectName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createProject(); }}
                placeholder="Nombre..." style={{ fontSize:11, padding:"4px 6px", flex:1 }}/>
              <button onClick={createProject} className="btn-ghost" style={{ padding:"4px 7px", fontSize:11 }}>+</button>
            </div>
          </div>
          <div style={{ overflowY:"auto", flex:1 }}>
            {loading && <p className="mono text-xs p-2" style={{ color:"var(--ink-dim)" }}>Cargando...</p>}
            {projects.map(p => (
              <div key={p.id} onClick={() => setActiveProjectId(p.id)}
                style={{ padding:"8px 10px", cursor:"pointer", borderBottom:"1px solid var(--blue-line)", background: activeProjectId === p.id ? "rgba(127,217,240,0.1)" : "transparent", borderLeft: activeProjectId === p.id ? "3px solid var(--cyan)" : "3px solid transparent" }}>
                <div className="mono text-xs font-bold" style={{ color: activeProjectId === p.id ? "var(--cyan)" : "var(--ink)", wordBreak:"break-word" }}>{p.name}</div>
                <div className="mono" style={{ fontSize:9, color:"var(--ink-dim)", marginTop:2 }}>{p.sequences.length} secuencia{p.sequences.length !== 1 ? "s" : ""}</div>
              </div>
            ))}
            {!loading && projects.length === 0 && <p className="mono text-xs p-3" style={{ color:"var(--ink-dim)" }}>Sin proyectos aún.</p>}
          </div>
        </div>

        {/* Columna derecha: secuencias del proyecto activo */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          {!activeProject ? (
            <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
              <p className="mono text-xs" style={{ color:"var(--ink-dim)", textAlign:"center" }}>Selecciona o crea un proyecto para ver y guardar secuencias.</p>
            </div>
          ) : (
            <>
              <div style={{ padding:"8px 10px", borderBottom:"1px solid var(--blue-line)", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
                <span className="mono text-xs font-bold" style={{ color:"var(--cyan)" }}>{activeProject.name}</span>
                {confirmDeletePid === activeProject.id ? (
                  <div className="flex gap-1 items-center">
                    <span className="mono" style={{fontSize:9, color:"var(--orange)"}}>¿Eliminar?</span>
                    <button onClick={() => deleteProject(activeProject.id)} style={{ background:"var(--orange)", border:"none", color:"#061F30", cursor:"pointer", fontSize:9, padding:"2px 7px", borderRadius:3, fontWeight:700 }}>Sí</button>
                    <button onClick={() => setConfirmDeletePid(null)} style={{ background:"none", border:"1px solid var(--blue-line)", color:"var(--ink-dim)", cursor:"pointer", fontSize:9, padding:"2px 6px", borderRadius:3 }}>No</button>
                  </div>
                ) : (
                  <button onClick={() => deleteProject(activeProject.id)} style={{ background:"none", border:"none", color:"var(--ink-dim)", cursor:"pointer", fontSize:10 }}>🗑</button>
                )}
              </div>

              {/* Guardar secuencia actual */}
              <div style={{ padding:"8px 10px", borderBottom:"1px solid var(--blue-line)", flexShrink:0 }}>
                <div className="field-label mb-1" style={{ fontSize:9 }}>Guardar secuencia actual</div>
                <div className="flex gap-1">
                  <input type="text" value={newSeqName} onChange={e => setNewSeqName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveSequence(activeProject.id); }}
                    placeholder='Ej: "Opción A - barrido norte"'
                    style={{ fontSize:11, padding:"4px 6px", flex:1 }}/>
                  <button onClick={() => saveSequence(activeProject.id)} className="btn-primary" style={{ padding:"4px 9px", fontSize:11 }}>💾</button>
                </div>
                {saveMsg && <p className="mono mt-1" style={{ fontSize:10, color:"var(--cyan)" }}>{saveMsg}</p>}
              </div>

              {/* Lista de secuencias */}
              <div style={{ overflowY:"auto", flex:1, padding:"6px 8px" }}>
                {activeProject.sequences.length === 0 && (
                  <p className="mono text-xs p-2" style={{ color:"var(--ink-dim)" }}>Sin secuencias guardadas.</p>
                )}
                {activeProject.sequences.map(seq => (
                  <div key={seq.id} style={{ background:"var(--blue-deep)", border:"1px solid var(--blue-line)", borderRadius:4, padding:"8px 10px", marginBottom:6 }}>
                    <div className="flex items-start justify-between gap-1">
                      <div style={{ flex:1 }}>
                        <div className="mono text-xs font-bold" style={{ color:"var(--ink)" }}>{seq.name}</div>
                        <div className="mono" style={{ fontSize:9, color:"var(--ink-dim)", marginTop:2 }}>
                          {seq.snap.type === "multi"
                            ? `${seq.snap.multiResult.machines.length} máq · ${seq.snap.piles.length} pilotes · Inicio: ${seq.snap.startDate}`
                            : `${seq.snap.piles.length} pilotes · ${seq.snap.result.maxDay} días · Inicio: ${seq.snap.startDate}`}
                        </div>
                        <div className="mono" style={{ fontSize:9, color:"var(--ink-dim)" }}>
                          {new Date(seq.createdAt).toLocaleString("es-CO", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })}
                          {seq.updatedAt && <span style={{color:"var(--cyan)"}}> · actualizada {new Date(seq.updatedAt).toLocaleString("es-CO",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</span>}
                        </div>
                        {seq.snap.postponed?.length > 0 && (
                          <div className="mono" style={{fontSize:9,color:"var(--orange)",marginTop:2}}>⚠ {seq.snap.postponed.length} imprevisto(s) guardados</div>
                        )}
                      </div>
                      <div className="flex gap-1" style={{ flexShrink:0, flexDirection:"column", alignItems:"flex-end" }}>
                        <div className="flex gap-1">
                          <button onClick={() => loadSequence(seq)} className="btn-primary" style={{ padding:"3px 9px", fontSize:10 }}>↑ Cargar</button>
                          <button onClick={() => deleteSequence(activeProject.id, seq.id)} style={{ background:"none", border:"none", color:"var(--ink-dim)", cursor:"pointer", fontSize:10, padding:"3px 5px" }}>🗑</button>
                        </div>
                        {/* Botón actualizar con confirmación inline */}
                        {updatingSeqId === seq.id ? (
                          <div className="flex gap-1 mt-1">
                            <span className="mono" style={{fontSize:9,color:"var(--orange)",alignSelf:"center"}}>¿Sobrescribir?</span>
                            <button onClick={() => updateSequence(activeProject.id, seq.id)} className="btn-primary" style={{padding:"2px 8px",fontSize:9,background:"var(--orange)"}}>✓ Sí</button>
                            <button onClick={() => setUpdatingSeqId(null)} className="btn-ghost" style={{padding:"2px 6px",fontSize:9}}>No</button>
                          </div>
                        ) : (
                          <button onClick={() => setUpdatingSeqId(seq.id)} className="btn-ghost" style={{padding:"2px 8px",fontSize:9,marginTop:2,borderColor:"var(--orange)",color:"var(--orange)"}}>
                            ↻ Actualizar con estado actual
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PileExecutionLog — registro diario de pilotes ejecutados ────────────────
// executionLog: Map<pileId, { date, machine, operator, expansion, notes, done }>
const EXPANSION_OPTIONS = ["< 5%","5–10%","10–15%","15–20%","> 20%","No medido"];
const MACHINE_LIST_NAMES = ["Máquina 1","Máquina 2","Máquina 3","Máquina 4","Otra"];

function PileExecutionLog({ piles, result, multiResult, startDate, skipSat, skipSun, executionLog, onLogChange }) {
  const [filter, setFilter]       = useState("pending"); // "all" | "done" | "pending"
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState({});
  const [searchText, setSearchText] = useState("");

  // Construir lista unificada de pilotes con su día programado
  const pilesWithDay = useMemo(() => {
    const dayOf = new Map();
    if (result) result.dayOf.forEach((d, id) => dayOf.set(id, d));
    if (multiResult) multiResult.machines.forEach(m => m.dayOf.forEach((d, id) => dayOf.set(id, d)));
    return piles.map(p => ({ ...p, scheduledDay: dayOf.get(p.id) }))
      .sort((a, b) => (a.scheduledDay||9999) - (b.scheduledDay||9999));
  }, [piles, result, multiResult]);

  const donePiles    = pilesWithDay.filter(p => executionLog.has(p.id) && executionLog.get(p.id).done);
  const pendingPiles = pilesWithDay.filter(p => !executionLog.has(p.id) || !executionLog.get(p.id).done);
  const displayPiles = (filter === "done" ? donePiles : filter === "pending" ? pendingPiles : pilesWithDay)
    .filter(p => !searchText || p.name.toLowerCase().includes(searchText.toLowerCase()));

  function openEdit(p) {
    const existing = executionLog.get(p.id) || {};
    setForm({
      date: existing.date || new Date().toISOString().slice(0,10),
      machine: existing.machine || MACHINE_LIST_NAMES[0],
      operator: existing.operator || "",
      expansion: existing.expansion || "No medido",
      notes: existing.notes || "",
      done: existing.done ?? false,
    });
    setEditingId(p.id);
  }

  function saveEntry(pileId) {
    const next = new Map(executionLog);
    next.set(pileId, { ...form, savedAt: new Date().toISOString() });
    onLogChange(next);
    setEditingId(null);
  }

  function markDone(pileId) {
    const next = new Map(executionLog);
    const existing = next.get(pileId) || {};
    next.set(pileId, { ...existing, done: true, date: existing.date || new Date().toISOString().slice(0,10), savedAt: new Date().toISOString() });
    onLogChange(next);
  }

  function removeEntry(pileId) {
    const next = new Map(executionLog);
    next.delete(pileId);
    onLogChange(next);
  }

  const doneCount = donePiles.length;
  const totalCount = piles.length;
  const progress = totalCount > 0 ? Math.round(doneCount/totalCount*100) : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* KPIs de progreso */}
      <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))" }}>
        <div className="panel p-3">
          <div className="field-label">Avance</div>
          <div className="text-2xl font-bold mono mt-1" style={{ color:"var(--cyan)" }}>{progress}%</div>
          <div style={{ height:4, background:"var(--blue-line)", borderRadius:2, marginTop:6 }}>
            <div style={{ height:"100%", width:`${progress}%`, background:"var(--cyan)", borderRadius:2, transition:"width .3s" }}/>
          </div>
        </div>
        <div className="panel p-3">
          <div className="field-label">Fundidos</div>
          <div className="text-2xl font-bold mono mt-1" style={{ color:"var(--cyan)" }}>{doneCount}</div>
        </div>
        <div className="panel p-3">
          <div className="field-label">Pendientes</div>
          <div className="text-2xl font-bold mono mt-1" style={{ color:"var(--orange)" }}>{totalCount - doneCount}</div>
        </div>
        <div className="panel p-3">
          <div className="field-label">Total</div>
          <div className="text-2xl font-bold mono mt-1">{totalCount}</div>
        </div>
      </div>

      {/* Barra de herramientas */}
      <div className="flex gap-2 flex-wrap items-center">
        <input type="text" value={searchText} onChange={e => setSearchText(e.target.value)}
          placeholder="Buscar pilote..." style={{ fontSize:11, padding:"5px 8px", flex:1, minWidth:120 }}/>
        {["all","pending","done"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={filter===f?"btn-primary":"btn-ghost"}
            style={{ padding:"4px 10px", fontSize:11 }}>
            {f==="all"?"Todos":f==="pending"?"Pendientes":"Ejecutados"}
          </button>
        ))}
      </div>

      {/* Tabla de pilotes */}
      <div className="panel" style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr>
              <th className="th">Pilote</th>
              <th className="th">Día prog.</th>
              <th className="th">Fecha ejec.</th>
              <th className="th">Máquina</th>
              <th className="th">Operador</th>
              <th className="th">% Expansión</th>
              <th className="th">Notas</th>
              <th className="th">Estado</th>
              <th className="th">Acción</th>
            </tr>
          </thead>
          <tbody>
            {displayPiles.map(p => {
              const entry = executionLog.get(p.id);
              const isDone = entry?.done;
              const isEditing = editingId === p.id;
              return (
                <tr key={p.id} style={{ background: isDone ? "rgba(127,217,240,0.04)" : "transparent", borderBottom:"1px solid var(--blue-line)" }}>
                  <td className="td mono" style={{ fontWeight:700, color: isDone ? "var(--cyan)" : "var(--ink)" }}>
                    {p.name}
                  </td>
                  <td className="td mono" style={{ fontSize:11 }}>
                    {p.scheduledDay ? (
                      <span>
                        <span className="day-chip" style={{ background:colorForDay(p.scheduledDay), color:"#061F30", marginRight:4 }}>{p.scheduledDay}</span>
                        {fmtDate(getWorkingDate(startDate, p.scheduledDay, skipSat, skipSun))}
                      </span>
                    ) : "—"}
                  </td>
                  {isEditing ? (
                    <>
                      <td className="td"><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} style={{fontSize:11,padding:"3px 5px",width:130}}/></td>
                      <td className="td">
                        <select value={form.machine} onChange={e=>setForm(f=>({...f,machine:e.target.value}))} style={{fontSize:11,padding:"3px 5px",width:"100%"}}>
                          {MACHINE_LIST_NAMES.map(m=><option key={m}>{m}</option>)}
                        </select>
                      </td>
                      <td className="td"><input type="text" value={form.operator} onChange={e=>setForm(f=>({...f,operator:e.target.value}))} placeholder="Nombre..." style={{fontSize:11,padding:"3px 5px",width:110}}/></td>
                      <td className="td">
                        <select value={form.expansion} onChange={e=>setForm(f=>({...f,expansion:e.target.value}))} style={{fontSize:11,padding:"3px 5px",width:"100%"}}>
                          {EXPANSION_OPTIONS.map(o=><option key={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className="td"><input type="text" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Observaciones..." style={{fontSize:11,padding:"3px 5px",width:140}}/></td>
                      <td className="td">
                        <label className="flex items-center gap-1 text-xs mono">
                          <input type="checkbox" checked={form.done} onChange={e=>setForm(f=>({...f,done:e.target.checked}))} style={{width:"auto"}}/> Fundido
                        </label>
                      </td>
                      <td className="td">
                        <div className="flex gap-1">
                          <button onClick={() => saveEntry(p.id)} className="btn-primary" style={{padding:"3px 8px",fontSize:10}}>✓</button>
                          <button onClick={() => setEditingId(null)} className="btn-ghost" style={{padding:"3px 6px",fontSize:10}}>✕</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="td mono" style={{fontSize:11}}>{entry?.date || "—"}</td>
                      <td className="td mono" style={{fontSize:11}}>{entry?.machine || "—"}</td>
                      <td className="td mono" style={{fontSize:11}}>{entry?.operator || "—"}</td>
                      <td className="td mono" style={{fontSize:11,color: entry?.expansion && entry.expansion!=="No medido" ? "var(--cyan)" : "var(--ink-dim)"}}>{entry?.expansion || "—"}</td>
                      <td className="td mono" style={{fontSize:11,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry?.notes || "—"}</td>
                      <td className="td">
                        {isDone
                          ? <span className="mono text-xs" style={{color:"var(--cyan)"}}>✓ Fundido</span>
                          : <span className="mono text-xs" style={{color:"var(--ink-dim)"}}>Pendiente</span>}
                      </td>
                      <td className="td">
                        <div className="flex gap-1 flex-wrap">
                          <button onClick={() => openEdit(p)} className="btn-ghost" style={{padding:"2px 7px",fontSize:10}}>✎</button>
                          {!isDone && <button onClick={() => markDone(p.id)} className="btn-primary" style={{padding:"2px 7px",fontSize:10}}>✓ Fundir</button>}
                          {entry && <button onClick={() => removeEntry(p.id)} style={{background:"none",border:"none",color:"var(--ink-dim)",cursor:"pointer",fontSize:10,padding:"2px 4px"}}>🗑</button>}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {displayPiles.length === 0 && <p className="mono text-xs p-4" style={{color:"var(--ink-dim)",textAlign:"center"}}>No hay pilotes que mostrar con este filtro.</p>}
      </div>

      {/* Resumen por operador */}
      {doneCount > 0 && (() => {
        const byOp = new Map();
        for (const [, e] of executionLog) {
          if (!e.done) continue;
          const key = e.operator || "Sin operador";
          byOp.set(key, (byOp.get(key)||0)+1);
        }
        return (
          <div className="panel p-3">
            <div className="field-label mb-2">Resumen por operador</div>
            <div className="flex gap-3 flex-wrap">
              {[...byOp.entries()].map(([op, count]) => (
                <div key={op} style={{ background:"var(--blue-deep)", border:"1px solid var(--blue-line)", borderRadius:4, padding:"6px 12px" }}>
                  <div className="mono text-xs font-bold" style={{color:"var(--cyan)"}}>{op}</div>
                  <div className="mono text-sm font-bold mt-1">{count} pilotes</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Botón exportar CSV */}
      {doneCount > 0 && (
        <button onClick={() => {
          const rows = ["Pilote,DíaProg,FechaEjec,Máquina,Operador,Expansión,Notas,Estado"];
          for (const p of pilesWithDay) {
            const e = executionLog.get(p.id);
            const date = p.scheduledDay ? fmtDate(getWorkingDate(startDate,p.scheduledDay,skipSat,skipSun)) : "";
            rows.push([p.name, p.scheduledDay||"", date, e?.machine||"", e?.operator||"", e?.expansion||"", `"${(e?.notes||"").replace(/"/g,'""')}"`, e?.done?"Fundido":"Pendiente"].join(","));
          }
          const blob = new Blob([rows.join("\n")], {type:"text/csv"});
          const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="registro_pilotes.csv"; a.click();
        }} className="btn-ghost justify-center">
          <Download size={14}/> Exportar registro (.csv)
        </button>
      )}
    </div>
  );
}

// ─── Helpers para serialización/deserialización de resultados ─────────────────
// result.dayOf y result.conflicts son Maps; JSON.stringify los convierte en {}.
// Estas funciones los convierten de ida y vuelta para el storage persistente.

function serializeResult(result) {
  if (!result) return null;
  return {
    ...result,
    dayOf: result.dayOf ? Object.fromEntries(result.dayOf) : {},
    conflicts: result.conflicts ? Object.fromEntries([...result.conflicts.entries()].map(([k,v])=>[k,v])) : {},
  };
}

function deserializeResult(raw) {
  if (!raw) return null;
  return {
    ...raw,
    dayOf: raw.dayOf ? new Map(Object.entries(raw.dayOf).map(([k,v])=>[k, Number(v)])) : new Map(),
    conflicts: raw.conflicts ? new Map(Object.entries(raw.conflicts)) : new Map(),
  };
}

function serializeMultiResult(mr) {
  if (!mr) return null;
  return {
    ...mr,
    machines: (mr.machines || []).map(m => serializeResult(m)),
  };
}

function deserializeMultiResult(raw) {
  if (!raw) return null;
  return {
    ...raw,
    machines: (raw.machines || []).map(m => deserializeResult(m)),
  };
}

// ─── main component ────────────────────────────────────────────────────────────

export default function PileScheduler() {
  const [piles, setPiles]               = useState([]);
  const [fileName, setFileName]         = useState("");
  const [error, setError]               = useState("");
  const [perDay, setPerDay]             = useState(2);
  const [radius, setRadius]             = useState(5);
  const [bufferHours, setBufferHours]   = useState(48);
  const [startDate, setStartDate]       = useState(() => new Date().toISOString().slice(0, 10));
  const [skipSat, setSkipSat]           = useState(false);
  const [skipSun, setSkipSun]           = useState(true);
  const [startId, setStartId]           = useState("");
  const [dirKey, setDirKey]             = useState("none");
  const [manualOrderText, setManualOrderText] = useState("");
  const [drawnOrder, setDrawnOrder]     = useState([]);
  const [drawMode, setDrawMode]         = useState(false);
  const [result, setResult]             = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [activeAlt, setActiveAlt]       = useState(null);
  const [manualWarning, setManualWarning] = useState("");
  const [activeTab, setActiveTab]       = useState("plano"); // "plano" | "sim" | "tabla" | "cota" | "multi"
  const fileRef = useRef(null);

  // ── NEW multi-machine state ──────────────────────────────────────────────────
  const [numMachines, setNumMachines]   = useState(1);
  // machineGroups[mi] = Set<pileId> — asignación masiva por prefijo/grupo
  const [machineGroups, setMachineGroups] = useState([new Set(),new Set(),new Set(),new Set()]);
  // routePts[mi] = [{cx,cy}] in model toSvg coords — ruta libre de dirección
  const [routePts, setRoutePts]         = useState([[],[],[],[]]);
  const [drawnOrders, setDrawnOrders]   = useState([[],[],[],[]]);  // kept for Claude chat compat
  const [activeMachine, setActiveMachine] = useState(0);
  const [multiResult, setMultiResult]   = useState(null);

  // ── postpone state ───────────────────────────────────────────────────────────
  const [postponed, setPostponed]       = useState(new Map());
  // ── execution log ────────────────────────────────────────────────────────────
  // executionLog: Map<pileId, { date, machine, operator, expansion, notes, done }>
  const [executionLog, setExecutionLog] = useState(new Map());

  const bufferDays = Math.max(1, Math.ceil(bufferHours / 24));
  const mapGeom    = useMapGeom(piles);

  // ── adjustedResult: recalcula automáticamente cuando hay imprevistos ──────────
  // Se propaga a la simulación, el cronograma y el plano para que todo sea consistente.
  const adjustedResult = useMemo(() => {
    if (!result || postponed.size === 0) return null;
    const postponedIds = new Set(postponed.keys());
    const normalPath = result.path.filter(p => !postponedIds.has(p.id));
    if (!normalPath.length) return result;

    // Helper: fecha real → día de obra
    function wdFromDate(dateStr) {
      if (!dateStr) return null;
      const target = new Date(dateStr + "T00:00:00");
      let d = new Date(startDate + "T00:00:00"), count = 0;
      for (let i = 0; i < 10000; i++) {
        const dow = d.getDay();
        if (!((skipSun && dow===0)||(skipSat && dow===6))) {
          count++;
          if (d.toDateString()===target.toDateString()) return count;
        }
        if (d > target) return null;
        d.setDate(d.getDate()+1);
      }
      return null;
    }

    const adj = buildConflicts(normalPath, radius);
    const dayOf = new Map();
    const perDayCount = new Map();
    for (const pile of normalPath) {
      let day = 1;
      while (true) {
        const count = perDayCount.get(day) || 0;
        const ok = adj.get(pile.id).every(nId => {
          const nDay = dayOf.get(nId);
          return nDay === undefined || Math.abs(nDay - day) >= bufferDays;
        });
        if (count < perDay && ok) { dayOf.set(pile.id, day); perDayCount.set(day, count+1); break; }
        day++;
      }
    }
    // Insertar reprogramados
    for (const [id, info] of postponed) {
      if (info.rescheduleDate) {
        const wd = wdFromDate(info.rescheduleDate);
        if (wd) dayOf.set(id, wd);
      }
    }
    const allVals = [...dayOf.values()];
    const maxDay = allVals.length ? Math.max(...allVals) : 1;
    const byDay = [];
    for (let d = 1; d <= maxDay; d++) {
      const ps = result.path.filter(p => dayOf.get(p.id) === d);
      if (ps.length) byDay.push({ day: d, piles: ps });
    }
    // Suggestions: para cada pospuesto, qué fundir ese día
    const suggestions = new Map();
    for (const [id] of postponed) {
      const origDay = result.dayOf.get(id);
      if (origDay !== undefined) {
        const cands = normalPath.filter(p => dayOf.get(p.id) === origDay);
        if (cands.length) suggestions.set(id, cands.map(p=>p.name));
      }
    }
    const consecutive = [];
    for (let i=0; i<result.path.length-1; i++) consecutive.push(dist(result.path[i], result.path[i+1]));
    const totalDist = consecutive.reduce((a,b)=>a+b,0);
    return { ...result, dayOf, byDay, maxDay, totalDist, suggestions };
  }, [result, postponed, perDay, bufferDays, radius, startDate, skipSat, skipSun]);

  // El resultado efectivo que se muestra en simulación, Gantt y cronograma
  const effectiveResult = (adjustedResult && postponed.size > 0) ? adjustedResult : result;

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(""); setResult(null); setAlternatives([]);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb   = XLSX.read(ev.target.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        if (!rows.length) throw new Error("El archivo no tiene filas.");
        const { nameIdx, xIdx, yIdx, edificioIdx } = detectColumns(rows[0]);
        if (xIdx === -1 || yIdx === -1)
          throw new Error("No se encontraron columnas de coordenadas. Usa 'X' y 'Y' (o 'Este'/'Norte').");
        const parsed = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          if (r.every((c) => c === "" || c === undefined)) continue;
          const x = parseFloat(r[xIdx]), y = parseFloat(r[yIdx]);
          if (isNaN(x) || isNaN(y)) continue;
          const name = nameIdx !== -1 && r[nameIdx] !== "" ? String(r[nameIdx]) : `P-${String(i).padStart(2, "0")}`;
          const edificio = edificioIdx !== -1 ? String(r[edificioIdx] || "").trim() : "";
          parsed.push({ id: name, name, x, y, edificio });
        }
        if (!parsed.length) throw new Error("No se pudo leer ningún pilote válido del archivo.");
        setPiles(parsed); setFileName(file.name); setStartId(""); setDrawnOrder([]);
        setMachineGroups([new Set(),new Set(),new Set(),new Set()]);
        setRoutePts([[],[],[],[]]); setDrawnOrders([[],[],[],[]]); setMultiResult(null);
      } catch (err) { setError(err.message || "No se pudo leer el archivo."); }
    };
    reader.readAsArrayBuffer(file);
  }

  function loadDemo() {
    setError(""); setResult(null); setAlternatives([]);
    setPiles(demoPiles()); setFileName("datos de ejemplo"); setStartId(""); setDrawnOrder([]);
    setMachineGroups([new Set(),new Set(),new Set(),new Set()]); setRoutePts([[],[],[],[]]); setDrawnOrders([[],[],[],[]]); setMultiResult(null);
  }

  function reset() {
    setPiles([]); setFileName(""); setError(""); setResult(null);
    setAlternatives([]); setStartId(""); setManualOrderText(""); setDrawnOrder([]);
    setMachineGroups([new Set(),new Set(),new Set(),new Set()]); setRoutePts([[],[],[],[]]); setDrawnOrders([[],[],[],[]]); setMultiResult(null);
    setPostponed(new Map()); setExecutionLog(new Map());
  }

  function computeParams() {
    const { ids: manualIds, unknown } = parseManualIds(manualOrderText, piles);
    setManualWarning(unknown.length ? `No reconocidos: ${unknown.join(", ")}` : "");
    return { manualIds };
  }

  function runSchedule() {
    if (piles.length < 2) { setError("Carga al menos 2 pilotes."); return; }
    setError("");
    const { manualIds } = computeParams();
    const path = buildPath(piles, { startId, dirKey, manualIds, drawnOrder, perDay, bufferDays, radius });
    setResult(scheduleAlongPath(path, { perDay, bufferDays, radius }));
    setAlternatives([]); setActiveAlt(null); setActiveTab("plano"); setPostponed(new Map());
  }

  function generateAlternatives() {
    if (piles.length < 2) { setError("Carga al menos 2 pilotes."); return; }
    setError("");
    const { manualIds } = computeParams();
    const variants = [
      { label: "Tu configuración",              dirKey, startId, manualIds, drawnOrder },
      { label: "Barrido este →",                dirKey: "east",  startId: "", manualIds, drawnOrder: [] },
      { label: "Barrido oeste ←",               dirKey: "west",  startId: "", manualIds, drawnOrder: [] },
      { label: "Barrido norte ↑",               dirKey: "north", startId: "", manualIds, drawnOrder: [] },
      { label: "Barrido sur ↓",                 dirKey: "south", startId: "", manualIds, drawnOrder: [] },
      { label: "Máxima dispersión",             spread: true },
    ];
    const computed = variants.map((v) => {
      let path;
      if (v.spread) {
        const adj = buildConflicts(piles, radius);
        path = [...piles].sort((a, b) => adj.get(b.id).length - adj.get(a.id).length);
      } else {
        path = buildPath(piles, { startId: v.startId, dirKey: v.dirKey, manualIds: v.manualIds, drawnOrder: v.drawnOrder, perDay, bufferDays, radius });
      }
      return { label: v.label, ...scheduleAlongPath(path, { perDay, bufferDays, radius }) };
    });
    const seen = new Set();
    const unique = computed.filter(({ maxDay, avgStep }) => {
      const k = `${maxDay}-${avgStep.toFixed(1)}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    setAlternatives(unique); setActiveAlt(null); setResult(null);
  }

  function chooseAlternative(i) {
    setActiveAlt(i);
    setResult(alternatives[i]);
    setActiveTab("plano");
  }

  // ── multi-machine functions ──────────────────────────────────────────────────

  // Assign all piles matching a prefix to a machine (mass assignment)
  function assignByPrefix(prefix, toMi) {
    if (!prefix.trim()) return;
    const norm = prefix.trim().toLowerCase();
    setMachineGroups(prev => {
      const next = prev.map(s => new Set(s));
      for (const p of piles) {
        if (p.name.toLowerCase().startsWith(norm)) {
          // remove from all machines first
          for (let mi = 0; mi < 4; mi++) next[mi].delete(p.id);
          next[toMi].add(p.id);
        }
      }
      return next;
    });
    setMultiResult(null);
  }

  function clearMachineGroup(mi) {
    setMachineGroups(prev => { const next = prev.map(s=>new Set(s)); next[mi]=new Set(); return next; });
    setMultiResult(null);
  }

  function updateRoutePts(mi, pts) {
    setRoutePts(prev => { const next=[...prev]; next[mi]=pts; return next; });
    setMultiResult(null);
  }

  function runMultiSchedule() {
    if (piles.length < 2) { setError("Carga al menos 2 pilotes."); return; }
    setError(""); setResult(null); setAlternatives([]);

    // Piles not assigned to any machine go to M1
    const allAssigned = new Set([...machineGroups[0],...machineGroups[1],...machineGroups[2],...machineGroups[3]]);
    const unassigned = piles.filter(p => !allAssigned.has(p.id));

    const machineResults = [];
    for (let mi = 0; mi < numMachines; mi++) {
      let machinePiles = piles.filter(p => machineGroups[mi].has(p.id));
      if (mi === 0) machinePiles = [...machinePiles, ...unassigned];
      if (!machinePiles.length) continue;

      // Orden trazado a mano para esta máquina (toque directo sobre sus pilotes,
      // igual que en modo 1 máquina) — el resto se completa con vecino-más-cercano
      // + sesgo direccional + buffer de curado.
      const drawn = drawnOrders[mi] || [];
      const path = buildPath(machinePiles, { startId:"", dirKey:"none", manualIds:[], drawnOrder: drawn, perDay, bufferDays, radius });

      machineResults.push({ ...scheduleAlongPath(path, { perDay, bufferDays, radius }), machineIdx: mi });
    }
    if (!machineResults.length) { setError("Ninguna máquina tiene pilotes. Asigna pilotes usando los prefijos."); return; }
    setMultiResult({ machines: machineResults, projectEnd: Math.max(...machineResults.map(r => r.maxDay)) });
    setActiveTab("plano");
  }

  function updateDrawnOrders(mi, order) {
    setDrawnOrders(prev => { const next=[...prev]; next[mi]=order; return next; });
    setMultiResult(null);
  }

  // Carga una secuencia guardada desde la biblioteca de proyectos
  function handleLoadSequence(snap) {
    if (!snap) return;
    setPiles(snap.piles || []);
    setStartDate(snap.startDate || new Date().toISOString().slice(0,10));
    setSkipSat(snap.skipSat ?? false);
    setSkipSun(snap.skipSun ?? true);
    // Restaurar parámetros de cálculo si estaban guardados
    if (snap.perDay != null)       setPerDay(snap.perDay);
    if (snap.radius != null)       setRadius(snap.radius);
    if (snap.bufferHours != null)  setBufferHours(snap.bufferHours);
    if (snap.numMachines != null)  setNumMachines(snap.numMachines);
    // Restaurar imprevistos: array of [id, info] entries → Map
    if (snap.postponed && Array.isArray(snap.postponed)) {
      setPostponed(new Map(snap.postponed));
    } else {
      setPostponed(new Map());
    }
    if (snap.executionLog && Array.isArray(snap.executionLog)) {
      setExecutionLog(new Map(snap.executionLog));
    } else {
      setExecutionLog(new Map());
    }
    // Restaurar rutas trazadas por máquina
    if (snap.drawnOrders) setDrawnOrders(snap.drawnOrders);
    else setDrawnOrders([[],[],[],[]]);
    // Restaurar asignaciones de máquinas: array of arrays → Set[]
    if (snap.machineGroups) {
      setMachineGroups(snap.machineGroups.map(arr => new Set(arr)));
    } else {
      setMachineGroups([new Set(),new Set(),new Set(),new Set()]);
    }
    setDrawnOrder([]);
    // Deserialize: storage returns plain objects, Maps must be reconstructed
    if (snap.type === "single") {
      setResult(deserializeResult(snap.result));
      setMultiResult(null);
    } else if (snap.type === "multi") {
      setMultiResult(deserializeMultiResult(snap.multiResult));
      setResult(null);
    }
    setAlternatives([]); setActiveAlt(null); setActiveTab("plano");
    const nPostponed = snap.postponed?.length || 0;
    setFileName(snap.piles?.length ? `${snap.piles.length} pilotes (cargado${nPostponed>0?` · ${nPostponed} imprevistos`:""})` : "");
  }

  function applyClaudeChanges(changes) {
    const nameToId = new Map(piles.map(p => [p.name, p.id]));
    setDrawnOrders(prev => {
      const next = prev.map(arr => [...arr]);
      for (const ch of changes) {
        if (ch.type === "reassign") {
          const ids = (ch.pileNames || []).map(n => nameToId.get(n)).filter(Boolean);
          for (const id of ids) {
            for (let mi = 0; mi < 4; mi++) next[mi] = next[mi].filter(x => x !== id);
            const toMi = ch.toMachine ?? 0;
            if (!next[toMi].includes(id)) next[toMi].push(id);
          }
        } else if (ch.type === "reorder") {
          const mi = ch.machineIndex ?? 0;
          const moveId = nameToId.get(ch.moveFirst), beforeId = nameToId.get(ch.before);
          if (moveId && beforeId && next[mi].includes(moveId)) {
            next[mi] = next[mi].filter(x => x !== moveId);
            const idx = next[mi].indexOf(beforeId);
            if (idx >= 0) next[mi].splice(idx, 0, moveId); else next[mi].unshift(moveId);
          }
        }
      }
      return next;
    });
    setMultiResult(null);
  }

  function exportXlsx() {
    const rows = [];
    if (multiResult) {
      multiResult.machines.forEach(m => {
        m.byDay.forEach(({ day, piles: ps }) => {
          const date = getWorkingDate(startDate, day, skipSat, skipSun);
          ps.forEach(p => rows.push({ Maquina: MACHINE_NAMES[m.machineIdx], Dia: day, Fecha: fmtDate(date), Pilote: p.name, X: p.x, Y: p.y }));
        });
      });
    } else if (result) {
      result.byDay.forEach(({ day, piles: ps }) => {
        const date = getWorkingDate(startDate, day, skipSat, skipSun);
        ps.forEach(p => rows.push({ Dia: day, Fecha: fmtDate(date), Pilote: p.name, X: p.x, Y: p.y }));
      });
    }
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 6 }, { wch: 24 }, { wch: 14 }, { wch: 10 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cronograma");
    XLSX.writeFile(wb, "cronograma_fundida_pilotes.xlsx");
  }

  // ─── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="scheduler-root">
      <style>{`
        .scheduler-root {
          --blue-deep: #061F30; --blue-panel: #0C2F45; --blue-line: #1B5A7A;
          --blue-line-soft: rgba(63,150,190,0.2); --cyan: #7FD9F0; --orange: #FF7A3D;
          --ink: #EAF4F8; --ink-dim: #9FC3D4;
          font-family: 'IBM Plex Sans','Archivo',sans-serif;
          background: var(--blue-deep);
          background-image: linear-gradient(var(--blue-line-soft) 1px, transparent 1px),
                            linear-gradient(90deg, var(--blue-line-soft) 1px, transparent 1px);
          background-size: 28px 28px;
          color: var(--ink); min-height: 100%; padding: 24px; border-radius: 6px;
        }
        .mono { font-family: 'IBM Plex Mono','JetBrains Mono',monospace; }
        .stamp { border:2px solid var(--orange); color:var(--orange); border-radius:999px;
          padding:3px 12px; font-size:11px; letter-spacing:.18em; font-weight:700;
          display:inline-block; transform:rotate(0deg); }
        .panel { background:var(--blue-panel); border:1px solid var(--blue-line); border-radius:4px; }
        .field-label { font-size:10px; letter-spacing:.12em; color:var(--ink-dim);
          text-transform:uppercase; font-weight:600; display:flex; align-items:center; gap:4px; }
        input[type=number], input[type=date], input[type=text], select {
          background:var(--blue-deep); border:1px solid var(--blue-line); color:var(--ink);
          border-radius:3px; padding:6px 8px; font-family:'IBM Plex Mono',monospace; width:100%; }
        input[type=range] { width:100%; accent-color:var(--orange); }
        input:focus, select:focus, button:focus-visible { outline:2px solid var(--cyan); outline-offset:1px; }
        .btn-primary { background:var(--orange); color:#241000; font-weight:700; border-radius:3px;
          padding:9px 14px; display:inline-flex; align-items:center; gap:7px; transition:filter .15s; border:none; cursor:pointer; }
        .btn-primary:hover { filter:brightness(1.08); }
        .btn-primary:disabled { opacity:.4; cursor:default; }
        .btn-ghost { background:transparent; border:1px solid var(--blue-line); color:var(--ink);
          border-radius:3px; padding:8px 13px; display:inline-flex; align-items:center; gap:7px; cursor:pointer; }
        .btn-ghost:hover { border-color:var(--cyan); color:var(--cyan); }
        .btn-active { border-color:var(--orange) !important; color:var(--orange) !important; }
        .th { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-dim);
          text-align:left; padding:8px 10px; border-bottom:1px solid var(--blue-line); white-space:nowrap; }
        .td { padding:7px 10px; border-bottom:1px solid var(--blue-line-soft); font-size:13px; }
        .day-chip { display:inline-flex; align-items:center; font-family:'IBM Plex Mono',monospace;
          font-weight:700; font-size:12px; padding:2px 8px; border-radius:3px; }
        .alt-card { background:var(--blue-deep); border:1px solid var(--blue-line); border-radius:4px;
          padding:12px; cursor:pointer; transition:border-color .15s; }
        .alt-card:hover { border-color:var(--cyan); }
        .alt-card.active { border-color:var(--orange); box-shadow:0 0 0 1px var(--orange); }
        .tab { background:transparent; border:none; border-bottom:2px solid transparent;
          color:var(--ink-dim); font-size:12px; letter-spacing:.08em; text-transform:uppercase;
          font-weight:600; padding:8px 14px; cursor:pointer; transition:color .15s,border-color .15s; }
        .tab.active { color:var(--orange); border-bottom-color:var(--orange); }
        .m-tab { background:transparent; border:1px solid var(--blue-line); border-radius:3px;
          color:var(--ink-dim); font-size:11px; font-weight:700; padding:5px 11px; cursor:pointer; transition:all .15s; }
        .hidden { display:none; }
      `}</style>

      {/* ── header */}
      <div className="mb-5">
        <span className="stamp mono">PLANO DE OBRA · SECUENCIA DE FUNDIDA</span>
        <h1 className="text-2xl font-bold mt-3">Planeador de fundida de pilotes</h1>
        <p className="text-sm mt-1" style={{ color:"var(--ink-dim)", maxWidth:600 }}>
          Define la ruta dibujando sobre el mapa, elige dirección de avance y genera el cronograma
          óptimo respetando las restricciones de curado.
        </p>
      </div>

      <div className="grid gap-5" style={{ gridTemplateColumns:"290px 1fr" }}>

        {/* ── left panel */}
        <div className="flex flex-col gap-4">

          {/* rules */}
          <div className="panel p-4">
            <div className="field-label mb-3"><Settings2 size={13} /> Reglas del vaciado</div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="field-label">Pilotes por día</label>
                <input type="number" min={1} value={perDay} onChange={(e) => setPerDay(Math.max(1,+e.target.value||1))} />
              </div>
              <div>
                <label className="field-label">Radio de exclusión (m)</label>
                <input type="number" min={0} value={radius} onChange={(e) => setRadius(Math.max(0,parseFloat(e.target.value)||0))} />
              </div>
              <div>
                <label className="field-label">Espera mínima (horas)</label>
                <input type="number" min={1} value={bufferHours} onChange={(e) => setBufferHours(Math.max(1,+e.target.value||1))} />
                <p className="mono text-xs mt-1" style={{ color:"var(--ink-dim)" }}>≈ {bufferDays} día(s) entre fundidas dentro del radio</p>
              </div>
              <div>
                <label className="field-label">Fecha de inicio</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1 mt-1">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={skipSat} onChange={(e) => setSkipSat(e.target.checked)} style={{ width:"auto" }} />
                  No programar sábados
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={skipSun} onChange={(e) => setSkipSun(e.target.checked)} style={{ width:"auto" }} />
                  No programar domingos
                </label>
              </div>
            </div>
          </div>

          {/* sequence config */}
          <div className="panel p-4">
            <div className="field-label mb-3">Secuencia constructiva</div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="field-label">Pilote inicial</label>
                <select value={startId} onChange={(e) => setStartId(e.target.value)} disabled={!piles.length}>
                  <option value="">Automático (según dirección)</option>
                  {piles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Dirección de avance</label>
                <select value={dirKey} onChange={(e) => setDirKey(e.target.value)}>
                  {Object.entries(DIRECTIONS).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Orden forzado por proceso constructivo</label>
                <input type="text" placeholder="Ej: P-01, P-02, P-05" value={manualOrderText}
                  onChange={(e) => setManualOrderText(e.target.value)} />
                <p className="mono text-xs mt-1" style={{ color:"var(--ink-dim)" }}>
                  Nombres separados por coma. El resto se completa automáticamente.
                </p>
                {manualWarning && <p className="text-xs mt-1" style={{ color:"var(--orange)" }}>{manualWarning}</p>}
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={drawMode} onChange={(e) => setDrawMode(e.target.checked)} style={{ width:"auto" }} />
                  Activar puntero de ruta en el mapa
                </label>
                {drawnOrder.length > 0 && (
                  <p className="mono text-xs mt-1" style={{ color:"var(--cyan)" }}>
                    ✓ {drawnOrder.length} pilotes trazados
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── MÁQUINAS: asignación por prefijo + puntero de ruta ─────── */}
          <div className="panel p-4" style={{ borderColor:"var(--cyan)" }}>
            <div className="field-label mb-3" style={{ color:"var(--cyan)" }}>Máquinas piloteadoras</div>
            <div className="flex gap-2 mb-3">
              {[1,2,3,4].map(n => (
                <button key={n} onClick={() => { setNumMachines(n); setMultiResult(null); }} className="m-tab"
                  style={{ borderColor: numMachines===n ? MACHINE_COLORS[n-1] : "var(--blue-line)", color: numMachines===n ? MACHINE_COLORS[n-1] : "var(--ink-dim)", background: numMachines===n ? `${MACHINE_COLORS[n-1]}15` : "transparent" }}>
                  {n} {n===1?"máq":"máqs"}
                </button>
              ))}
            </div>

            {numMachines > 1 && piles.length > 0 && (<>
              {/* STEP 1: Assign by prefix */}
              <div className="field-label mb-2" style={{color:"var(--ink-dim)"}}>① Asignación masiva por prefijo</div>
              {Array.from({length:numMachines},(_,mi)=>(
                <MachineAssignRow key={mi} mi={mi} piles={piles} machineGroups={machineGroups}
                  onAssign={assignByPrefix} onClear={clearMachineGroup}/>
              ))}

              {/* Unassigned count */}
              {(()=>{
                const assigned=new Set([...machineGroups[0],...machineGroups[1],...machineGroups[2],...machineGroups[3]]);
                const unassigned=piles.filter(p=>!assigned.has(p.id)).length;
                return unassigned>0&&<p className="mono text-xs mt-2" style={{color:"var(--orange)"}}>⚠ {unassigned} pilotes sin asignar → irán a M1</p>;
              })()}

              {/* STEP 2: Route drawing */}
              <div className="field-label mb-2 mt-3" style={{color:"var(--ink-dim)"}}>② Puntero de ruta (opcional)</div>
              <div className="flex gap-2 flex-wrap mb-1">
                {Array.from({length:numMachines},(_,mi)=>(
                  <button key={mi} onClick={()=>{setActiveMachine(mi);setDrawMode(true);}} className="m-tab"
                    style={{ borderColor: activeMachine===mi&&drawMode ? MACHINE_COLORS[mi] : "var(--blue-line)", color: activeMachine===mi&&drawMode ? MACHINE_COLORS[mi] : "var(--ink-dim)", background: activeMachine===mi&&drawMode ? `${MACHINE_COLORS[mi]}18` : "transparent" }}>
                    M{mi+1} {drawnOrders[mi]?.length>0?"✓":""}
                  </button>
                ))}
                <label className="flex items-center gap-2 text-xs" style={{color:"var(--ink-dim)"}}>
                  <input type="checkbox" checked={drawMode} onChange={e=>setDrawMode(e.target.checked)} style={{width:"auto"}}/>
                  Mostrar puntero
                </label>
              </div>
              <p className="mono text-xs" style={{color:"var(--ink-dim)",lineHeight:1.5}}>
                Dibuja la dirección de avance preferida. El algoritmo calcula la secuencia óptima respetando todas las reglas.
              </p>
            </>)}
          </div>

          {/* file */}
          <div className="panel p-4">
            <div className="field-label mb-3">Datos de pilotes</div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" id="pile-file" />
            <label htmlFor="pile-file" className="btn-ghost w-full justify-center cursor-pointer mb-2">
              <Upload size={14} /> Subir Excel (.xlsx)
            </label>
            <button onClick={loadDemo} className="btn-ghost w-full justify-center mb-2">
              <PlayCircle size={14} /> Datos de ejemplo
            </button>
            {piles.length > 0 && (
              <button onClick={reset} className="btn-ghost w-full justify-center" style={{ color:"var(--ink-dim)" }}>
                <RotateCcw size={13} /> Limpiar
              </button>
            )}
            <p className="mono text-xs mt-3" style={{ color:"var(--ink-dim)" }}>
              Columnas: nombre/pilote, X, Y (o Este/Norte).
            </p>
            {fileName && (
              <p className="mono text-xs mt-2 flex items-center gap-1" style={{ color:"var(--cyan)" }}>
                <CheckCircle2 size={12} /> {fileName} · {piles.length} pilotes
              </p>
            )}
            {error && (
              <p className="text-xs mt-2 flex items-start gap-1" style={{ color:"var(--orange)" }}>
                <AlertTriangle size={12} style={{ marginTop:2, flexShrink:0 }} /> {error}
              </p>
            )}
          </div>

          <button onClick={runSchedule} className="btn-primary justify-center" disabled={piles.length < 2}>
            <PlayCircle size={15} /> Calcular esta secuencia
          </button>
          <button onClick={generateAlternatives} className="btn-ghost justify-center" disabled={piles.length < 2}>
            <Layers size={14} /> Generar alternativas
          </button>
          {numMachines > 1 && (
            <button onClick={runMultiSchedule} className="btn-primary justify-center" disabled={piles.length < 2}
              style={{ background: MACHINE_COLORS[0] }}>
              <PlayCircle size={15} /> Calcular {numMachines} máquinas
            </button>
          )}
          {(result || multiResult) && (
            <button onClick={exportXlsx} className="btn-ghost justify-center">
              <Download size={14} /> Exportar cronograma (.xlsx)
            </button>
          )}
        </div>

        {/* ── right panel */}
        <div className="flex flex-col gap-5">

          {/* drawing canvas when no result yet OR draw mode active */}
          {piles.length > 0 && mapGeom && drawMode && numMachines === 1 && (
            <div className="panel p-4">
              <DrawingCanvas
                piles={piles}
                mapGeom={mapGeom}
                radius={radius}
                onOrderChange={setDrawnOrder}
              />
            </div>
          )}
          {piles.length > 0 && mapGeom && drawMode && numMachines > 1 && (
            <div className="panel p-4">
              <MachineDrawingCanvas
                allPiles={piles}
                mapGeom={mapGeom}
                machineIdx={activeMachine}
                machineGroups={machineGroups}
                drawnOrder={drawnOrders[activeMachine] || []}
                onOrderChange={updateDrawnOrders}
              />
            </div>
          )}

          {/* empty state */}
          {!result && !alternatives.length && !drawMode && (
            <div className="panel p-10 flex flex-col items-center justify-center text-center" style={{ minHeight:280 }}>
              <p className="mono text-sm" style={{ color:"var(--ink-dim)" }}>
                {piles.length
                  ? `${piles.length} pilotes cargados — calcula una secuencia o activa el puntero de ruta.`
                  : "Carga un archivo Excel o usa los datos de ejemplo para comenzar."}
              </p>
            </div>
          )}

          {/* alternatives */}
          {alternatives.length > 0 && !result && (
            <div className="panel p-4">
              <div className="field-label mb-3">Alternativas generadas — elige la que prefieras</div>
              <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(auto-fill, minmax(210px, 1fr))" }}>
                {alternatives.map((alt, i) => (
                  <div key={i} className={`alt-card${activeAlt === i ? " active" : ""}`} onClick={() => chooseAlternative(i)}>
                    <div className="text-sm font-bold mb-2">{alt.label}</div>
                    <div className="flex justify-between mono text-xs mb-1">
                      <span style={{ color:"var(--ink-dim)" }}>Días de obra</span>
                      <span style={{ color:"var(--orange)", fontWeight:700 }}>{alt.maxDay}</span>
                    </div>
                    <div className="flex justify-between mono text-xs mb-3">
                      <span style={{ color:"var(--ink-dim)" }}>Paso promedio</span>
                      <span>{alt.avgStep.toFixed(1)} m</span>
                    </div>
                    <div className="btn-ghost w-full justify-center text-xs" style={{ padding:"5px 8px" }}>
                      <Check size={11} /> Usar esta
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* result */}
          {result && (
            <>
              {alternatives.length > 0 && (
                <button className="btn-ghost self-start" onClick={() => setResult(null)}>← Volver a las alternativas</button>
              )}

              {/* KPIs */}
              <div className="grid grid-cols-3 gap-3">
                <div className="panel p-3">
                  <div className="field-label">Pilotes</div>
                  <div className="text-2xl font-bold mono mt-1">{piles.length}</div>
                </div>
                <div className="panel p-3">
                  <div className="field-label">Días de obra</div>
                  <div className="text-2xl font-bold mono mt-1" style={{ color:"var(--orange)" }}>{result.maxDay}</div>
                </div>
                <div className="panel p-3">
                  <div className="field-label">Fecha estimada cierre</div>
                  <div className="text-sm font-bold mono mt-2">
                    {fmtDate(getWorkingDate(startDate, result.maxDay, skipSat, skipSun))}
                  </div>
                </div>
              </div>

              {/* tabs — sin pestaña Medición (integrada en plano con botón) */}
              <div style={{ borderBottom:"1px solid var(--blue-line)", display:"flex", gap:0, flexWrap:"wrap" }}>
                {[
                  { key:"plano",      label:"Plano general" },
                  { key:"sim",        label:"▶ Simulación" },
                  { key:"tabla",      label:"Cronograma" + (postponed.size > 0 ? " ⚠" : "") },
                  { key:"imprevistos",label:"⚠ Imprevistos" + (postponed.size > 0 ? ` (${postponed.size})` : "") },
                  { key:"registro",   label:"📝 Registro" + (executionLog.size > 0 ? ` (${[...executionLog.values()].filter(e=>e.done).length}/${piles.length})` : "") },
                ].map((t) => (
                  <button key={t.key} className={`tab${activeTab === t.key ? " active" : ""}`}
                    style={ t.key === "imprevistos" && postponed.size > 0 ? { color:"var(--orange)", borderBottomColor: activeTab === t.key ? "var(--orange)" : "transparent" }
                          : t.key === "registro" && executionLog.size > 0 ? { color:"var(--cyan)" } : {} }
                    onClick={() => setActiveTab(t.key)}>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* plano — medición integrada con botón */}
              {activeTab === "plano" && mapGeom && (
                <PlanViewSingle result={result} piles={piles} mapGeom={mapGeom} radius={radius}
                  adjustedResult={adjustedResult} postponed={postponed}/>
              )}

              {/* simulación — usa effectiveResult si hay imprevistos */}
              {activeTab === "sim" && mapGeom && (
                <NavisworksPlayer
                  result={effectiveResult}
                  mapGeom={mapGeom}
                  radius={radius}
                  startDate={startDate}
                  skipSat={skipSat}
                  skipSun={skipSun}
                  allPiles={piles}
                />
              )}

              {/* imprevistos — pestaña propia */}
              {activeTab === "imprevistos" && (
                <PostponePanel
                  result={result}
                  piles={piles}
                  startDate={startDate}
                  skipSat={skipSat}
                  skipSun={skipSun}
                  perDay={perDay}
                  bufferDays={bufferDays}
                  radius={radius}
                  postponed={postponed}
                  onPostponedChange={setPostponed}
                  mapGeom={mapGeom}
                  adjustedResult={adjustedResult}
                />
              )}

              {/* tabla — usa effectiveResult si hay imprevistos */}
              {activeTab === "tabla" && (
                <div className="flex flex-col gap-4">
                  {postponed.size > 0 && (
                    <div className="panel p-3" style={{borderColor:"var(--orange)"}}>
                      <span className="mono text-xs" style={{color:"var(--orange)"}}>
                        ⚠ Mostrando cronograma ajustado por {postponed.size} imprevisto(s) — ve a la pestaña "⚠ Imprevistos" para gestionarlos
                      </span>
                    </div>
                  )}
                  {/* Gantt */}
                  <div className="panel p-4">
                    <div className="field-label mb-2">Diagrama de Gantt · Máquina 1</div>
                    <GanttChart
                      machines={[{...effectiveResult, machineIdx:0}]}
                      startDate={startDate} skipSat={skipSat} skipSun={skipSun}
                      projectEnd={effectiveResult.maxDay}/>
                  </div>
                  {/* Schedule table */}
                  <div className="panel p-4">
                    <div className="field-label mb-3">Cronograma por día</div>
                    <div style={{ overflowX:"auto" }}>
                      <table style={{ width:"100%", borderCollapse:"collapse" }}>
                        <thead>
                          <tr>
                            <th className="th">Día</th>
                            <th className="th">Fecha</th>
                            <th className="th">Pilotes a fundir</th>
                            <th className="th">Coordenadas (X, Y)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {effectiveResult.byDay.map(({ day, piles: ps }) => {
                            const date = getWorkingDate(startDate, day, skipSat, skipSun);
                            const hasPostp = ps.some(p => postponed.has(p.id));
                            return (
                              <tr key={day} style={{background: hasPostp ? "rgba(127,217,240,0.04)" : "transparent"}}>
                                <td className="td">
                                  <span className="day-chip" style={{ background:colorForDay(day), color:"#061F30" }}>{day}</span>
                                </td>
                                <td className="td mono">{fmtDate(date)}</td>
                                <td className="td mono">
                                  {ps.map((p) => {
                                    const inf = postponed.get(p.id);
                                    if (inf && inf.rescheduleDate) return <span key={p.id} style={{color:"var(--cyan)",marginRight:4}}>↩{p.name}</span>;
                                    return <span key={p.id} style={{marginRight:4}}>{p.name}</span>;
                                  })}
                                </td>
                                <td className="td mono" style={{ color:"var(--ink-dim)" }}>
                                  {ps.map((p) => `(${p.x}, ${p.y})`).join("  ")}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* registro de ejecución */}
              {activeTab === "registro" && (
                <PileExecutionLog
                  piles={piles}
                  result={result}
                  multiResult={null}
                  startDate={startDate}
                  skipSat={skipSat}
                  skipSun={skipSun}
                  executionLog={executionLog}
                  onLogChange={setExecutionLog}
                />
              )}

              <p className="mono text-xs" style={{ color:"var(--ink-dim)" }}>
                Nota: el conteo de días de espera se hace en días de obra consecutivos.
                Si tu jornada no cubre 24 h corridas, ajusta el número de días de espera.
              </p>
            </>
          )}

          {/* ── MULTI-MACHINE RESULT ───────────────────────────────────── */}
          {multiResult && (
            <>
              <div className="grid gap-3" style={{gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))"}}>
                <div className="panel p-3"><div className="field-label">Total pilotes</div><div className="text-2xl font-bold mono mt-1">{piles.length}</div></div>
                <div className="panel p-3"><div className="field-label">Fin del proyecto</div><div className="text-2xl font-bold mono mt-1" style={{color:"var(--orange)"}}>{multiResult.projectEnd} días</div></div>
                <div className="panel p-3"><div className="field-label">Fecha cierre</div><div className="text-sm font-bold mono mt-2">{fmtDate(getWorkingDate(startDate,multiResult.projectEnd,skipSat,skipSun))}</div></div>
                {multiResult.machines.map(m => (
                  <div key={m.machineIdx} className="panel p-3" style={{borderColor:MACHINE_COLORS[m.machineIdx]}}>
                    <div className="field-label" style={{color:MACHINE_COLORS[m.machineIdx]}}>M{m.machineIdx+1} recorrido</div>
                    <div className="mono text-lg font-bold mt-1" style={{color:MACHINE_COLORS[m.machineIdx]}}>{m.totalDist.toFixed(1)} m</div>
                    <div className="mono text-xs" style={{color:"var(--ink-dim)"}}>{m.path.length} pilotes · {m.maxDay} días</div>
                  </div>
                ))}
              </div>

              {multiResult.machines.some(m => m.maxDay < multiResult.projectEnd) && (
                <div className="panel p-3" style={{borderColor:"var(--cyan)"}}>
                  <div className="field-label mb-2" style={{color:"var(--cyan)"}}>⚡ Liberación anticipada de máquinas</div>
                  {multiResult.machines.filter(m => m.maxDay < multiResult.projectEnd).map(m => (
                    <p key={m.machineIdx} className="mono text-xs" style={{color:"var(--ink-dim)"}}>
                      <span style={{color:MACHINE_COLORS[m.machineIdx]}}>● {MACHINE_NAMES[m.machineIdx]}</span> termina en el día <strong>{m.maxDay}</strong> — puede reasignarse con el asistente Claude.
                    </p>
                  ))}
                </div>
              )}

              <div style={{borderBottom:"1px solid var(--blue-line)",display:"flex",gap:0,flexWrap:"wrap"}}>
                {[
                  {key:"plano",       label:"Plano general"},
                  {key:"sim",         label:"▶ Simulación"},
                  {key:"tabla",       label:"Cronograma" + (postponed.size > 0 ? " ⚠" : "")},
                  {key:"imprevistos", label:"⚠ Imprevistos" + (postponed.size > 0 ? ` (${postponed.size})` : "")},
                  {key:"registro",    label:"📝 Registro" + (executionLog.size > 0 ? ` (${[...executionLog.values()].filter(e=>e.done).length}/${piles.length})` : "")},
                ].map(t => (
                  <button key={t.key}
                    className={`tab${activeTab===t.key?" active":""}`}
                    style={t.key==="imprevistos" && postponed.size > 0 ? {color:"var(--orange)", borderBottomColor: activeTab===t.key ? "var(--orange)" : "transparent"}
                          : t.key==="registro" && executionLog.size > 0 ? {color:"var(--cyan)"} : {}}
                    onClick={() => setActiveTab(t.key)}>{t.label}</button>
                ))}
              </div>

              {activeTab==="plano" && mapGeom && (
                <PlanViewMulti machines={multiResult.machines} piles={piles} mapGeom={mapGeom} radius={radius} postponed={postponed}/>
              )}

              {activeTab==="sim" && mapGeom && (
                <MultiNavisworksPlayer machineResults={multiResult.machines} mapGeom={mapGeom} radius={radius} startDate={startDate} skipSat={skipSat} skipSun={skipSun} allPiles={piles}/>
              )}

              {/* imprevistos multi-máquina */}
              {activeTab==="imprevistos" && multiResult.machines.length > 0 && (() => {
                const allPath = multiResult.machines.flatMap(m => m.path);
                const allDayOf = new Map();
                multiResult.machines.forEach(m => { m.dayOf.forEach((d, id) => allDayOf.set(id, d)); });
                const allMaxDay = multiResult.projectEnd;
                const allByDay = [];
                for (let d = 1; d <= allMaxDay; d++) {
                  const ps = allPath.filter(p => allDayOf.get(p.id) === d);
                  if (ps.length) allByDay.push({ day: d, piles: ps });
                }
                const syntheticResult = { path: allPath, dayOf: allDayOf, maxDay: allMaxDay, byDay: allByDay };
                return (
                  <PostponePanel
                    result={syntheticResult}
                    piles={piles}
                    startDate={startDate}
                    skipSat={skipSat}
                    skipSun={skipSun}
                    perDay={perDay}
                    bufferDays={bufferDays}
                    radius={radius}
                    postponed={postponed}
                    onPostponedChange={setPostponed}
                    mapGeom={mapGeom}
                    adjustedResult={null}
                  />
                );
              })()}

              {activeTab==="tabla" && (
                <div className="flex flex-col gap-4">
                  {postponed.size > 0 && (
                    <div className="panel p-3" style={{borderColor:"var(--orange)"}}>
                      <span className="mono text-xs" style={{color:"var(--orange)"}}>
                        ⚠ {postponed.size} imprevisto(s) registrados — los pilotes reprogramados aparecen marcados con ↩
                      </span>
                    </div>
                  )}
                  {/* Gantt de todas las máquinas */}
                  <div className="panel p-4">
                    <div className="field-label mb-2">Diagrama de Gantt · Simultaniedad de máquinas</div>
                    <GanttChart
                      machines={multiResult.machines}
                      startDate={startDate} skipSat={skipSat} skipSun={skipSun}
                      projectEnd={multiResult.projectEnd}/>
                  </div>
                  {/* Tablas individuales por máquina */}
                  {multiResult.machines.map(m => {
                    const col = MACHINE_COLORS[m.machineIdx];
                    return (
                      <div key={m.machineIdx} className="panel p-4" style={{borderColor:col}}>
                        <div className="field-label mb-3" style={{color:col}}>● {MACHINE_NAMES[m.machineIdx]} — {m.path.length} pilotes · {m.maxDay} días · {m.totalDist.toFixed(1)} m</div>
                        <div style={{overflowX:"auto"}}>
                          <table style={{width:"100%",borderCollapse:"collapse"}}>
                            <thead><tr><th className="th">Día</th><th className="th">Fecha</th><th className="th">Pilotes</th><th className="th">Coordenadas (X, Y)</th></tr></thead>
                            <tbody>
                              {m.byDay.map(({day,piles:ps}) => {
                                const date=getWorkingDate(startDate,day,skipSat,skipSun);
                                const hasPostp = ps.some(p=>postponed.has(p.id));
                                return (<tr key={day} style={{background:hasPostp?"rgba(127,217,240,0.04)":"transparent"}}>
                                  <td className="td"><span className="day-chip" style={{background:col,color:"#061F30"}}>{day}</span></td>
                                  <td className="td mono" style={{fontSize:12}}>{fmtDate(date)}</td>
                                  <td className="td mono" style={{fontSize:12}}>
                                    {ps.map(p=>{
                                      const inf=postponed.get(p.id);
                                      if(inf&&inf.rescheduleDate) return <span key={p.id} style={{color:"var(--cyan)",marginRight:4}}>↩{p.name}</span>;
                                      return <span key={p.id} style={{marginRight:4}}>{p.name}</span>;
                                    })}
                                  </td>
                                  <td className="td mono" style={{fontSize:11,color:"var(--ink-dim)"}}>{ps.map(p=>`(${p.x}, ${p.y})`).join("  ")}</td>
                                </tr>);
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {activeTab==="registro" && (
                <PileExecutionLog
                  piles={piles}
                  result={null}
                  multiResult={multiResult}
                  startDate={startDate}
                  skipSat={skipSat}
                  skipSun={skipSun}
                  executionLog={executionLog}
                  onLogChange={setExecutionLog}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Biblioteca de proyectos — siempre visible */}
      <ProjectLibrary
        currentResult={result}
        currentMultiResult={multiResult}
        currentPiles={piles}
        startDate={startDate}
        skipSat={skipSat}
        skipSun={skipSun}
        currentPostponed={postponed}
        currentPerDay={perDay}
        currentRadius={radius}
        currentBufferHours={bufferHours}
        currentNumMachines={numMachines}
        currentMachineGroups={machineGroups}
        currentDrawnOrders={drawnOrders}
        currentExecutionLog={executionLog}
        onLoadSequence={handleLoadSequence}
      />

      {/* Claude Chat — visible when piles are loaded */}
      {piles.length > 0 && (
        <ClaudeChat piles={piles} drawnOrders={drawnOrders} numMachines={numMachines} onApplyChanges={applyClaudeChanges}/>
      )}
    </div>
  );
}

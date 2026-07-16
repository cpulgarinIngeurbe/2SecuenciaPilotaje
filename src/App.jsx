import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  Upload, Download, AlertTriangle, CheckCircle2, Settings2,
  PlayCircle, RotateCcw, Layers, Check, Pencil, Trash2,
  ChevronLeft, ChevronRight, SkipBack, SkipForward
} from "lucide-react";

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

function buildPath(piles, { startId, dirKey, manualIds, drawnOrder }) {
  const remaining = new Map(piles.map((p) => [p.id, p]));
  const path = [];
  const vec = DIRECTIONS[dirKey]?.vec || null;

  for (const id of manualIds || []) {
    if (remaining.has(id)) { path.push(remaining.get(id)); remaining.delete(id); }
  }

  if (drawnOrder && drawnOrder.length) {
    for (const id of drawnOrder) {
      if (remaining.has(id)) { path.push(remaining.get(id)); remaining.delete(id); }
    }
  }

  if (!path.length) {
    const start = (startId && remaining.get(startId)) || startForDirection([...remaining.values()], dirKey);
    path.push(start);
    remaining.delete(start.id);
  }

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
      if (score < bestScore) { bestScore = score; best = p; }
    }
    path.push(best);
    remaining.delete(best.id);
  }
  return path;
}

function scheduleAlongPath(orderedPiles, { perDay, bufferDays, radius }) {
  const adj = buildConflicts(orderedPiles, radius);
  const dayOf = new Map();
  const perDayCount = new Map();

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

  const maxDay = Math.max(...[...dayOf.values()]);
  const byDay = [];
  for (let d = 1; d <= maxDay; d++) {
    const ps = orderedPiles.filter((p) => dayOf.get(p.id) === d);
    if (ps.length) byDay.push({ day: d, piles: ps });
  }

  const consecutive = [];
  for (let i = 0; i < orderedPiles.length - 1; i++)
    consecutive.push(dist(orderedPiles[i], orderedPiles[i + 1]));
  const avgStep = consecutive.length
    ? consecutive.reduce((a, b) => a + b, 0) / consecutive.length : 0;
  const totalDist = consecutive.reduce((a, b) => a + b, 0);

  return { byDay, dayOf, maxDay, conflicts: adj, avgStep, totalDist, path: orderedPiles };
}

function getWorkingDate(startDateStr, wdIndex, skipSat, skipSun) {
  let d = new Date(startDateStr + "T00:00:00");
  let count = 0;
  for (let i = 0; i < 10000; i++) {
    const dow = d.getDay();
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
  "#a2c617","#dba444","#6aa0ac","#dde387","#81398d",
  "#758b29","#4a5720","#dba444","#6aa0ac","#dde387",
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
    nameIdx: find([/pilote/, /^nombre$/, /^id$/, /^numero$/, /^n[uú]mero$/, /^n°$/]),
    xIdx:    find([/^x$/, /este/, /easting/]),
    yIdx:    find([/^y$/, /norte/, /northing/]),
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

// ─── DrawingCanvas ─────────────────────────────────────────────────────────────

function DrawingCanvas({ piles, mapGeom, radius, onOrderChange }) {
  const svgRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [stroke, setStroke] = useState([]);
  const [ordered, setOrdered] = useState([]);

  function svgPoint(e) {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scaleX = mapGeom.W / rect.width;
    const scaleY = mapGeom.H / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { cx: (clientX - rect.left) * scaleX, cy: (clientY - rect.top) * scaleY };
  }

  function startDraw(e) {
    e.preventDefault();
    setDrawing(true);
    const pt = svgPoint(e);
    if (pt) setStroke([pt]);
  }

  function moveDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    const pt = svgPoint(e);
    if (!pt) return;
    setStroke((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.hypot(pt.cx - last.cx, pt.cy - last.cy) < 6) return prev;
      return [...prev, pt];
    });
  }

  function endDraw() {
    if (!drawing) return;
    setDrawing(false);
    if (!stroke.length || !mapGeom) return;

    const PIX_THRESHOLD = 30;
    const touched = [];
    const seenIds = new Set();
    for (const pt of stroke) {
      let bestId = null, bestD = Infinity;
      for (const p of piles) {
        const { cx, cy } = mapGeom.toSvg(p);
        const d = Math.hypot(pt.cx - cx, pt.cy - cy);
        if (d < PIX_THRESHOLD && d < bestD) { bestD = d; bestId = p.id; }
      }
      if (bestId && !seenIds.has(bestId)) { seenIds.add(bestId); touched.push(bestId); }
    }
    setOrdered(touched);
    onOrderChange(touched);
  }

  function clearDraw() {
    setStroke([]);
    setOrdered([]);
    onOrderChange([]);
  }

  const pilesById = useMemo(() => new Map(piles.map((p) => [p.id, p])), [piles]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className="field-label flex items-center gap-1"><Pencil size={12} /> Puntero de ruta — dibuja el camino preferido sobre el plano</span>
        <button onClick={clearDraw} className="btn-ghost text-xs" style={{ padding: "4px 10px" }}>
          <Trash2 size={12} /> Limpiar trazo
        </button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${mapGeom.W} ${mapGeom.H}`}
        width="100%"
        style={{ background: "#f9fbe7", borderRadius: 3, cursor: drawing ? "crosshair" : "pointer", touchAction: "none", border:"1px solid #d8e8a0" }}
        onMouseDown={startDraw}
        onMouseMove={moveDraw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={moveDraw}
        onTouchEnd={endDraw}
      >
        {piles.map((p) => {
          const { cx, cy } = mapGeom.toSvg(p);
          const idx = ordered.indexOf(p.id);
          const hit = idx !== -1;
          return (
            <g key={p.id}>
              <circle cx={cx} cy={cy} r={radius * mapGeom.scale} fill="none" stroke="#758b29" strokeOpacity="0.2" strokeDasharray="3 3" />
              <circle cx={cx} cy={cy} r={8} fill={hit ? "#a2c617" : "#ffffff"} stroke={hit ? "#758b29" : "#758b29"} strokeWidth="1.5" />
              {hit && (
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize="9" fontWeight="700" fill="#1a1a1f" fontFamily="IBM Plex Mono, monospace">
                  {idx + 1}
                </text>
              )}
              <text x={cx} y={cy - 12} textAnchor="middle" fontSize="9" fill="var(--ink-dim)" fontFamily="IBM Plex Mono, monospace">{p.name}</text>
            </g>
          );
        })}
        {stroke.length > 1 && (
          <polyline
            points={stroke.map((pt) => `${pt.cx},${pt.cy}`).join(" ")}
            fill="none" stroke="var(--orange)" strokeWidth="2.5" strokeOpacity="0.7"
            strokeLinecap="round" strokeLinejoin="round"
          />
        )}
      </svg>
      {ordered.length > 0 && (
        <p className="mono text-xs mt-2" style={{ color: "var(--cyan)" }}>
          ✓ {ordered.length} pilotes detectados en el trazo — el resto se completa con el algoritmo.
        </p>
      )}
      {ordered.length === 0 && (
        <p className="mono text-xs mt-2" style={{ color: "var(--ink-dim)" }}>
          Mantén pulsado y arrastra sobre el mapa para trazar la ruta deseada.
        </p>
      )}
    </div>
  );
}

// ─── Navisworks-style simulation ──────────────────────────────────────────────

function NavisworksPlayer({ result, mapGeom, radius, startDate, skipSat, skipSun }) {
  const [simDay, setSimDay] = useState(1);
  const [playing, setPlaying] = useState(false);
  const intervalRef = useRef(null);

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

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <div className="field-label mb-1">Simulación constructiva · estilo Navisworks</div>
          <div className="mono text-sm font-bold" style={{ color: "var(--orange)" }}>
            Día {simDay} / {result.maxDay} &nbsp;·&nbsp; {fmtDate(date)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => { setPlaying(false); setSimDay(1); }}><SkipBack size={14} /></button>
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => setSimDay((d) => Math.max(1, d - 1))}><ChevronLeft size={14} /></button>
          <button className="btn-primary" style={{ padding: "7px 16px" }} onClick={() => setPlaying((p) => !p)}>
            {playing ? "⏸ Pausar" : "▶ Play"}
          </button>
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => setSimDay((d) => Math.min(result.maxDay, d + 1))}><ChevronRight size={14} /></button>
          <button className="btn-ghost" style={{ padding: "6px 10px" }} onClick={() => { setPlaying(false); setSimDay(result.maxDay); }}><SkipForward size={14} /></button>
        </div>
      </div>

      <input
        type="range" min={1} max={result.maxDay} value={simDay}
        onChange={(e) => { setPlaying(false); setSimDay(Number(e.target.value)); }}
        style={{ width: "100%", accentColor: "var(--orange)", marginBottom: 12 }}
      />

      <svg viewBox={`0 0 ${mapGeom.W} ${mapGeom.H}`} width="100%"
        style={{ background: "#f9fbe7", borderRadius: 3, border:"1px solid #d8e8a0" }}>
        {piles.map((p) => {
          const { cx, cy } = mapGeom.toSvg(p);
          const isToday = todayPiles.has(p.id);
          const isDone  = donePiles.has(p.id);

          const fill   = isToday ? colorForDay(simDay) : isDone ? "#3A4A52" : "#1B3A4A";
          const stroke = isToday ? colorForDay(simDay) : isDone ? "#2A3A42" : "#2A4A5A";
          const textC  = isToday ? "#1a1a1f" : isDone ? "#607080" : "#4A7090";
          const r      = radius * mapGeom.scale;

          return (
            <g key={p.id}>
              {isToday && (
                <>
                  <circle cx={cx} cy={cy} r={r} fill={colorForDay(simDay)} fillOpacity="0.12" stroke={colorForDay(simDay)} strokeOpacity="0.5" strokeDasharray="4 3" strokeWidth="1" />
                  <circle cx={cx} cy={cy} r={12} fill="none" stroke={colorForDay(simDay)} strokeOpacity="0.4" strokeWidth="3">
                    <animate attributeName="r" values="10;20;10" dur="1.4s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="1.4s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
              {isDone && (
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2A3A42" strokeDasharray="3 3" strokeWidth="0.8" />
              )}
              <circle cx={cx} cy={cy} r={8} fill={fill} stroke={stroke} strokeWidth={isToday ? 2 : 1} />
              <text x={cx} y={cy - 12} textAnchor="middle" fontSize="9" fill={textC} fontFamily="IBM Plex Mono, monospace">
                {p.name}
              </text>
              <text x={cx} y={cy + 3} textAnchor="middle" fontSize="8" fontWeight="700" fill={isToday ? "#1a1a1f" : textC} fontFamily="IBM Plex Mono, monospace">
                {isDone ? "✓" : isToday ? "HOY" : ""}
              </text>
            </g>
          );
        })}
      </svg>

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

// ─── MeasureTool (cota manual) ────────────────────────────────────────────────

function MeasureTool({ piles, mapGeom }) {
  const svgRef = useRef(null);
  const [points, setPoints] = useState([]); // [{x,y,cx,cy,label}] model coords
  const [hover, setHover] = useState(null); // {cx,cy} SVG coords

  function svgPt(e) {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scaleX = mapGeom.W / rect.width;
    const scaleY = mapGeom.H / rect.height;
    return {
      cx: (e.clientX - rect.left) * scaleX,
      cy: (e.clientY - rect.top)  * scaleY,
    };
  }

  function snapToPile(cx, cy) {
    // snap to nearest pile within 22px SVG
    let best = null, bestD = Infinity;
    for (const p of piles) {
      const { cx: px, cy: py } = mapGeom.toSvg(p);
      const d = Math.hypot(cx - px, cy - py);
      if (d < 22 && d < bestD) { bestD = d; best = p; }
    }
    if (best) {
      const { cx: px, cy: py } = mapGeom.toSvg(best);
      return { cx: px, cy: py, x: best.x, y: best.y, label: best.name, snapped: true };
    }
    // free point
    const model = mapGeom.fromSvg(cx, cy);
    return { cx, cy, x: model.x, y: model.y, label: null, snapped: false };
  }

  function handleClick(e) {
    if (points.length >= 2) { setPoints([]); return; } // reset on 3rd click
    const raw = svgPt(e);
    if (!raw) return;
    const pt = snapToPile(raw.cx, raw.cy);
    setPoints((prev) => [...prev, pt]);
  }

  function handleMove(e) {
    const raw = svgPt(e);
    if (!raw) return;
    const pt = snapToPile(raw.cx, raw.cy);
    setHover(pt);
  }

  const measured = points.length === 2
    ? Math.sqrt((points[1].x - points[0].x)**2 + (points[1].y - points[0].y)**2)
    : null;

  // midpoint for label
  const mid = points.length === 2 ? {
    cx: (points[0].cx + points[1].cx) / 2,
    cy: (points[0].cy + points[1].cy) / 2,
  } : null;

  // angle for rotated label
  const angle = points.length === 2
    ? Math.atan2(points[1].cy - points[0].cy, points[1].cx - points[0].cx) * 180 / Math.PI
    : 0;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className="field-label flex items-center gap-1" style={{ color:"var(--cyan)" }}>
          ✦ Medición manual — haz clic en dos puntos (o pilotes) para medir · clic en un tercero para limpiar
        </span>
        {points.length > 0 && (
          <button onClick={() => setPoints([])} className="btn-ghost text-xs" style={{ padding:"4px 10px" }}>
            <Trash2 size={12} /> Limpiar
          </button>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${mapGeom.W} ${mapGeom.H}`}
        width="100%"
        style={{ background:"var(--blue-deep)", borderRadius:3, cursor:"crosshair", touchAction:"none" }}
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* pilotes de fondo */}
        {piles.map((p) => {
          const { cx, cy } = mapGeom.toSvg(p);
          const isAnchor = points.some(pt => pt.label === p.name);
          return (
            <g key={p.id}>
              <circle cx={cx} cy={cy} r={8}
                fill={isAnchor ? "var(--cyan)" : "var(--blue-panel)"}
                stroke={isAnchor ? "var(--cyan)" : "#758b29"} strokeWidth="1.5" />
              <text x={cx} y={cy - 12} textAnchor="middle" fontSize="9" fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
            </g>
          );
        })}

        {/* snap indicator on hover */}
        {hover && points.length < 2 && (
          <circle cx={hover.cx} cy={hover.cy} r={hover.snapped ? 12 : 5}
            fill="none" stroke="var(--cyan)" strokeWidth={hover.snapped ? 1.5 : 1}
            strokeDasharray={hover.snapped ? "none" : "3 2"} opacity="0.8" />
        )}

        {/* rubber-band line while placing second point */}
        {points.length === 1 && hover && (
          <line x1={points[0].cx} y1={points[0].cy} x2={hover.cx} y2={hover.cy}
            stroke="var(--cyan)" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.6" />
        )}

        {/* measured line */}
        {points.length === 2 && (
          <>
            {/* tick marks at endpoints */}
            {points.map((pt, i) => {
              const perp = { dx: Math.sin(angle * Math.PI / 180) * 8, dy: -Math.cos(angle * Math.PI / 180) * 8 };
              return (
                <g key={i}>
                  <line x1={pt.cx - perp.dx} y1={pt.cy - perp.dy} x2={pt.cx + perp.dx} y2={pt.cy + perp.dy}
                    stroke="var(--cyan)" strokeWidth="1.5" />
                  <circle cx={pt.cx} cy={pt.cy} r={4} fill="var(--cyan)" />
                </g>
              );
            })}
            {/* main dimension line */}
            <line x1={points[0].cx} y1={points[0].cy} x2={points[1].cx} y2={points[1].cy}
              stroke="var(--cyan)" strokeWidth="1.5" />
            {/* cota label box */}
            <g transform={`translate(${mid.cx}, ${mid.cy}) rotate(${Math.abs(angle) > 90 ? angle + 180 : angle})`}>
              <rect x={-38} y={-14} width={76} height={18} rx={3}
                fill="var(--blue-panel)" stroke="var(--cyan)" strokeWidth="1" />
              <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
                fontSize="11" fontWeight="700" fill="var(--cyan)" fontFamily="IBM Plex Mono,monospace">
                {measured.toFixed(2)} m
              </text>
            </g>
            {/* endpoint coords */}
            {points.map((pt, i) => (
              <text key={i} x={pt.cx + (i === 0 ? -6 : 6)} y={pt.cy + 20}
                textAnchor={i === 0 ? "end" : "start"} fontSize="8" fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">
                {pt.label || `(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`}
              </text>
            ))}
          </>
        )}
      </svg>

      {measured !== null && (
        <div className="panel p-3 mt-3 flex items-center gap-6 flex-wrap">
          <div>
            <div className="field-label">Distancia medida</div>
            <div className="mono text-xl font-bold mt-1" style={{ color:"var(--cyan)" }}>{measured.toFixed(3)} m</div>
          </div>
          <div>
            <div className="field-label">Punto A</div>
            <div className="mono text-xs mt-1">{points[0].label || `X=${points[0].x.toFixed(2)}  Y=${points[0].y.toFixed(2)}`}</div>
          </div>
          <div>
            <div className="field-label">Punto B</div>
            <div className="mono text-xs mt-1">{points[1].label || `X=${points[1].x.toFixed(2)}  Y=${points[1].y.toFixed(2)}`}</div>
          </div>
          <div>
            <div className="field-label">ΔX / ΔY</div>
            <div className="mono text-xs mt-1">{Math.abs(points[1].x - points[0].x).toFixed(3)} m / {Math.abs(points[1].y - points[0].y).toFixed(3)} m</div>
          </div>
        </div>
      )}
    </div>
  );
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
  const [activeTab, setActiveTab]       = useState("plano");
  const [executedPiles, setExecutedPiles] = useState(new Set());
  const fileRef = useRef(null);

  function toggleExecuted(id) {
    setExecutedPiles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function markDayExecuted(dayPiles) {
    setExecutedPiles((prev) => {
      const next = new Set(prev);
      const allDone = dayPiles.every((p) => next.has(p.id));
      dayPiles.forEach((p) => allDone ? next.delete(p.id) : next.add(p.id));
      return next;
    });
  }

  const bufferDays = Math.max(1, Math.ceil(bufferHours / 24));
  const mapGeom    = useMapGeom(piles);

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
        const { nameIdx, xIdx, yIdx } = detectColumns(rows[0]);
        if (xIdx === -1 || yIdx === -1)
          throw new Error("No se encontraron columnas de coordenadas. Usa 'X' y 'Y' (o 'Este'/'Norte').");
        const parsed = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          if (r.every((c) => c === "" || c === undefined)) continue;
          const x = parseFloat(r[xIdx]), y = parseFloat(r[yIdx]);
          if (isNaN(x) || isNaN(y)) continue;
          const name = nameIdx !== -1 && r[nameIdx] !== "" ? String(r[nameIdx]) : `P-${String(i).padStart(2, "0")}`;
          parsed.push({ id: name, name, x, y });
        }
        if (!parsed.length) throw new Error("No se pudo leer ningún pilote válido del archivo.");
        setPiles(parsed); setFileName(file.name); setStartId(""); setDrawnOrder([]);
      } catch (err) { setError(err.message || "No se pudo leer el archivo."); }
    };
    reader.readAsArrayBuffer(file);
  }

  function loadDemo() {
    setError(""); setResult(null); setAlternatives([]);
    setPiles(demoPiles()); setFileName("datos de ejemplo"); setStartId(""); setDrawnOrder([]);
  }

  function reset() {
    setPiles([]); setFileName(""); setError(""); setResult(null);
    setAlternatives([]); setStartId(""); setManualOrderText(""); setDrawnOrder([]);
    if (fileRef.current) fileRef.current.value = "";
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
    const path = buildPath(piles, { startId, dirKey, manualIds, drawnOrder });
    setResult(scheduleAlongPath(path, { perDay, bufferDays, radius }));
    setAlternatives([]); setActiveAlt(null); setActiveTab("plano"); setExecutedPiles(new Set());
  }

  function generateAlternatives() {
    if (piles.length < 2) { setError("Carga al menos 2 pilotes."); return; }
    setError("");
    const { manualIds } = computeParams();
    const variants = [
      { label: "Tu configuración",    dirKey, startId, manualIds, drawnOrder },
      { label: "Barrido este →",      dirKey: "east",  startId: "", manualIds, drawnOrder: [] },
      { label: "Barrido oeste ←",     dirKey: "west",  startId: "", manualIds, drawnOrder: [] },
      { label: "Barrido norte ↑",     dirKey: "north", startId: "", manualIds, drawnOrder: [] },
      { label: "Barrido sur ↓",       dirKey: "south", startId: "", manualIds, drawnOrder: [] },
      { label: "Máxima dispersión",   spread: true },
    ];
    const computed = variants.map((v) => {
      let path;
      if (v.spread) {
        const adj = buildConflicts(piles, radius);
        path = [...piles].sort((a, b) => adj.get(b.id).length - adj.get(a.id).length);
      } else {
        path = buildPath(piles, { startId: v.startId, dirKey: v.dirKey, manualIds: v.manualIds, drawnOrder: v.drawnOrder });
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

  function exportXlsx() {
    if (!result) return;
    const rows = [];
    result.byDay.forEach(({ day, piles: ps }) => {
      const date = getWorkingDate(startDate, day, skipSat, skipSun);
      ps.forEach((p) => rows.push({ Dia: day, Fecha: fmtDate(date), Pilote: p.name, X: p.x, Y: p.y }));
    });
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
          --blue-deep: #f7f8f1; --blue-panel: #ffffff; --blue-line: #c8d98a;
          --blue-line-soft: rgba(162,198,23,0.18); --cyan: #6aa0ac; --orange: #758b29;
          --ink: #55525a; --ink-dim: #7a7882;
          font-family: 'IBM Plex Sans','Archivo',sans-serif;
          background: #f7f8f1;
          background-image: linear-gradient(var(--blue-line-soft) 1px, transparent 1px),
                            linear-gradient(90deg, var(--blue-line-soft) 1px, transparent 1px);
          background-size: 28px 28px;
          color: var(--ink); min-height: 100%; padding: 24px; border-radius: 6px;
        }
        .mono { font-family: 'IBM Plex Mono','JetBrains Mono',monospace; }
        .stamp { border:2px solid var(--orange); color:var(--orange); border-radius:999px;
          padding:3px 12px; font-size:11px; letter-spacing:.18em; font-weight:700;
          display:inline-block; transform:rotate(-2deg); }
        .panel { background:var(--blue-panel); border:1px solid #d8e8a0; border-radius:4px; box-shadow: 0 1px 4px rgba(116,139,41,0.08); }
        .field-label { font-size:10px; letter-spacing:.12em; color:var(--ink-dim);
          text-transform:uppercase; font-weight:600; display:flex; align-items:center; gap:4px; }
        input[type=number], input[type=date], input[type=text], select {
          background:#ffffff; border:1px solid var(--blue-line); color:var(--ink);
          border-radius:3px; padding:6px 8px; font-family:'IBM Plex Mono',monospace; width:100%; }
        input[type=range] { width:100%; accent-color:var(--orange); }
        input:focus, select:focus, button:focus-visible { outline:2px solid var(--cyan); outline-offset:1px; }
        .btn-primary { background:#a2c617; color:#1a1a1f; font-weight:700; border-radius:3px;
          padding:9px 14px; display:inline-flex; align-items:center; gap:7px; transition:filter .15s; border:none; cursor:pointer; }
        .btn-primary:hover { filter:brightness(1.08); }
        .btn-primary:disabled { opacity:.4; cursor:default; }
        .btn-ghost { background:transparent; border:1px solid #c8d98a; color:var(--ink);
          border-radius:3px; padding:8px 13px; display:inline-flex; align-items:center; gap:7px; cursor:pointer; }
        .btn-ghost:hover { border-color:#758b29; color:#758b29; }
        .btn-active { border-color:#a2c617 !important; color:#758b29 !important; }
        .th { font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-dim);
          text-align:left; padding:8px 10px; border-bottom:1px solid var(--blue-line); white-space:nowrap; }
        .td { padding:7px 10px; border-bottom:1px solid var(--blue-line-soft); font-size:13px; }
        .day-chip { display:inline-flex; align-items:center; font-family:'IBM Plex Mono',monospace;
          font-weight:700; font-size:12px; padding:2px 8px; border-radius:3px; }
        .alt-card { background:#f9fbe7; border:1px solid #d8e8a0; border-radius:4px;
          padding:12px; cursor:pointer; transition:border-color .15s; }
        .alt-card:hover { border-color:#758b29; }
        .alt-card.active { border-color:#a2c617; box-shadow:0 0 0 1px #a2c617; }
        .tab { background:transparent; border:none; border-bottom:2px solid transparent;
          color:var(--ink-dim); font-size:12px; letter-spacing:.08em; text-transform:uppercase;
          font-weight:600; padding:8px 14px; cursor:pointer; transition:color .15s,border-color .15s; }
        .tab.active { color:#758b29; border-bottom-color:#a2c617; }
      `}</style>

      {/* ── header */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <span className="stamp mono">PLANO DE OBRA · SECUENCIA DE FUNDIDA</span>
          <h1 className="text-2xl font-bold mt-3">Planeador de fundida de pilotes</h1>
          <p className="text-sm mt-1" style={{ color:"var(--ink-dim)", maxWidth:600 }}>
            Define la ruta dibujando sobre el mapa, elige dirección de avance y genera el cronograma
            óptimo respetando las restricciones de curado.
          </p>
        </div>
        <img
          src={`${import.meta.env.BASE_URL}LogoIngeurbe2026.png`}
          alt="Ingeurbe"
          style={{ height: 64, objectFit: "contain", flexShrink: 0, background: "#ffffff", border: "6px solid #ffffff", borderRadius: 6, padding: 6 }}
        />
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
          {result && (
            <button onClick={exportXlsx} className="btn-ghost justify-center">
              <Download size={14} /> Exportar cronograma (.xlsx)
            </button>
          )}
        </div>

        {/* ── right panel */}
        <div className="flex flex-col gap-5">

          {piles.length > 0 && mapGeom && drawMode && (
            <div className="panel p-4">
              <DrawingCanvas
                piles={piles}
                mapGeom={mapGeom}
                radius={radius}
                onOrderChange={setDrawnOrder}
              />
            </div>
          )}

          {!result && !alternatives.length && !drawMode && (
            <div className="panel p-10 flex flex-col items-center justify-center text-center" style={{ minHeight:280 }}>
              <p className="mono text-sm" style={{ color:"var(--ink-dim)" }}>
                {piles.length
                  ? `${piles.length} pilotes cargados — calcula una secuencia o activa el puntero de ruta.`
                  : "Carga un archivo Excel o usa los datos de ejemplo para comenzar."}
              </p>
            </div>
          )}

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
                    <div className="flex justify-between mono text-xs mb-1">
                      <span style={{ color:"var(--ink-dim)" }}>Paso promedio</span>
                      <span>{alt.avgStep.toFixed(1)} m</span>
                    </div>
                    <div className="flex justify-between mono text-xs mb-3">
                      <span style={{ color:"var(--ink-dim)" }}>Recorrido total</span>
                      <span style={{ color:"var(--cyan)", fontWeight:700 }}>{alt.totalDist.toFixed(1)} m</span>
                    </div>
                    <div className="btn-ghost w-full justify-center text-xs" style={{ padding:"5px 8px" }}>
                      <Check size={11} /> Usar esta
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result && (
            <>
              {alternatives.length > 0 && (
                <button className="btn-ghost self-start" onClick={() => setResult(null)}>← Volver a las alternativas</button>
              )}

              <div className="grid grid-cols-4 gap-3">
                <div className="panel p-3">
                  <div className="field-label">Pilotes</div>
                  <div className="text-2xl font-bold mono mt-1">{piles.length}</div>
                </div>
                <div className="panel p-3">
                  <div className="field-label">Días de obra</div>
                  <div className="text-2xl font-bold mono mt-1" style={{ color:"var(--orange)" }}>{result.maxDay}</div>
                </div>
                <div className="panel p-3">
                  <div className="field-label">Recorrido total máquina</div>
                  <div className="text-xl font-bold mono mt-1" style={{ color:"var(--cyan)" }}>{result.totalDist.toFixed(1)} m</div>
                </div>
                <div className="panel p-3">
                  <div className="field-label">Fecha estimada cierre</div>
                  <div className="text-sm font-bold mono mt-2">
                    {fmtDate(getWorkingDate(startDate, result.maxDay, skipSat, skipSun))}
                  </div>
                </div>
              </div>

              <div style={{ borderBottom:"1px solid var(--blue-line)", display:"flex", gap:0 }}>
                {[
                  { key:"plano",   label:"Plano general" },
                  { key:"sim",     label:"▶ Simulación" },
                  { key:"tabla",   label:"Cronograma" },
                  { key:"avance",  label:`✔ Avance${executedPiles.size > 0 ? ` (${executedPiles.size}/${piles.length})` : ""}` },
                  { key:"cota",    label:"✦ Medición" },
                ].map((t) => (
                  <button key={t.key} className={`tab${activeTab === t.key ? " active" : ""}`}
                    onClick={() => setActiveTab(t.key)}>
                    {t.label}
                  </button>
                ))}
              </div>

              {activeTab === "plano" && mapGeom && (
                <div className="panel p-4">
                  <div className="field-label mb-3">Color = día · línea punteada = ruta de avance</div>
                  <svg viewBox={`0 0 ${mapGeom.W} ${mapGeom.H}`} width="100%"
                    style={{ background:"var(--blue-deep)", borderRadius:3 }}>
                    <polyline
                      points={result.path.map((p) => { const { cx,cy } = mapGeom.toSvg(p); return `${cx},${cy}`; }).join(" ")}
                      fill="none" stroke="var(--cyan)" strokeOpacity="0.3" strokeWidth="1.5" strokeDasharray="3 5"
                    />
                    {piles.map((p) => {
                      const { cx, cy } = mapGeom.toSvg(p);
                      const day = result.dayOf.get(p.id);
                      return (
                        <g key={p.id}>
                          <circle cx={cx} cy={cy} r={radius * mapGeom.scale} fill="none"
                            stroke={colorForDay(day)} strokeOpacity="0.3" strokeDasharray="3 3" />
                          <circle cx={cx} cy={cy} r={7} fill={colorForDay(day)} stroke="#1a1a1f" strokeWidth="1.5" />
                          <text x={cx} y={cy-11} textAnchor="middle" fontSize="9" fill="var(--ink-dim)" fontFamily="IBM Plex Mono,monospace">{p.name}</text>
                          <text x={cx} y={cy+3}  textAnchor="middle" fontSize="8" fontWeight="700" fill="#1a1a1f" fontFamily="IBM Plex Mono,monospace">{day}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <p className="mono text-xs mt-2" style={{ color:"var(--ink-dim)" }}>
                    Círculo punteado = radio de exclusión de {radius} m. Número = día asignado.
                  </p>
                </div>
              )}

              {activeTab === "sim" && mapGeom && (
                <NavisworksPlayer
                  result={result}
                  mapGeom={mapGeom}
                  radius={radius}
                  startDate={startDate}
                  skipSat={skipSat}
                  skipSun={skipSun}
                />
              )}

              {activeTab === "tabla" && (() => {
                // ── Build distance rows grouped by day ──────────────────────
                // For each day: distances between consecutive pilotes of THAT day (in path order).
                // Between days: distance from last pilote of day N → first pilote of day N+1 (traslado).
                // This matches exactly how totalDist is computed (consecutive path steps).

                const dayRows = []; // [{type:'day'|'transfer', day, rows:[{mov,from,to,dist}], subtotal}]
                let movCounter = 1;
                let runningTotal = 0;

                for (let di = 0; di < result.byDay.length; di++) {
                  const { day, piles: dayPiles } = result.byDay[di];
                  // pilotes of this day in path order
                  const ordered = result.path.filter(p => result.dayOf.get(p.id) === day);
                  const rows = [];
                  for (let k = 0; k < ordered.length - 1; k++) {
                    const from = ordered[k], to = ordered[k + 1];
                    const d = Math.sqrt((to.x - from.x)**2 + (to.y - from.y)**2);
                    rows.push({ mov: movCounter++, from: from.name, to: to.name, dist: d });
                    runningTotal += d;
                  }
                  const subtotal = rows.reduce((s, r) => s + r.dist, 0);
                  dayRows.push({ type: 'day', day, rows, subtotal });

                  // traslado: last pilote of this day → first pilote of next day
                  if (di < result.byDay.length - 1) {
                    const nextDay = result.byDay[di + 1];
                    const nextOrdered = result.path.filter(p => result.dayOf.get(p.id) === nextDay.day);
                    const lastThis  = ordered[ordered.length - 1];
                    const firstNext = nextOrdered[0];
                    if (lastThis && firstNext) {
                      const d = Math.sqrt((firstNext.x - lastThis.x)**2 + (firstNext.y - lastThis.y)**2);
                      dayRows.push({ type: 'transfer', day, nextDay: nextDay.day, from: lastThis.name, to: firstNext.name, dist: d, mov: movCounter++ });
                      runningTotal += d;
                    }
                  }
                }

                const grandTotal = dayRows.reduce((s, r) => s + (r.type === 'day' ? r.subtotal : r.dist), 0);

                return (
                  <div className="flex gap-4" style={{ alignItems:"flex-start" }}>

                    {/* ── cronograma por día */}
                    <div className="panel p-4" style={{ flex:"1 1 0", minWidth:0 }}>
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
                            {result.byDay.map(({ day, piles: ps }) => {
                              const date = getWorkingDate(startDate, day, skipSat, skipSun);
                              return (
                                <tr key={day}>
                                  <td className="td">
                                    <span className="day-chip" style={{ background:colorForDay(day), color:"#1a1a1f" }}>{day}</span>
                                  </td>
                                  <td className="td mono">{fmtDate(date)}</td>
                                  <td className="td mono">{ps.map((p) => p.name).join("  ·  ")}</td>
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

                    {/* ── tabla de distancias */}
                    <div className="panel p-4" style={{ width:300, flexShrink:0 }}>
                      <div className="field-label mb-3" style={{ color:"var(--cyan)" }}>DISTANCIAS</div>
                      <div style={{ maxHeight:460, overflowY:"auto" }}>
                        <table style={{ width:"100%", borderCollapse:"collapse" }}>
                          <thead>
                            <tr style={{ position:"sticky", top:0, background:"var(--blue-panel)", zIndex:1 }}>
                              <th className="th" style={{ textAlign:"center", width:36 }}>Mov</th>
                              <th className="th" style={{ textAlign:"center" }}>De</th>
                              <th className="th" style={{ textAlign:"center" }}>A</th>
                              <th className="th" style={{ textAlign:"right" }}>Dist (m)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dayRows.map((block, bi) => {
                              if (block.type === 'transfer') {
                                // traslado between days
                                return (
                                  <tr key={`tr-${bi}`} style={{ background:"rgba(255,122,61,0.10)", borderTop:"1px dashed var(--orange)", borderBottom:"1px dashed var(--orange)" }}>
                                    <td className="td mono" style={{ textAlign:"center", color:"var(--orange)", fontSize:11 }}>↕</td>
                                    <td className="td mono" style={{ textAlign:"center", fontSize:11 }}>
                                      <span style={{ background:colorForDay(block.day), color:"#1a1a1f", borderRadius:3, padding:"1px 4px", fontWeight:700, fontSize:10 }}>{block.from}</span>
                                    </td>
                                    <td className="td mono" style={{ textAlign:"center", fontSize:11 }}>
                                      <span style={{ background:colorForDay(block.nextDay), color:"#1a1a1f", borderRadius:3, padding:"1px 4px", fontWeight:700, fontSize:10 }}>{block.to}</span>
                                    </td>
                                    <td className="td mono" style={{ textAlign:"right", fontWeight:700, fontSize:12, color:"var(--orange)" }}>
                                      {block.dist.toFixed(2)}
                                    </td>
                                  </tr>
                                );
                              }
                              // day block
                              return (
                                <React.Fragment key={`day-${block.day}`}>
                                  {/* day header */}
                                  <tr style={{ background:"rgba(127,217,240,0.08)", borderTop:"1px solid var(--blue-line)" }}>
                                    <td colSpan={3} style={{ padding:"5px 10px" }}>
                                      <span style={{ background:colorForDay(block.day), color:"#1a1a1f", borderRadius:3, padding:"2px 8px", fontWeight:700, fontSize:11, fontFamily:"IBM Plex Mono,monospace" }}>
                                        DÍA {block.day}
                                      </span>
                                    </td>
                                    <td className="td mono" style={{ textAlign:"right", fontSize:11, color:"var(--ink-dim)" }}>
                                      {block.subtotal > 0 ? `Σ ${block.subtotal.toFixed(2)}` : "—"}
                                    </td>
                                  </tr>
                                  {block.rows.length === 0 && (
                                    <tr>
                                      <td colSpan={4} className="td mono" style={{ color:"var(--ink-dim)", fontSize:11, textAlign:"center" }}>
                                        1 pilote — sin desplazamiento interno
                                      </td>
                                    </tr>
                                  )}
                                  {block.rows.map((r) => (
                                    <tr key={r.mov}>
                                      <td className="td mono" style={{ textAlign:"center", color:"var(--ink-dim)", fontSize:11 }}>{r.mov}</td>
                                      <td className="td mono" style={{ textAlign:"center", fontSize:11 }}>
                                        <span style={{ background:colorForDay(block.day), color:"#1a1a1f", borderRadius:3, padding:"1px 4px", fontWeight:700, fontSize:10 }}>{r.from}</span>
                                      </td>
                                      <td className="td mono" style={{ textAlign:"center", fontSize:11 }}>
                                        <span style={{ background:colorForDay(block.day), color:"#1a1a1f", borderRadius:3, padding:"1px 4px", fontWeight:700, fontSize:10 }}>{r.to}</span>
                                      </td>
                                      <td className="td mono" style={{ textAlign:"right", fontWeight:600, fontSize:12 }}>{r.dist.toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr style={{ borderTop:"2px solid var(--cyan)", background:"var(--blue-deep)" }}>
                              <td colSpan={3} className="td mono" style={{ fontWeight:700, fontSize:12, color:"var(--cyan)", letterSpacing:".06em" }}>TOTAL RECORRIDO</td>
                              <td className="td mono" style={{ textAlign:"right", fontWeight:800, fontSize:14, color:"var(--cyan)" }}>
                                {grandTotal.toFixed(2)} m
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                      <p className="mono text-xs mt-2" style={{ color:"var(--ink-dim)", lineHeight:1.5 }}>
                        <span style={{ color:"var(--orange)" }}>↕ Fila naranja</span> = traslado entre días.<br/>
                        <span style={{ color:"var(--cyan)" }}>Σ</span> subtotal = distancia interna del día.<br/>
                        Total debe coincidir con el KPI superior.
                      </p>
                    </div>

                  </div>
                );
              })()}

              {activeTab === "avance" && (() => {
                const totalPiles   = piles.length;
                const donePiles    = executedPiles.size;
                const pendingPiles = totalPiles - donePiles;
                const pct          = totalPiles ? Math.round((donePiles / totalPiles) * 100) : 0;

                // último día completado al 100%
                const lastDoneDay = result.byDay.reduce((acc, { day, piles: dp }) => {
                  const allDone = dp.every((p) => executedPiles.has(p.id));
                  return allDone ? day : acc;
                }, 0);

                // días restantes desde el primer día no completado
                const firstPending = result.byDay.find(({ piles: dp }) => dp.some((p) => !executedPiles.has(p.id)));
                const remainingDays = firstPending ? result.maxDay - firstPending.day + 1 : 0;
                const closingDate = firstPending
                  ? getWorkingDate(startDate, firstPending.day + remainingDays - 1, skipSat, skipSun)
                  : null;

                return (
                  <div className="flex flex-col gap-4">

                    {/* KPIs */}
                    <div className="grid grid-cols-4 gap-3">
                      <div className="panel p-3">
                        <div className="field-label">Ejecutados</div>
                        <div className="text-2xl font-bold mono mt-1" style={{ color:"#28a745" }}>{donePiles}</div>
                        <div className="mono text-xs mt-1" style={{ color:"var(--ink-dim)" }}>de {totalPiles} pilotes</div>
                      </div>
                      <div className="panel p-3">
                        <div className="field-label">Pendientes</div>
                        <div className="text-2xl font-bold mono mt-1" style={{ color:"#ffc107" }}>{pendingPiles}</div>
                        <div className="mono text-xs mt-1" style={{ color:"var(--ink-dim)" }}>por fundir</div>
                      </div>
                      <div className="panel p-3">
                        <div className="field-label">Avance</div>
                        <div className="text-2xl font-bold mono mt-1" style={{ color:"var(--orange)" }}>{pct}%</div>
                        <div style={{ marginTop:6, height:6, background:"var(--blue-line)", borderRadius:3, overflow:"hidden" }}>
                          <div style={{ width:`${pct}%`, height:"100%", background:"var(--orange)", borderRadius:3, transition:"width .3s" }} />
                        </div>
                      </div>
                      <div className="panel p-3">
                        <div className="field-label">Cierre estimado</div>
                        <div className="mono text-sm font-bold mt-2">
                          {closingDate ? fmtDate(closingDate) : <span style={{ color:"#28a745" }}>¡Completado!</span>}
                        </div>
                        {remainingDays > 0 && (
                          <div className="mono text-xs mt-1" style={{ color:"var(--ink-dim)" }}>{remainingDays} días restantes</div>
                        )}
                      </div>
                    </div>

                    {/* Mapa de avance */}
                    {mapGeom && (
                      <div className="panel p-4">
                        <div className="field-label mb-3">Mapa de avance — verde = ejecutado · gris = pendiente</div>
                        <svg viewBox={`0 0 ${mapGeom.W} ${mapGeom.H}`} width="100%"
                          style={{ background:"var(--blue-deep)", borderRadius:3 }}>
                          {piles.map((p) => {
                            const { cx, cy } = mapGeom.toSvg(p);
                            const done = executedPiles.has(p.id);
                            const day  = result.dayOf.get(p.id);
                            return (
                              <g key={p.id} style={{ cursor:"pointer" }} onClick={() => toggleExecuted(p.id)}>
                                <circle cx={cx} cy={cy} r={radius * mapGeom.scale} fill="none"
                                  stroke={done ? "#28a745" : "var(--blue-line)"} strokeOpacity="0.3" strokeDasharray="3 3" />
                                <circle cx={cx} cy={cy} r={8}
                                  fill={done ? "#28a745" : "#3a4a2a"} stroke={done ? "#28a745" : "var(--blue-line)"} strokeWidth="1.5" />
                                <text x={cx} y={cy+3} textAnchor="middle" fontSize="8" fontWeight="700"
                                  fill={done ? "#1a1a1f" : "var(--ink-dim)"} fontFamily="IBM Plex Mono,monospace">
                                  {done ? "✓" : day}
                                </text>
                                <text x={cx} y={cy-12} textAnchor="middle" fontSize="9"
                                  fill={done ? "#28a745" : "var(--ink-dim)"} fontFamily="IBM Plex Mono,monospace">{p.name}</text>
                              </g>
                            );
                          })}
                        </svg>
                        <p className="mono text-xs mt-2" style={{ color:"var(--ink-dim)" }}>
                          Haz clic sobre un pilote en el mapa para marcarlo como ejecutado / pendiente.
                        </p>
                      </div>
                    )}

                    {/* Tabla por día con checkboxes */}
                    <div className="panel p-4">
                      <div className="field-label mb-3">Registro por día</div>
                      <div style={{ overflowX:"auto" }}>
                        <table style={{ width:"100%", borderCollapse:"collapse" }}>
                          <thead>
                            <tr>
                              <th className="th" style={{ width:40 }}></th>
                              <th className="th">Día</th>
                              <th className="th">Fecha</th>
                              <th className="th">Pilotes</th>
                              <th className="th">Estado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.byDay.map(({ day, piles: dp }) => {
                              const date    = getWorkingDate(startDate, day, skipSat, skipSun);
                              const allDone = dp.every((p) => executedPiles.has(p.id));
                              const someDone = dp.some((p) => executedPiles.has(p.id));
                              return (
                                <tr key={day} style={{ background: allDone ? "rgba(40,167,69,0.08)" : "transparent" }}>
                                  <td className="td" style={{ textAlign:"center" }}>
                                    <input type="checkbox"
                                      checked={allDone}
                                      ref={el => { if (el) el.indeterminate = someDone && !allDone; }}
                                      onChange={() => markDayExecuted(dp)}
                                      style={{ width:15, height:15, accentColor:"#28a745", cursor:"pointer" }}
                                    />
                                  </td>
                                  <td className="td">
                                    <span className="day-chip" style={{ background: colorForDay(day), color:"#1a1a1f" }}>{day}</span>
                                  </td>
                                  <td className="td mono">{fmtDate(date)}</td>
                                  <td className="td">
                                    <div className="flex flex-wrap gap-1">
                                      {dp.map((p) => (
                                        <span key={p.id}
                                          onClick={() => toggleExecuted(p.id)}
                                          style={{
                                            background: executedPiles.has(p.id) ? "#28a745" : "var(--blue-line)",
                                            color: executedPiles.has(p.id) ? "#1a1a1f" : "var(--ink)",
                                            borderRadius:3, padding:"2px 7px", fontSize:11,
                                            fontFamily:"IBM Plex Mono,monospace", fontWeight:700,
                                            cursor:"pointer", transition:"background .15s"
                                          }}>
                                          {executedPiles.has(p.id) ? "✓ " : ""}{p.name}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="td mono text-xs">
                                    {allDone
                                      ? <span style={{ color:"#28a745" }}>✔ Completado</span>
                                      : someDone
                                        ? <span style={{ color:"#ffc107" }}>⬤ En curso</span>
                                        : <span style={{ color:"var(--ink-dim)" }}>○ Pendiente</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {activeTab === "cota" && mapGeom && (
                <div className="panel p-4">
                  <MeasureTool piles={piles} mapGeom={mapGeom} />
                </div>
              )}

              <p className="mono text-xs" style={{ color:"var(--ink-dim)" }}>
                Nota: el conteo de días de espera se hace en días de obra consecutivos.
                Si tu jornada no cubre 24 h corridas, ajusta el número de días de espera.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

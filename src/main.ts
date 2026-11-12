import "./style.css";
import puzzlesJson from "./data/puzzles.json";
import {
  COLORS,
  KIND,
  LABELS,
  SLOTS,
  aligningTranslation,
  bbox,
  centroid,
  coverageScore,
  isSolved,
  mod8,
  place,
  pointsAttr,
  type Box,
  type Pt,
  type Slot,
} from "./geometry";

interface Placement {
  slot: Slot;
  x: number;
  y: number;
  r: number;
  f: number;
}
interface Puzzle {
  id: string;
  name: string;
  blurb: string;
  difficulty: number;
  pieces: Placement[];
}
interface PieceState {
  slot: Slot;
  x: number;
  y: number;
  r: number;
  f: boolean;
  atHome: boolean;
}
interface Home {
  x: number;
  y: number;
  r: number;
  f: boolean;
}
interface SaveFile {
  solved: Record<string, { seconds: number; moves: number }>;
}

const PUZZLES = puzzlesJson as Puzzle[];
const DIFF = ["", "入门", "进阶", "挑战"];
const TRAY_ROT: Record<Slot, number> = {
  big1: 0,
  big2: 2,
  medium: 5,
  small1: 3,
  small2: 6,
  square: 0,
  para: 1,
};
const SAVE_KEY = "qiqiaoban-v1";
const NS = "http://www.w3.org/2000/svg";

const app = document.querySelector("#app");
if (!app) throw new Error("missing app");

let save = loadSave();
let mode: "select" | "play" = "select";
let puzzle: Puzzle | null = null;
let pieces: PieceState[] = [];
let homes: Record<Slot, Home> = {} as Record<Slot, Home>;
let view: Box = { minX: 0, minY: 0, maxX: 10, maxY: 8 };
let selected: Slot | null = null;
let hintSlot: Slot | null = null;
let moves = 0;
let startedAt: number | null = null;
let frozenMs = 0;
let won = false;
let portrait = window.innerWidth < 900;
let undoStack: string[] = [];
let ticker = 0;
let toastTimer = 0;
let audioCtx: AudioContext | null = null;

let svg: SVGSVGElement | null = null;
let drag: {
  slot: Slot;
  pointerId: number;
  dx: number;
  dy: number;
  moved: boolean;
  origin: string;
} | null = null;
let spin: {
  slot: Slot;
  pointerId: number;
  cx: number;
  cy: number;
  startAngle: number;
  startR: number;
  moved: boolean;
  origin: string;
} | null = null;
let lastTap = { slot: "" as string, t: 0 };

function loadSave(): SaveFile {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { solved: {} };
    const parsed = JSON.parse(raw) as SaveFile;
    return parsed.solved ? parsed : { solved: {} };
  } catch {
    return { solved: {} };
  }
}
function writeSave() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    /* private mode */
  }
}

function polyOf(piece: PieceState): Pt[] {
  return place(KIND[piece.slot], piece.x, piece.y, piece.r, piece.f);
}
function solutionPoly(placement: Placement): Pt[] {
  return place(KIND[placement.slot], placement.x, placement.y, placement.r, placement.f === 1);
}
function solutionPolys(puz: Puzzle): Pt[][] {
  return puz.pieces.map(solutionPoly);
}
function elapsedMs(): number {
  if (startedAt == null) return frozenMs;
  return frozenMs + (performance.now() - startedAt);
}
function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function nearly(a: PieceState, b: { x: number; y: number; r: number; f: boolean }): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6 && a.r === b.r && a.f === b.f;
}

function layout(puz: Puzzle | null, isPortrait: boolean): { view: Box; homes: Record<Slot, Home>; mat: Box } {
  const reference = puz
    ? solutionPolys(puz)
    : [[[0, 0], [3.4, 0], [3.4, 3.3], [0, 3.3]] as Pt[]];
  const sil = bbox(reference);
  const nextHomes = {} as Record<Slot, Home>;
  const measure = (slot: Slot, r: number) => bbox([place(KIND[slot], 0, 0, r, false)]);

  if (!isPortrait) {
    const columns: Slot[][] = [
      ["big1", "big2", "medium"],
      ["square", "para", "small1", "small2"],
    ];
    let x = sil.maxX + 0.95;
    for (const col of columns) {
      let y = sil.minY;
      let colW = 0;
      for (const slot of col) {
        const r = TRAY_ROT[slot];
        const bb = measure(slot, r);
        nextHomes[slot] = { x: x - bb.minX, y: y - bb.minY, r, f: false };
        y += bb.maxY - bb.minY + 0.32;
        colW = Math.max(colW, bb.maxX - bb.minX);
      }
      x += colW + 0.42;
    }
  } else {
    const rows: Slot[][] = [
      ["big1", "big2", "medium", "square"],
      ["para", "small1", "small2"],
    ];
    let y = sil.maxY + 0.8;
    const silW = sil.maxX - sil.minX;
    for (const row of rows) {
      const items = row.map((slot) => {
        const bb = measure(slot, TRAY_ROT[slot]);
        return { slot, bb, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY };
      });
      const totalW = items.reduce((sum, it) => sum + it.w, 0) + 0.26 * (row.length - 1);
      let x = sil.minX + Math.max(0, (silW - totalW) / 2);
      let rowH = 0;
      for (const it of items) {
        nextHomes[it.slot] = { x: x - it.bb.minX, y: y - it.bb.minY, r: TRAY_ROT[it.slot], f: false };
        x += it.w + 0.26;
        rowH = Math.max(rowH, it.h);
      }
      y += rowH + 0.34;
    }
  }

  const placed = SLOTS.map((slot) =>
    place(KIND[slot], nextHomes[slot].x, nextHomes[slot].y, nextHomes[slot].r, false),
  );
  const box = bbox([...reference, ...placed]);
  const pad = 0.5;
  return {
    homes: nextHomes,
    mat: sil,
    view: {
      minX: box.minX - pad,
      minY: box.minY - pad,
      maxX: box.maxX + pad,
      maxY: box.maxY + pad,
    },
  };
}

function clientToWorld(event: { clientX: number; clientY: number }): Pt {
  if (!svg) return [0, 0];
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return [0, 0];
  const local = pt.matrixTransform(ctm.inverse());
  return [local.x, local.y];
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function showToast(message: string) {
  const toast = document.querySelector(".toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1700);
}

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
}

function chime() {
  if (!audioCtx) return;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => {
    const osc = audioCtx!.createOscillator();
    const gain = audioCtx!.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const t0 = audioCtx!.currentTime + i * 0.07;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
    osc.connect(gain).connect(audioCtx!.destination);
    osc.start(t0);
    osc.stop(t0 + 0.34);
  });
}

function burst() {
  const canvas = document.querySelector("#confetti") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = Object.values(COLORS);
  const bits = Array.from({ length: 90 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 80,
    y: canvas.height * 0.38,
    vx: (Math.random() - 0.5) * 11,
    vy: -Math.random() * 9 - 3,
    w: 6 + Math.random() * 7,
    h: 8 + Math.random() * 8,
    color: colors[Math.floor(Math.random() * colors.length)] ?? "#e1543c",
    rot: Math.random() * 6,
    vr: (Math.random() - 0.5) * 0.3,
  }));
  const start = performance.now();
  const frame = (now: number) => {
    const t = (now - start) / 1000;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const bit of bits) {
      bit.vy += 0.18;
      bit.x += bit.vx;
      bit.y += bit.vy;
      bit.rot += bit.vr;
      ctx.save();
      ctx.translate(bit.x, bit.y);
      ctx.rotate(bit.rot);
      ctx.fillStyle = bit.color;
      ctx.globalAlpha = Math.max(0, 1 - t / 1.7);
      ctx.fillRect(-bit.w / 2, -bit.h / 2, bit.w, bit.h);
      ctx.restore();
    }
    if (t < 1.8) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(frame);
}

function snapshot(): string {
  return JSON.stringify({
    pieces,
    moves,
    frozenMs: elapsedMs(),
    started: startedAt != null,
    hintSlot,
    selected,
    won,
  });
}
function beginChange() {
  undoStack.push(snapshot());
  if (undoStack.length > 80) undoStack.shift();
}
function restore(raw: string) {
  const data = JSON.parse(raw) as {
    pieces: PieceState[];
    moves: number;
    frozenMs: number;
    started: boolean;
    hintSlot: Slot | null;
    selected: Slot | null;
    won: boolean;
  };
  pieces = data.pieces;
  moves = data.moves;
  frozenMs = data.frozenMs;
  startedAt = data.started && !data.won ? performance.now() : null;
  hintSlot = data.hintSlot;
  selected = data.selected;
  won = data.won;
  const modal = document.querySelector(".modal") as HTMLElement | null;
  if (modal) modal.hidden = !won;
  syncAll();
  updateHud();
}

function applySnap(piece: PieceState, fromDrag: boolean) {
  const poly = polyOf(piece);
  if (puzzle) {
    const kind = KIND[piece.slot];
    let best: { dx: number; dy: number; dist: number } | null = null;
    for (const placement of puzzle.pieces) {
      if (KIND[placement.slot] !== kind) continue;
      const target = solutionPoly(placement);
      const taken = pieces.some((other) => {
        if (other.slot === piece.slot) return false;
        if (KIND[other.slot] !== kind) return false;
        const shift = aligningTranslation(polyOf(other), target, 0.1);
        return shift != null && Math.hypot(shift[0], shift[1]) <= 0.1;
      });
      if (taken) continue;
      const shift = aligningTranslation(poly, target, 0.28);
      if (!shift) continue;
      const dist = Math.hypot(shift[0], shift[1]);
      // 形状对上还不够，板子本身也得靠近谜底，否则一转就会飞过去。
      if (dist > 0.42) continue;
      if (!best || dist < best.dist) best = { dx: shift[0], dy: shift[1], dist };
    }
    if (best && best.dist > 1e-4) {
      piece.x += best.dx;
      piece.y += best.dy;
      return;
    }
    if (best) return;
  }
  if (!fromDrag) return;
  const targets: Pt[] = [];
  if (puzzle) {
    for (const polyTarget of solutionPolys(puzzle)) targets.push(...polyTarget);
  }
  for (const other of pieces) {
    if (other.slot === piece.slot) continue;
    targets.push(...polyOf(other));
  }
  let bestD = 0.22;
  let shift: Pt | null = null;
  for (const [x, y] of poly) {
    for (const [tx, ty] of targets) {
      const d = Math.hypot(x - tx, y - ty);
      if (d < bestD) {
        bestD = d;
        shift = [tx - x, ty - y];
      }
    }
  }
  if (shift) {
    piece.x += shift[0];
    piece.y += shift[1];
  }
}

function seatedOn(piece: PieceState, placement: Placement): boolean {
  const shift = aligningTranslation(polyOf(piece), solutionPoly(placement), 0.12);
  return shift != null && Math.hypot(shift[0], shift[1]) <= 0.12;
}

function checkWin() {
  if (!puzzle || won || mode !== "play") return;
  const targets = solutionPolys(puzzle);
  const current = pieces.map(polyOf);
  if (!isSolved(coverageScore(targets, current))) return;
  won = true;
  frozenMs = elapsedMs();
  startedAt = null;
  const seconds = Math.max(1, Math.round(frozenMs / 1000));
  const prev = save.solved[puzzle.id];
  const better = !prev || moves < prev.moves || (moves === prev.moves && seconds < prev.seconds);
  if (better) {
    save.solved[puzzle.id] = { seconds, moves };
    writeSave();
  }
  const modal = document.querySelector(".modal") as HTMLElement | null;
  const name = document.querySelector(".modal-name");
  const stats = document.querySelector(".modal-stats");
  if (name) name.textContent = puzzle.name;
  if (stats) {
    stats.textContent = `用时 ${formatTime(frozenMs)} · ${moves} 步${better && prev ? " · 新纪录" : ""}`;
  }
  if (modal) modal.hidden = false;
  const next = document.querySelector("#next-level");
  if (next) next.textContent = puzzleIndex() >= PUZZLES.length - 1 ? "回到选关" : "下一关";
  ensureAudio();
  chime();
  burst();
  updateHud();
}

function puzzleIndex(): number {
  return puzzle ? PUZZLES.findIndex((item) => item.id === puzzle!.id) : -1;
}

function changedFrom(origin: string, piece: PieceState): boolean {
  const before = JSON.parse(origin) as PieceState;
  return !nearly(piece, before) || before.f !== piece.f;
}

function finishChange(origin: string, piece: PieceState) {
  if (!changedFrom(origin, piece)) {
    undoStack.pop();
    return;
  }
  piece.atHome = false;
  moves += 1;
  if (startedAt == null && !won) startedAt = performance.now();
  if (hintSlot && puzzle) {
    const placement = puzzle.pieces.find((item) => item.slot === hintSlot);
    const owner = pieces.find((item) => item.slot === piece.slot);
    if (placement && owner && seatedOn(owner, placement)) hintSlot = null;
  }
  syncAll();
  updateHud();
  checkWin();
}

function rotateBy(piece: PieceState, delta: number) {
  const before = centroid(polyOf(piece));
  piece.r = mod8(piece.r + delta);
  const after = centroid(polyOf(piece));
  piece.x += before[0] - after[0];
  piece.y += before[1] - after[1];
}
function flipPiece(piece: PieceState) {
  const before = centroid(polyOf(piece));
  piece.f = !piece.f;
  const after = centroid(polyOf(piece));
  piece.x += before[0] - after[0];
  piece.y += before[1] - after[1];
}

function selectedPiece(): PieceState | null {
  return pieces.find((piece) => piece.slot === selected) ?? null;
}

function requirePiece(): PieceState | null {
  const piece = selectedPiece();
  if (!piece) {
    showToast("先点选一块板");
    return null;
  }
  return piece;
}

function onRotate(dir: number) {
  if (won) return;
  const piece = requirePiece();
  if (!piece) return;
  const origin = JSON.stringify(piece);
  beginChange();
  rotateBy(piece, dir);
  applySnap(piece, false);
  finishChange(origin, piece);
}
function onFlip() {
  if (won) return;
  const piece = requirePiece();
  if (!piece) return;
  if (piece.slot !== "para") {
    showToast("只有平行四边形需要翻面");
    return;
  }
  const origin = JSON.stringify(piece);
  beginChange();
  flipPiece(piece);
  applySnap(piece, false);
  finishChange(origin, piece);
}
function onHint() {
  if (!puzzle) {
    showToast("自由拼摆没有谜底");
    return;
  }
  const order: Slot[] = ["big1", "big2", "medium", "para", "square", "small1", "small2"];
  const start = hintSlot ? (order.indexOf(hintSlot) + 1) % order.length : 0;
  for (let i = 0; i < order.length; i++) {
    const slot = order[(start + i) % order.length];
    const placement = puzzle.pieces.find((item) => item.slot === slot);
    const piece = pieces.find((item) => item.slot === slot);
    if (!placement || !piece) continue;
    if (!seatedOn(piece, placement)) {
      hintSlot = slot;
      selected = slot;
      syncAll();
      updateHud();
      showToast(`看看${LABELS[slot]}该放在哪`);
      return;
    }
  }
  hintSlot = null;
  showToast("每块板都在影子里了");
  syncAll();
}
function onUndo() {
  const prev = undoStack.pop();
  if (!prev) {
    showToast("没有可以撤销的一步");
    return;
  }
  restore(prev);
}
function resetPieces() {
  pieces = SLOTS.map((slot) => {
    const home = homes[slot];
    return { slot, x: home.x, y: home.y, r: home.r, f: home.f, atHome: true };
  });
  selected = null;
  hintSlot = null;
  moves = 0;
  startedAt = null;
  frozenMs = 0;
  won = false;
  undoStack = [];
  const modal = document.querySelector(".modal") as HTMLElement | null;
  if (modal) modal.hidden = true;
  syncAll();
  updateHud();
}

function updateHud() {
  const time = document.querySelector("#time");
  const move = document.querySelector("#moves");
  if (time) time.textContent = formatTime(elapsedMs());
  if (move) move.textContent = String(moves);
  const line = document.querySelector(".hintline");
  if (line) {
    if (!puzzle) line.textContent = "自由拼摆：拖动、旋转、翻转，摆出你自己的图案。";
    else if (hintSlot) line.textContent = `提示：虚线是${LABELS[hintSlot]}的正确位置。`;
    else if (selected) line.textContent = `已选 ${LABELS[selected]}。双击或按 E 旋转，方向键微调。`;
    else line.textContent = "把七块板铺满影子，块与块之间不要重叠。";
  }
  const flip = document.querySelector("#flip") as HTMLButtonElement | null;
  if (flip) flip.disabled = selected !== "para";
}

function applyView() {
  if (!svg) return;
  const w = view.maxX - view.minX;
  const h = view.maxY - view.minY;
  svg.setAttribute("viewBox", `${view.minX} ${view.minY} ${w} ${h}`);
}

function syncPiece(piece: PieceState) {
  const group = svg?.querySelector(`[data-slot="${piece.slot}"]`);
  if (!group) return;
  const poly = polyOf(piece);
  const shape = group.querySelector(".shape");
  if (shape) shape.setAttribute("points", pointsAttr(poly));
  group.classList.toggle("selected", piece.slot === selected);
  group.classList.toggle("dragging", drag?.slot === piece.slot);
  group.setAttribute("data-x", piece.x.toFixed(3));
  group.setAttribute("data-y", piece.y.toFixed(3));
  group.setAttribute("data-r", String(piece.r));
  group.setAttribute("data-f", piece.f ? "1" : "0");
  const bb = bbox([poly]);
  const rot = group.querySelector(".rot-handle") as SVGGElement | null;
  const flip = group.querySelector(".flip-handle") as SVGGElement | null;
  const show = piece.slot === selected && !won;
  if (rot) {
    rot.setAttribute("transform", `translate(${(bb.minX + bb.maxX) / 2} ${bb.minY - 0.42})`);
    rot.style.display = show ? "" : "none";
  }
  if (flip) {
    flip.setAttribute("transform", `translate(${bb.maxX + 0.42} ${bb.minY + 0.05})`);
    flip.style.display = show && piece.slot === "para" ? "" : "none";
  }
}

function syncHint() {
  const node = svg?.querySelector("#hint-shape");
  if (!node || !puzzle || !hintSlot) {
    node?.setAttribute("points", "");
    node?.setAttribute("visibility", "hidden");
    return;
  }
  const placement = puzzle.pieces.find((item) => item.slot === hintSlot);
  if (!placement) return;
  node.setAttribute("points", pointsAttr(solutionPoly(placement)));
  node.setAttribute("fill", COLORS[hintSlot]);
  node.setAttribute("stroke", COLORS[hintSlot]);
  node.setAttribute("visibility", "visible");
}

function syncAll() {
  for (const piece of pieces) syncPiece(piece);
  syncHint();
  if (selected) {
    const group = svg?.querySelector(`[data-slot="${selected}"]`);
    if (group) group.parentElement?.appendChild(group);
  }
}

function pieceBySlot(slot: Slot): PieceState | null {
  return pieces.find((item) => item.slot === slot) ?? null;
}

function bindPiece(slot: Slot) {
  const group = svg?.querySelector(`[data-slot="${slot}"]`);
  const shape = group?.querySelector(".shape");
  shape?.addEventListener("pointerdown", (event) => {
    const piece = pieceBySlot(slot);
    if (!piece || won || !(event instanceof PointerEvent)) return;
    event.preventDefault();
    ensureAudio();
    selected = slot;
    const [wx, wy] = clientToWorld(event);
    drag = {
      slot,
      pointerId: event.pointerId,
      dx: piece.x - wx,
      dy: piece.y - wy,
      moved: false,
      origin: JSON.stringify(piece),
    };
    beginChange();
    syncAll();
    updateHud();
    // 先把板子抬到最上层，再捕获指针，否则移动节点会丢掉捕获，松手时吸附不会发生。
    shape.setPointerCapture(event.pointerId);
  });
  shape?.addEventListener("pointermove", (event) => {
    const piece = pieceBySlot(slot);
    if (!piece || !drag || drag.slot !== slot || !(event instanceof PointerEvent)) return;
    if (event.pointerId !== drag.pointerId) return;
    const [wx, wy] = clientToWorld(event);
    const nx = wx + drag.dx;
    const ny = wy + drag.dy;
    if (Math.hypot(nx - piece.x, ny - piece.y) > 0.01) drag.moved = true;
    piece.x = nx;
    piece.y = ny;
    syncPiece(piece);
  });
  const endDrag = (event: Event) => {
    const piece = pieceBySlot(slot);
    if (!piece || !drag || drag.slot !== slot || !(event instanceof PointerEvent)) return;
    if (event.pointerId !== drag.pointerId) return;
    const info = drag;
    drag = null;
    const now = performance.now();
    const tapped = !info.moved && lastTap.slot === slot && now - lastTap.t < 280;
    lastTap = { slot, t: now };
    if (tapped) {
      undoStack.pop();
      const origin = JSON.stringify(piece);
      beginChange();
      rotateBy(piece, 1);
      applySnap(piece, false);
      finishChange(origin, piece);
      return;
    }
    if (info.moved) applySnap(piece, true);
    finishChange(info.origin, piece);
  };
  shape?.addEventListener("pointerup", endDrag);
  shape?.addEventListener("pointercancel", endDrag);

  const rot = group?.querySelector(".rot-handle");
  rot?.addEventListener("pointerdown", (event) => {
    const piece = pieceBySlot(slot);
    if (!piece || won || !(event instanceof PointerEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    const c = centroid(polyOf(piece));
    const [wx, wy] = clientToWorld(event);
    spin = {
      slot,
      pointerId: event.pointerId,
      cx: c[0],
      cy: c[1],
      startAngle: Math.atan2(wy - c[1], wx - c[0]),
      startR: piece.r,
      moved: false,
      origin: JSON.stringify(piece),
    };
    beginChange();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  });
  rot?.addEventListener("pointermove", (event) => {
    const piece = pieceBySlot(slot);
    if (!piece || !spin || spin.slot !== slot || !(event instanceof PointerEvent)) return;
    const [wx, wy] = clientToWorld(event);
    if (Math.hypot(wx - spin.cx, wy - spin.cy) > 0.15) spin.moved = true;
    const angle = Math.atan2(wy - spin.cy, wx - spin.cx);
    let delta = angle - spin.startAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const steps = Math.round(delta / (Math.PI / 4));
    const next = mod8(spin.startR + steps);
    if (next !== piece.r) {
      const origin = JSON.parse(spin.origin) as PieceState;
      piece.r = spin.startR;
      piece.x = origin.x;
      piece.y = origin.y;
      piece.f = origin.f;
      rotateBy(piece, steps);
      syncPiece(piece);
    }
  });
  rot?.addEventListener("pointerup", (event) => {
    const piece = pieceBySlot(slot);
    if (!piece || !spin || spin.slot !== slot || !(event instanceof PointerEvent)) return;
    const info = spin;
    spin = null;
    if (!info.moved) rotateBy(piece, 1);
    applySnap(piece, false);
    finishChange(info.origin, piece);
  });
  group?.querySelector(".flip-handle")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    selected = slot;
    onFlip();
  });
}

function mountPlay(puz: Puzzle | null) {
  window.clearInterval(ticker);
  mode = "play";
  puzzle = puz;
  portrait = window.innerWidth < 900;
  const laid = layout(puz, portrait);
  homes = laid.homes;
  view = laid.view;
  pieces = SLOTS.map((slot) => ({ slot, ...homes[slot], atHome: true }));
  selected = null;
  hintSlot = null;
  moves = 0;
  startedAt = null;
  frozenMs = 0;
  won = false;
  undoStack = [];
  drag = null;
  spin = null;

  const index = puz ? PUZZLES.findIndex((item) => item.id === puz.id) + 1 : 0;
  const title = puz ? puz.name : "自由拼摆";
  const sub = puz ? `${DIFF[puz.difficulty] ?? ""} · 第 ${index} 关 · ${puz.blurb}` : "没有影子，想摆什么就摆什么。";

  app!.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "screen play-screen";
  screen.innerHTML = `
    <header class="topbar">
      <button class="btn secondary" id="back" type="button">选关</button>
      <div>
        <h2>${title}</h2>
        <div class="sub">${sub}</div>
      </div>
      <div class="stats">
        <div class="stat"><b id="time">0:00</b><span>时间</span></div>
        <div class="stat"><b id="moves">0</b><span>步数</span></div>
      </div>
    </header>
    <div class="stage"><svg id="board" role="application" aria-label="${title}拼板"></svg></div>
    <div class="tools">
      <p class="hintline"></p>
      <button class="btn secondary" id="turn-left" type="button">左转</button>
      <button class="btn secondary" id="turn-right" type="button">右转</button>
      <button class="btn secondary" id="flip" type="button">翻转</button>
      <button class="btn secondary" id="hint" type="button">提示</button>
      <button class="btn secondary" id="undo" type="button">撤销</button>
      <button class="btn secondary" id="reset" type="button">重置</button>
      <button class="btn secondary" id="to-select" type="button">选关</button>
      <button class="btn" id="free" type="button">自由拼摆</button>
      <div class="legend"></div>
    </div>
    <div class="modal" id="win-dialog" hidden>
      <div class="modal-card" role="dialog" aria-labelledby="win-title">
        <div class="big-seal">成</div>
        <h3 id="win-title">拼好了</h3>
        <p class="modal-name"></p>
        <p class="modal-stats"></p>
        <div class="modal-actions">
          <button class="btn secondary" id="again" type="button">再来一次</button>
          <button class="btn" id="next-level" type="button">下一关</button>
        </div>
      </div>
    </div>
    <canvas id="confetti"></canvas>
    <div class="toast" role="status"></div>
  `;
  app!.appendChild(screen);

  svg = screen.querySelector("#board");
  applyView();
  drawBoard(laid.mat);
  for (const piece of pieces) bindPiece(piece.slot);
  syncAll();
  updateHud();

  screen.querySelector("#back")?.addEventListener("click", showSelect);
  screen.querySelector("#to-select")?.addEventListener("click", showSelect);
  screen.querySelector("#turn-left")?.addEventListener("click", () => onRotate(-1));
  screen.querySelector("#turn-right")?.addEventListener("click", () => onRotate(1));
  screen.querySelector("#flip")?.addEventListener("click", onFlip);
  screen.querySelector("#hint")?.addEventListener("click", onHint);
  screen.querySelector("#undo")?.addEventListener("click", onUndo);
  screen.querySelector("#reset")?.addEventListener("click", () => {
    resetPieces();
    showToast("已经摆回原处");
  });
  screen.querySelector("#free")?.addEventListener("click", () => mountPlay(null));
  screen.querySelector("#again")?.addEventListener("click", () => {
    if (puzzle) mountPlay(puzzle);
  });
  screen.querySelector("#next-level")?.addEventListener("click", () => {
    if (!puzzle) return showSelect();
    const next = puzzleIndex() + 1;
    if (next >= PUZZLES.length) showSelect();
    else mountPlay(PUZZLES[next]);
  });
  svg?.addEventListener("contextmenu", (event) => event.preventDefault());
  svg?.addEventListener("pointerdown", (event) => {
    if (event.target === svg) {
      selected = null;
      syncAll();
      updateHud();
    }
  });

  ticker = window.setInterval(updateHud, 250);
}

function drawBoard(mat: Box) {
  if (!svg) return;
  svg.replaceChildren();
  const matPad = 0.42;
  svg.append(
    svgEl("rect", {
      x: mat.minX - matPad,
      y: mat.minY - matPad,
      width: mat.maxX - mat.minX + matPad * 2,
      height: mat.maxY - mat.minY + matPad * 2,
      rx: 0.18,
      fill: "#fffdf8",
      stroke: "#eadcc4",
      "stroke-width": 0.03,
    }),
  );
  const homePolys = SLOTS.map((slot) => place(KIND[slot], homes[slot].x, homes[slot].y, homes[slot].r, false));
  const tray = bbox(homePolys);
  const trayPad = 0.28;
  svg.append(
    svgEl("rect", {
      x: tray.minX - trayPad,
      y: tray.minY - trayPad,
      width: tray.maxX - tray.minX + trayPad * 2,
      height: tray.maxY - tray.minY + trayPad * 2,
      rx: 0.16,
      fill: "#f4e7d2",
      stroke: "#e3d0b4",
      "stroke-width": 0.03,
    }),
  );
  if (puzzle) {
    const silhouette = svgEl("g", { id: "silhouette" });
    for (const poly of solutionPolys(puzzle)) {
      silhouette.append(svgEl("polygon", { points: pointsAttr(poly), fill: "#2a241c" }));
    }
    svg.append(silhouette);
  } else {
    svg.append(
      svgEl("text", {
        x: (mat.minX + mat.maxX) / 2,
        y: (mat.minY + mat.maxY) / 2,
        "text-anchor": "middle",
        "font-size": 0.28,
        fill: "#8d7b68",
      }),
    );
    svg.lastElementChild!.textContent = "在这张空桌上自由拼摆";
  }
  const hint = svgEl("polygon", {
    id: "hint-shape",
    points: "",
    fill: "#e1543c",
    "fill-opacity": 0.28,
    stroke: "#e1543c",
    "stroke-width": 0.045,
    "stroke-dasharray": "0.14 0.09",
    visibility: "hidden",
  });
  svg.append(hint);

  for (const piece of pieces) {
    const group = svgEl("g", { class: "piece", "data-slot": piece.slot });
    group.append(
      svgEl("polygon", {
        class: "shape",
        points: pointsAttr(polyOf(piece)),
        fill: COLORS[piece.slot],
        stroke: "#fffaf3",
        "stroke-width": 0.045,
        "stroke-linejoin": "round",
      }),
    );
    const rot = svgEl("g", { class: "handle rot-handle" });
    rot.append(svgEl("circle", { r: 0.28, fill: "#241c16" }));
    const rotText = svgEl("text", {
      "text-anchor": "middle",
      y: 0.08,
      "font-size": 0.24,
      fill: "#fffaf2",
      "pointer-events": "none",
    });
    rotText.textContent = "转";
    rot.append(rotText);
    group.append(rot);
    const flip = svgEl("g", { class: "handle flip-handle" });
    flip.append(svgEl("circle", { r: 0.28, fill: "#241c16" }));
    const flipText = svgEl("text", {
      "text-anchor": "middle",
      y: 0.08,
      "font-size": 0.24,
      fill: "#fffaf2",
      "pointer-events": "none",
    });
    flipText.textContent = "翻";
    flip.append(flipText);
    group.append(flip);
    svg.append(group);
  }

  const legend = document.querySelector(".legend");
  if (legend) {
    legend.innerHTML = SLOTS.map(
      (slot) => `<span><i style="background:${COLORS[slot]}"></i>${LABELS[slot]}</span>`,
    ).join("");
  }
}

function miniSilhouette(puz: Puzzle): string {
  const polys = solutionPolys(puz);
  const box = bbox(polys);
  const pad = 0.2;
  const body = polys.map((poly) => `<polygon points="${pointsAttr(poly)}" fill="#241c16"/>`).join("");
  return `<svg viewBox="${box.minX - pad} ${box.minY - pad} ${box.maxX - box.minX + pad * 2} ${box.maxY - box.minY + pad * 2}" aria-hidden="true">${body}</svg>`;
}

function showSelect() {
  window.clearInterval(ticker);
  mode = "select";
  puzzle = null;
  won = false;
  drag = null;
  spin = null;
  const solvedCount = PUZZLES.filter((item) => save.solved[item.id]).length;
  app!.innerHTML = "";
  const screen = document.createElement("div");
  screen.className = "screen select-screen";
  const doneAll = solvedCount === PUZZLES.length;
  screen.innerHTML = `
    <div class="select-inner">
      <header class="mast">
        <div class="brand">
          <div class="seal">巧</div>
          <div>
            <h1>七巧板</h1>
            <p class="lede">七块板，一个影子。拖到合适的位置，转一转，平行四边形还可以翻面。铺满、不重叠，就算拼好了。</p>
            <p class="progress-line">${doneAll ? "十六关都拼好了。想再玩，或去自由拼摆。" : `已完成 ${solvedCount} / ${PUZZLES.length}`}</p>
          </div>
        </div>
        <div class="mast-actions">
          <button class="btn" id="open-free" type="button">自由拼摆</button>
        </div>
      </header>
      <div class="grid" id="level-grid"></div>
    </div>
    <div class="toast" role="status"></div>
  `;
  app!.appendChild(screen);
  const grid = screen.querySelector("#level-grid");
  PUZZLES.forEach((item, index) => {
    const record = save.solved[item.id];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `card${record ? " solved" : ""}`;
    button.innerHTML = `
      ${miniSilhouette(item)}
      ${record ? '<span class="done-mark">成</span>' : ""}
      <span class="card-name">${item.name}</span>
      <span class="card-meta"><span>${DIFF[item.difficulty] ?? ""}</span><span>${record ? `${record.moves} 步` : `第 ${index + 1} 关`}</span></span>
    `;
    button.addEventListener("click", () => mountPlay(item));
    grid?.appendChild(button);
  });
  screen.querySelector("#open-free")?.addEventListener("click", () => mountPlay(null));
}

window.addEventListener("keydown", (event) => {
  if (mode !== "play") return;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "z") {
    event.preventDefault();
    onUndo();
    return;
  }
  if (won) return;
  if (key === "q" || key === "e" || key === "r") {
    event.preventDefault();
    onRotate(key === "q" ? -1 : 1);
    return;
  }
  if (key === "f") {
    event.preventDefault();
    onFlip();
    return;
  }
  if (key === "h") {
    event.preventDefault();
    onHint();
    return;
  }
  if (key === "escape") {
    selected = null;
    syncAll();
    updateHud();
    return;
  }
  const nudge: Record<string, Pt> = {
    arrowleft: [-1, 0],
    arrowright: [1, 0],
    arrowup: [0, -1],
    arrowdown: [0, 1],
  };
  const dir = nudge[key];
  if (!dir || !selected) return;
  const piece = selectedPiece();
  if (!piece) return;
  event.preventDefault();
  const step = event.shiftKey ? 0.5 : 0.25;
  const origin = JSON.stringify(piece);
  beginChange();
  piece.x += dir[0] * step;
  piece.y += dir[1] * step;
  applySnap(piece, true);
  finishChange(origin, piece);
});

window.addEventListener("resize", () => {
  if (mode !== "play") return;
  const nextPortrait = window.innerWidth < 900;
  if (nextPortrait === portrait) return;
  portrait = nextPortrait;
  const laid = layout(puzzle, portrait);
  homes = laid.homes;
  view = laid.view;
  for (const piece of pieces) {
    if (!piece.atHome) continue;
    const home = homes[piece.slot];
    piece.x = home.x;
    piece.y = home.y;
    piece.r = home.r;
    piece.f = home.f;
  }
  if (!svg) return;
  drawBoard(laid.mat);
  for (const piece of pieces) bindPiece(piece.slot);
  applyView();
  syncAll();
});

showSelect();

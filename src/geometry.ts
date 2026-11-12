export type Pt = [number, number];
export type Kind = "big" | "medium" | "small" | "square" | "para";
export type Slot = "big1" | "big2" | "medium" | "small1" | "small2" | "square" | "para";

export const SLOTS: Slot[] = ["big1", "big2", "medium", "small1", "small2", "square", "para"];

export const KIND: Record<Slot, Kind> = {
  big1: "big",
  big2: "big",
  medium: "medium",
  small1: "small",
  small2: "small",
  square: "square",
  para: "para",
};

export const COLORS: Record<Slot, string> = {
  big1: "#e1543c",
  big2: "#ef8b2f",
  medium: "#e2b431",
  small1: "#3c9d78",
  small2: "#3b8fbf",
  square: "#5c6fd6",
  para: "#d15b8a",
};

export const LABELS: Record<Slot, string> = {
  big1: "大红三角",
  big2: "橙红三角",
  medium: "中三角",
  small1: "小绿三角",
  small2: "小青三角",
  square: "正方形",
  para: "平行四边形",
};

const R2 = Math.SQRT2;
const H = R2 / 2;
/** Clockwise on a y-down board, in 45° steps. */
const COS = [1, H, 0, -H, -1, -H, 0, H];
const SIN = [0, H, 1, H, 0, -H, -1, -H];

export const SHAPES: Record<Kind, Pt[]> = {
  big: [
    [0, 0],
    [2, 0],
    [0, 2],
  ],
  medium: [
    [0, 0],
    [R2, 0],
    [0, R2],
  ],
  small: [
    [0, 0],
    [1, 0],
    [0, 1],
  ],
  square: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  para: [
    [0, 0],
    [1, 0],
    [2, 1],
    [1, 1],
  ],
};

export const AREA: Record<Kind, number> = {
  big: 2,
  medium: 1,
  small: 0.5,
  square: 1,
  para: 1,
};

export function mod8(r: number): number {
  return ((Math.round(r) % 8) + 8) % 8;
}

/** Mirror in x, rotate about the local origin, then translate. */
export function place(kind: Kind, x: number, y: number, r: number, flip: boolean): Pt[] {
  const k = mod8(r);
  const co = COS[k] ?? 1;
  const si = SIN[k] ?? 0;
  return SHAPES[kind].map(([px, py]) => {
    const lx = flip ? -px : px;
    return [x + lx * co - py * si, y + lx * si + py * co];
  });
}

export function centroid(poly: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const [px, py] of poly) {
    x += px;
    y += py;
  }
  return [x / poly.length, y / poly.length];
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bbox(polys: Pt[][]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

export function polygonArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

export function pointsAttr(poly: Pt[]): string {
  return poly.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
}

/** Translation that makes `poly` sit on `target`, if they are the same shape within maxErr. */
export function aligningTranslation(poly: Pt[], target: Pt[], maxErr: number): Pt | null {
  const [ax, ay] = centroid(poly);
  const [bx, by] = centroid(target);
  const dx = bx - ax;
  const dy = by - ay;
  let worst = 0;
  for (const [x, y] of poly) {
    let best = Infinity;
    for (const [tx, ty] of target) {
      best = Math.min(best, Math.hypot(x + dx - tx, y + dy - ty));
    }
    worst = Math.max(worst, best);
  }
  for (const [tx, ty] of target) {
    let best = Infinity;
    for (const [x, y] of poly) {
      best = Math.min(best, Math.hypot(x + dx - tx, y + dy - ty));
    }
    worst = Math.max(worst, best);
  }
  return worst <= maxErr ? [dx, dy] : null;
}

function pointInPoly(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Coverage {
  miss: number;
  spill: number;
  overlap: number;
}

/** How completely `pieces` cover `targets`. Ratios are relative to the target area. */
export function coverageScore(targets: Pt[][], pieces: Pt[][], step = 0.05): Coverage {
  const box = bbox(targets);
  const margin = 0.55;
  let target = 0;
  let miss = 0;
  let spill = 0;
  let overlap = 0;
  for (let y = box.minY - margin; y < box.maxY + margin; y += step) {
    for (let x = box.minX - margin; x < box.maxX + margin; x += step) {
      let inTarget = false;
      for (const poly of targets) {
        if (pointInPoly(poly, x, y)) {
          inTarget = true;
          break;
        }
      }
      let hits = 0;
      for (const poly of pieces) {
        if (pointInPoly(poly, x, y)) hits++;
      }
      if (inTarget) target++;
      if (inTarget && hits === 0) miss++;
      if (!inTarget && hits > 0) spill++;
      if (hits > 1) overlap++;
    }
  }
  if (target === 0) return { miss: 1, spill: 1, overlap: 1 };
  return { miss: miss / target, spill: spill / target, overlap: overlap / target };
}

export function isSolved(score: Coverage): boolean {
  return score.miss <= 0.03 && score.spill <= 0.03 && score.overlap <= 0.03;
}

export function sharedEdgeLength(a: Pt[], b: Pt[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    const ax = a2[0] - a1[0];
    const ay = a2[1] - a1[1];
    const alen = Math.hypot(ax, ay);
    if (alen < 1e-9) continue;
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      const bx = b2[0] - b1[0];
      const by = b2[1] - b1[1];
      const blen = Math.hypot(bx, by);
      if (blen < 1e-9) continue;
      if (Math.abs(ax * by - ay * bx) > 1e-5 * alen * blen) continue;
      if (Math.abs(ax * (b1[1] - a1[1]) - ay * (b1[0] - a1[0])) > 1e-5 * alen) continue;
      const proj = (x: number, y: number) => ((x - a1[0]) * ax + (y - a1[1]) * ay) / (alen * alen);
      const t1 = proj(b1[0], b1[1]);
      const t2 = proj(b2[0], b2[1]);
      const lo = Math.max(0, Math.min(t1, t2));
      const hi = Math.min(1, Math.max(t1, t2));
      if (hi - lo > 1e-4) total += (hi - lo) * alen;
    }
  }
  return total;
}

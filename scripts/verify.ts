import { readFileSync } from "node:fs";
import {
  AREA,
  KIND,
  coverageScore,
  isSolved,
  place,
  polygonArea,
  sharedEdgeLength,
  type Slot,
} from "../src/geometry.ts";

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
  pieces: Placement[];
}

const puzzles = JSON.parse(
  readFileSync(new URL("../src/data/puzzles.json", import.meta.url), "utf8"),
) as Puzzle[];

let failed = 0;
for (const puzzle of puzzles) {
  if (puzzle.pieces.length !== 7) {
    console.error(puzzle.id, "expected 7 pieces");
    failed++;
    continue;
  }
  const polys = puzzle.pieces.map((p) => place(KIND[p.slot], p.x, p.y, p.r, p.f === 1));
  let areaOk = true;
  for (let i = 0; i < puzzle.pieces.length; i++) {
    const kind = KIND[puzzle.pieces[i].slot];
    if (Math.abs(polygonArea(polys[i]) - AREA[kind]) > 1e-4) areaOk = false;
    if (puzzle.pieces[i].slot !== "para" && puzzle.pieces[i].f !== 0) {
      console.error(puzzle.id, "non-para flipped");
      failed++;
    }
  }
  let shared = 0;
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) shared += sharedEdgeLength(polys[i], polys[j]);
  }
  const parent = polys.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (sharedEdgeLength(polys[i], polys[j]) > 0.2) parent[find(i)] = find(j);
    }
  }
  const root = find(0);
  const connected = polys.every((_, i) => find(i) === root);
  const exact = coverageScore(polys, polys);
  const scrambled = polys.map((poly, i) => poly.map(([x, y]) => [x + 5, y + i * 1.4] as [number, number]));
  const bad = coverageScore(polys, scrambled);
  // 对角线栅格采样会留下不足一格的数值毛刺，不算真重叠。
  const ok =
    areaOk &&
    connected &&
    shared > 3 &&
    isSolved(exact) &&
    !isSolved(bad) &&
    exact.miss === 0 &&
    exact.spill === 0 &&
    exact.overlap < 0.002;
  if (!ok) {
    failed++;
    console.error(puzzle.id, { areaOk, connected, shared: +shared.toFixed(2), exact, bad });
  } else {
    console.log(`ok  ${puzzle.name}（${puzzle.id}）  贴合 ${shared.toFixed(2)}`);
  }
}

if (failed) {
  console.error(`\n${failed} puzzle(s) failed`);
  process.exit(1);
}
console.log(`\n${puzzles.length} 关全部可解，精确拼合会判定胜利，散开不会。`);

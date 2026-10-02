import type { Point } from './types';

export type CostFn = (x: number, y: number) => number;

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 4方向A*。cost が Infinity のタイルは通れない。
 * 戻り値は from を含まず to を含むタイル列。到達不能なら null。
 */
export function findPath(
  width: number,
  height: number,
  cost: CostFn,
  from: Point,
  to: Point,
): Point[] | null {
  if (!Number.isFinite(cost(to.x, to.y))) return null;

  const n = width * height;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const start = from.y * width + from.x;
  const goal = to.y * width + to.x;
  const h = (i: number) => Math.abs((i % width) - to.x) + Math.abs(Math.floor(i / width) - to.y);

  g[start] = 0;
  const open = [start];
  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (g[open[i]] + h(open[i]) < g[open[best]] + h(open[best])) best = i;
    }
    const cur = open[best];
    open[best] = open[open.length - 1];
    open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;

    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const c = cost(nx, ny);
      if (!Number.isFinite(c)) continue;
      const ni = ny * width + nx;
      const ng = g[cur] + c;
      if (ng < g[ni]) {
        g[ni] = ng;
        prev[ni] = cur;
        open.push(ni);
      }
    }
  }

  if (!Number.isFinite(g[goal])) return null;
  const path: Point[] = [];
  for (let i = goal; i !== start; i = prev[i]) {
    path.push({ x: i % width, y: Math.floor(i / width) });
  }
  return path.reverse();
}

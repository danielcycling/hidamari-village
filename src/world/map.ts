import { findPath } from './pathfind';
import type { Point, Tile, WorldMap } from './types';

/** 道を好んで歩くように、地面ごとに歩きにくさを変える */
const WALK_COST: Record<Tile, number> = {
  path: 1,
  stone: 1,
  bridge: 1,
  dock: 1,
  grass: 2.5,
  flower: 2.5,
  field: 3,
  woods: 2.5,
  water: Infinity,
  tree: Infinity,
  building: Infinity,
  fountain: Infinity,
};

export function tileAt(map: WorldMap, x: number, y: number): Tile | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  return map.tiles[y * map.width + x];
}

export function isWalkable(map: WorldMap, x: number, y: number): boolean {
  const t = tileAt(map, x, y);
  return t !== undefined && Number.isFinite(WALK_COST[t]);
}

export function findWalkPath(map: WorldMap, from: Point, to: Point): Point[] | null {
  return findPath(
    map.width,
    map.height,
    (x, y) => WALK_COST[map.tiles[y * map.width + x]],
    from,
    to,
  );
}

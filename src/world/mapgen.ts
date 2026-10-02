import { mulberry32, type Rng } from '../core/rng';
import { findPath } from './pathfind';
import type { FacilityUse, Place, PlaceKind, Point, Rect, Tile, WorldMap } from './types';

export const MAP_W = 40;
export const MAP_H = 24;

const MAIN_ROAD_Y = 12;
const LANE_Y = 21;
const AVENUE_X = 18;

interface BuildingDef {
  id: string;
  name: string;
  kind: PlaceKind;
  rect: Rect;
  roof: string;
  wall: string;
  use?: FacilityUse;
  capacity?: number;
}

const BUILDINGS: BuildingDef[] = [
  { id: 'bakery', name: 'パン焼き小屋', kind: 'facility', use: 'bake', capacity: 1, rect: { x: 6, y: 5, w: 5, h: 4 }, roof: '#c0504d', wall: '#f3e2c7' },
  { id: 'hall', name: '集会所', kind: 'facility', use: 'hall', rect: { x: 21, y: 3, w: 7, h: 4 }, roof: '#4f6fa8', wall: '#efe9dc' },
  { id: 'kitchen', name: '食堂', kind: 'facility', use: 'cook', capacity: 2, rect: { x: 22, y: 17, w: 5, h: 4 }, roof: '#7a4a8c', wall: '#d9c2a0' },
  { id: 'home_1', name: '空き家', kind: 'home', rect: { x: 2, y: 6, w: 3, h: 3 }, roof: '#e08a3c', wall: '#f5ead6' },
  { id: 'home_2', name: '空き家', kind: 'home', rect: { x: 12, y: 3, w: 3, h: 3 }, roof: '#5a7ec7', wall: '#efe6d6' },
  { id: 'home_3', name: '空き家', kind: 'home', rect: { x: 35, y: 5, w: 3, h: 3 }, roof: '#6b6b6b', wall: '#e3d8c4' },
  { id: 'home_4', name: '空き家', kind: 'home', rect: { x: 2, y: 14, w: 3, h: 3 }, roof: '#8c6a3f', wall: '#eee3d0' },
  { id: 'home_5', name: '空き家', kind: 'home', rect: { x: 4, y: 18, w: 3, h: 3 }, roof: '#5a9e6f', wall: '#f0e6d2' },
  { id: 'home_6', name: '空き家', kind: 'home', rect: { x: 10, y: 18, w: 3, h: 3 }, roof: '#c76b98', wall: '#f7ece0' },
  { id: 'home_7', name: '空き家', kind: 'home', rect: { x: 27, y: 8, w: 3, h: 3 }, roof: '#3f8c8c', wall: '#ece4d4' },
  { id: 'home_8', name: '空き家', kind: 'home', rect: { x: 14, y: 18, w: 3, h: 3 }, roof: '#b08a3c', wall: '#f1e7d6' },
];

export const HOME_IDS = BUILDINGS.filter((b) => b.kind === 'home').map((b) => b.id);
/** 最初の住民の数（残りの家は新入村民用の空き家） */
export const FOUNDER_COUNT = 6;
/** 新入村民が村に入ってくる場所（西の端の道） */
export const VILLAGE_ENTRANCE: Point = { x: 0, y: MAIN_ROAD_Y };

const PLAZA: Rect = { x: 14, y: 9, w: 9, h: 7 };
const FIELD: Rect = { x: 35, y: 15, w: 4, h: 5 };
const FISHING: Rect = { x: 29, y: 13, w: 3, h: 3 };
const FOUNTAIN: Rect = { x: 17, y: 10, w: 2, h: 2 };

export function generateMap(seed: number): WorldMap {
  const rng = mulberry32(seed);
  const tiles: Tile[] = new Array<Tile>(MAP_W * MAP_H).fill('grass');
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
  const get = (x: number, y: number) => (inBounds(x, y) ? tiles[y * MAP_W + x] : undefined);
  const set = (x: number, y: number, t: Tile) => {
    if (inBounds(x, y)) tiles[y * MAP_W + x] = t;
  };
  const fill = (r: Rect, t: Tile) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) set(x, y, t);
  };
  const lay = (x: number, y: number) => set(x, y, get(x, y) === 'water' ? 'bridge' : 'path');

  // 川（ゆるく蛇行）
  for (let y = 0; y < MAP_H; y++) {
    const rx = 32 + Math.round(Math.sin(y * 0.45));
    set(rx, y, 'water');
    set(rx + 1, y, 'water');
  }

  // 道
  for (let x = 0; x < MAP_W; x++) lay(x, MAIN_ROAD_Y);
  for (let x = 2; x <= 30; x++) lay(x, LANE_Y);
  for (let y = 2; y <= LANE_Y; y++) lay(AVENUE_X, y);

  fill(PLAZA, 'stone');
  fill(FOUNTAIN, 'fountain');
  fill(FIELD, 'field');
  fill({ x: FISHING.x + FISHING.w - 1, y: FISHING.y, w: 1, h: FISHING.h }, 'dock');

  // 建物と、入口から大通りへの小道
  const places: Record<string, Place> = {};
  for (const def of BUILDINGS) {
    const { rect } = def;
    fill(rect, 'building');
    const door = { x: rect.x + Math.floor(rect.w / 2), y: rect.y + rect.h - 1 };
    const spot = { x: door.x, y: door.y + 1 };
    // 大通りより上なら大通りへ、下なら裏道へつなぐ
    const [fromY, toY] = spot.y < MAIN_ROAD_Y ? [spot.y, MAIN_ROAD_Y] : [spot.y, LANE_Y];
    for (let y = fromY; y < toY; y++) {
      if (get(spot.x, y) === 'grass' || get(spot.x, y) === 'water') lay(spot.x, y);
    }
    places[def.id] = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      spot,
      building: { rect, door, roof: def.roof, wall: def.wall },
      use: def.use,
      capacity: def.capacity,
    };
  }
  places.plaza = { id: 'plaza', name: '広場', kind: 'public', use: 'market', spot: { x: AVENUE_X, y: 13 }, area: PLAZA };
  places.fishing = {
    id: 'fishing',
    name: '釣り場',
    kind: 'facility',
    use: 'fish',
    capacity: 3,
    spot: { x: FISHING.x + 1, y: FISHING.y },
    area: FISHING,
  };
  const fieldSpot = { x: FIELD.x + 1, y: FIELD.y - 1 };
  for (let y = MAIN_ROAD_Y + 1; y <= fieldSpot.y; y++) lay(fieldSpot.x, y);
  places.gate = { id: 'gate', name: '村の入り口', kind: 'public', spot: VILLAGE_ENTRANCE };
  places.field = { id: 'field', name: '畑', kind: 'facility', use: 'farm', capacity: 4, spot: fieldSpot, area: FIELD };

  scatterNature(rng, tiles, get, set);
  clearBlockedRoutes(tiles, Object.values(places).map((p) => p.spot));

  return { width: MAP_W, height: MAP_H, tiles, places, fountain: FOUNTAIN };
}

function scatterNature(
  rng: Rng,
  tiles: Tile[],
  get: (x: number, y: number) => Tile | undefined,
  set: (x: number, y: number, t: Tile) => void,
) {
  const keepClear = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = get(x + dx, y + dy);
        if (t === 'building' || t === 'path' || t === 'stone' || t === 'bridge' || t === 'field' || t === 'dock') return true;
      }
    }
    return false;
  };
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y * MAP_W + x] !== 'grass' || keepClear(x, y)) continue;
      const edge = x < 2 || y < 2 || x >= MAP_W - 2 || y >= MAP_H - 2;
      const r = rng();
      if (r < (edge ? 0.45 : 0.07)) set(x, y, 'tree');
      else if (r < (edge ? 0.5 : 0.12)) set(x, y, 'flower');
    }
  }
}

/** 木で塞がれた場所があれば、その経路上の木を切って全ての場所へ行けるようにする */
function clearBlockedRoutes(tiles: Tile[], spots: Point[]) {
  const [origin, ...rest] = spots;
  for (const spot of rest) {
    const route = findPath(
      MAP_W,
      MAP_H,
      (x, y) => {
        const t = tiles[y * MAP_W + x];
        if (t === 'tree') return 50;
        return t === 'water' || t === 'building' || t === 'fountain' ? Infinity : 1;
      },
      origin,
      spot,
    );
    for (const p of route ?? []) {
      if (tiles[p.y * MAP_W + p.x] === 'tree') tiles[p.y * MAP_W + p.x] = 'grass';
    }
  }
}

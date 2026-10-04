export type Tile =
  | 'grass'
  | 'flower'
  | 'path'
  | 'stone'
  | 'water'
  | 'bridge'
  | 'tree'
  | 'field'
  | 'building'
  | 'fountain'
  | 'dock'
  | 'woods';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PlaceKind = 'home' | 'facility' | 'public';

/** 設備でできること */
export type FacilityUse = 'farm' | 'fish' | 'bake' | 'cook' | 'market' | 'hall' | 'chop';

export interface Building {
  rect: Rect;
  door: Point;
  roof: string;
  wall: string;
}

/** 住民が向かう場所。建物（中に入る）か、屋外エリア（中を歩き回る）のどちらか */
export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  /** 建物の入口の前のタイル */
  spot: Point;
  building?: Building;
  area?: Rect;
  use?: FacilityUse;
  /** 同時に使える人数（なければ無制限） */
  capacity?: number;
}

export interface WorldMap {
  width: number;
  height: number;
  tiles: Tile[];
  places: Record<string, Place>;
  fountain: Rect;
}

export const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

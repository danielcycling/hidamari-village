import { hash2 } from '../core/rng';
import { SLEEP_ACTIVITY } from '../world/residents';
import type { Resident, Simulation } from '../world/sim';
import type { Building, Rect, Tile, WorldMap } from '../world/types';
import { drawCharacter, drawMiniFace, spriteHeight, SPRITE_W } from './sprites';

export const TILE = 16;
/** キャンバスの解像度倍率（ドットはくっきり、文字は読みやすく） */
const SCALE = 3;
const FONT = '"DotGothic16", system-ui, sans-serif';

interface HitBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Renderer {
  selectedId: string | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mapLayer: HTMLCanvasElement;
  private hitBoxes: HitBox[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: WorldMap,
  ) {
    canvas.width = map.width * TILE * SCALE;
    canvas.height = map.height * TILE * SCALE;
    this.ctx = canvas.getContext('2d')!;
    this.mapLayer = renderStaticLayer(map);
  }

  /** キャンバス上のクリック位置にいる住民のID */
  hitTest(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.map.width * TILE;
    const y = ((clientY - rect.top) / rect.height) * this.map.height * TILE;
    const hit = [...this.hitBoxes]
      .reverse()
      .find((b) => x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2);
    return hit?.id ?? null;
  }

  render(sim: Simulation, now: number): void {
    const { ctx, map } = this;
    this.hitBoxes = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mapLayer, 0, 0);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);

    this.drawWater(now);
    this.drawFountain(now);

    for (const g of sim.graves) this.drawGrave(g.at.x, g.at.y);
    const outdoors = sim.residents.filter((r) => !r.indoors).sort((a, b) => a.y - b.y);
    for (const r of outdoors) this.drawResident(r);

    const hour = sim.clock.hourOfDay;
    const festival = sim.activeGathering();
    if (festival) this.drawLanterns(festival.placeId, now);
    if (sim.weather.kind === 'rain') this.drawRain(now);
    this.drawLighting(sim, hour);
    if (festival) this.drawLanternGlow(festival.placeId, hour);

    for (const place of Object.values(map.places)) {
      if (place.area) {
        label(ctx, place.name, (place.area.x + place.area.w / 2) * TILE, place.area.y * TILE + 7, 6, '#fff8e6');
      }
    }
    for (const g of sim.graves) label(ctx, g.name, g.at.x * TILE + 8, g.at.y * TILE + 2, 5, '#cfd3dc');

    // 吹き出しは名前や顔に隠れないよう、最後にまとめて描く
    const bubbles: PendingBubble[] = [];
    for (const place of Object.values(map.places)) {
      if (place.building) this.drawBuildingOverlay(sim, place.id, place.name, place.building, now, bubbles);
    }
    for (const r of outdoors) this.drawResidentOverlay(sim, r, now, bubbles);
    for (const b of bubbles) bubble(ctx, b.text, b.cx, b.bottom, map.width * TILE);
  }

  private drawWater(now: number) {
    const { ctx, map } = this;
    ctx.fillStyle = 'rgba(200, 230, 255, 0.7)';
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.tiles[y * map.width + x] !== 'water') continue;
        const h = hash2(x, y);
        const o = Math.floor(now / 180 + h * 16) % 16;
        ctx.fillRect(x * TILE + o, y * TILE + 4 + Math.floor(h * 4), 3, 1);
        ctx.fillRect(x * TILE + ((o + 8) % 16), y * TILE + 11, 2, 1);
      }
    }
  }

  private drawFountain(now: number) {
    const { ctx } = this;
    const r = this.map.fountain;
    const x = r.x * TILE;
    const y = r.y * TILE;
    ctx.fillStyle = '#8f897c';
    ctx.fillRect(x + 2, y + 5, 28, 24);
    ctx.fillRect(x + 4, y + 3, 24, 28);
    ctx.fillStyle = '#d6d0c3';
    ctx.fillRect(x + 4, y + 5, 24, 24);
    ctx.fillStyle = '#5aa0e0';
    ctx.fillRect(x + 6, y + 7, 20, 20);
    ctx.fillStyle = '#e8e4d8';
    ctx.fillRect(x + 14, y + 10, 4, 12);
    ctx.fillStyle = '#bfe3ff';
    for (let i = 0; i < 6; i++) {
      const t = ((now / 600 + i / 6) % 1 + 1) % 1;
      const dir = i % 2 === 0 ? 1 : -1;
      const sx = x + 16 + dir * (2 + t * 8) - 1;
      const sy = y + 10 - Math.sin(t * Math.PI) * 6 + t * 10;
      ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1);
    }
  }

  private drawResident(r: Resident) {
    const { ctx } = this;
    const h = spriteHeight(false);
    const px = Math.round(r.x * TILE + (TILE - SPRITE_W) / 2);
    const py = Math.round(r.y * TILE + TILE - h - 1);
    const frame = r.state === 'walking' ? 1 + (Math.floor(r.stride * 3) % 2) : 0;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(px + 1, py + h - 1, SPRITE_W - 2, 2);
    drawCharacter(ctx, r.profile.colors, px, py, { frame, facing: r.facing, child: false });
    this.hitBoxes.push({ id: r.profile.id, x: px, y: py, w: SPRITE_W, h });
  }

  private drawResidentOverlay(sim: Simulation, r: Resident, now: number, bubbles: PendingBubble[]) {
    const h = spriteHeight(false);
    const cx = r.x * TILE + TILE / 2;
    const top = r.y * TILE + TILE - h - 1;
    label(this.ctx, r.profile.name, cx, r.y * TILE + TILE + 7, 6, hungerColor(r.satiety));
    if (r.shop) label(this.ctx, '店', cx + 8, top + 4, 5, '#ffd36b');
    if (this.selectedId === r.profile.id) {
      drawPointer(this.ctx, cx, top - 3 + Math.sin(now / 200) * 1.5);
    }
    const text = speechOf(sim, r, now);
    if (text) bubbles.push({ text, cx, bottom: top - 2 });
  }

  private drawBuildingOverlay(
    sim: Simulation,
    placeId: string,
    name: string,
    b: Building,
    now: number,
    bubbles: PendingBubble[],
  ) {
    const { ctx } = this;
    const bx = b.rect.x * TILE;
    const by = b.rect.y * TILE;
    const bw = b.rect.w * TILE;
    label(ctx, name, bx + bw / 2, by + 10, 6.5, '#fff8e6');

    const inside = sim.residents.filter((r) => r.indoors && r.placeId === placeId);
    const startX = bx + bw / 2 - (inside.length * 8) / 2 + 1;
    inside.forEach((r, i) => {
      const fx = Math.round(startX + i * 8);
      const fy = by - 8;
      drawMiniFace(ctx, r.profile.colors, fx, fy);
      this.hitBoxes.push({ id: r.profile.id, x: fx - 1, y: fy - 1, w: 7, h: 7 });
      if (r.activity === SLEEP_ACTIVITY) {
        const t = (now / 1500 + i * 0.3) % 1;
        ctx.globalAlpha = 1 - t;
        label(ctx, 'z', fx + 6 + t * 3, fy - t * 6, 4, '#dfe8ff');
        ctx.globalAlpha = 1;
      }
      if (this.selectedId === r.profile.id) {
        drawPointer(ctx, fx + 2.5, fy - 2 + Math.sin(now / 200) * 1.5);
      }
      const text = speechOf(sim, r, now);
      if (text) bubbles.push({ text, cx: fx + 2.5, bottom: fy - 2 });
    });
  }

  private drawGrave(tx: number, ty: number) {
    const { ctx } = this;
    const x = tx * TILE + 4;
    const y = ty * TILE + 4;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(x + 1, y + 10, 9, 2);
    ctx.fillStyle = '#6f7480';
    ctx.fillRect(x, y + 1, 8, 10);
    ctx.fillRect(x + 1, y, 6, 1);
    ctx.fillStyle = '#9aa0ab';
    ctx.fillRect(x + 1, y + 1, 6, 9);
    ctx.fillStyle = '#6f7480';
    ctx.fillRect(x + 3, y + 3, 2, 5);
    ctx.fillRect(x + 2, y + 4, 4, 1);
  }

  private drawRain(now: number) {
    const { ctx, map } = this;
    const w = map.width * TILE;
    const h = map.height * TILE;
    ctx.fillStyle = 'rgba(40, 55, 85, 0.28)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(190, 215, 255, 0.55)';
    for (let i = 0; i < 260; i++) {
      const speed = 0.18 + hash2(i, 7) * 0.08;
      const x = (hash2(i, 1) * w + now * speed * 0.35) % w;
      const y = (hash2(i, 2) * h + now * speed) % h;
      ctx.fillRect(Math.floor(x), Math.floor(y), 1, 4);
    }
  }

  /** お祭りの提灯の位置（会場のふち） */
  private lanternSpots(placeId: string): { x: number; y: number }[] {
    const area = this.map.places[placeId]?.area;
    if (!area) return [];
    const spots = [];
    for (let x = area.x; x < area.x + area.w; x += 2) {
      spots.push({ x: x * TILE + 8, y: area.y * TILE + 2 });
      spots.push({ x: x * TILE + 8, y: (area.y + area.h) * TILE - 4 });
    }
    return spots;
  }

  private drawLanterns(placeId: string, now: number) {
    const { ctx } = this;
    for (const [i, p] of this.lanternSpots(placeId).entries()) {
      const sway = Math.round(Math.sin(now / 500 + i) * 0.6);
      ctx.fillStyle = '#3a2a1a';
      ctx.fillRect(p.x, p.y - 3, 1, 2);
      ctx.fillStyle = i % 2 === 0 ? '#e0483a' : '#f08a2a';
      ctx.fillRect(p.x - 2 + sway, p.y - 1, 5, 5);
      ctx.fillStyle = '#ffd36b';
      ctx.fillRect(p.x - 1 + sway, p.y, 3, 3);
    }
  }

  private drawLanternGlow(placeId: string, hour: number) {
    const dark = darkness(hour);
    if (dark <= 0) return;
    const { ctx } = this;
    for (const p of this.lanternSpots(placeId)) {
      const g = ctx.createRadialGradient(p.x, p.y + 1, 0, p.x, p.y + 1, 18);
      g.addColorStop(0, `rgba(255, 170, 80, ${dark * 0.6})`);
      g.addColorStop(1, 'rgba(255, 170, 80, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x - 18, p.y - 17, 36, 36);
      ctx.fillStyle = '#ffd36b';
      ctx.fillRect(p.x - 1, p.y, 3, 3);
    }
  }

  private drawLighting(sim: Simulation, hour: number) {
    const { ctx, map } = this;
    const w = map.width * TILE;
    const h = map.height * TILE;
    const dusk = hour > 16 && hour < 19.5 ? Math.sin(((hour - 16) / 3.5) * Math.PI) : 0;
    if (dusk > 0) {
      ctx.fillStyle = `rgba(255, 140, 60, ${0.14 * dusk})`;
      ctx.fillRect(0, 0, w, h);
    }
    const dark = darkness(hour);
    if (dark <= 0) return;
    ctx.fillStyle = `rgba(16, 20, 52, ${dark})`;
    ctx.fillRect(0, 0, w, h);

    // 起きている人がいる建物は窓に明かりが灯る
    for (const place of Object.values(map.places)) {
      if (!place.building) continue;
      const awake = sim.residents.some(
        (r) => r.indoors && r.placeId === place.id && r.activity !== SLEEP_ACTIVITY,
      );
      if (!awake) continue;
      for (const win of windowRects(place.building)) {
        ctx.fillStyle = `rgba(255, 214, 110, ${0.4 + dark})`;
        ctx.fillRect(win.x, win.y, win.w, win.h);
        const g = ctx.createRadialGradient(win.x + 3, win.y + 3, 0, win.x + 3, win.y + 3, 14);
        g.addColorStop(0, `rgba(255, 200, 100, ${dark * 0.5})`);
        g.addColorStop(1, 'rgba(255, 200, 100, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(win.x - 12, win.y - 12, win.w + 24, win.h + 24);
      }
    }
  }
}

function darkness(hour: number): number {
  const night = 0.62;
  if (hour >= 7 && hour < 17) return 0;
  if (hour >= 17 && hour < 20) return ((hour - 17) / 3) * night;
  if (hour >= 5 && hour < 7) return (1 - (hour - 5) / 2) * night;
  return night;
}

/** 名前の色で空腹を知らせる */
function hungerColor(satiety: number): string {
  if (satiety <= 0) return '#ff6b6b';
  if (satiety < 30) return '#ffb347';
  return '#fff';
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color = '#fff') {
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(28, 22, 36, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

interface PendingBubble {
  text: string;
  cx: number;
  bottom: number;
}

/** その住民の頭上に出す吹き出しの文字（なければ null） */
function speechOf(sim: Simulation, r: Resident, now: number): string | null {
  const conv = r.conversation;
  if (!conv) return null;
  if (!conv.lines) {
    // AIが考え中。2人とも出すと重なるので、話しかけた側にだけ出す
    return conv.a === r ? '・'.repeat(1 + (Math.floor(now / 400) % 3)) : null;
  }
  const line = sim.currentLine(conv);
  return line?.speakerId === r.profile.id ? line.text : null;
}

const BUBBLE_MAX_W = 96;
const BUBBLE_LINE_H = 8;

/** 日本語は単語の区切りがないので1文字ずつ折り返す */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (cur && ctx.measureText(cur + ch).width > maxWidth) {
      lines.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function bubble(ctx: CanvasRenderingContext2D, text: string, cx: number, bottom: number, maxX: number) {
  ctx.font = `6px ${FONT}`;
  const lines = wrap(ctx, text, BUBBLE_MAX_W);
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const w = Math.max(14, textW + 7);
  const h = lines.length * BUBBLE_LINE_H + 3;
  const x = Math.min(Math.max(cx - w / 2, 1), maxX - w - 1);
  const y = Math.max(1, bottom - h - 2);
  ctx.fillStyle = '#fffdf5';
  ctx.strokeStyle = '#2a2233';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 2.5);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 2, y + h - 0.4);
  ctx.lineTo(cx, y + h + 2);
  ctx.lineTo(cx + 2, y + h - 0.4);
  ctx.fill();
  ctx.fillStyle = '#2a2233';
  ctx.textAlign = lines.length > 1 ? 'left' : 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const ty = y + 1.5 + BUBBLE_LINE_H * i + BUBBLE_LINE_H / 2 + 0.5;
    ctx.fillText(l, lines.length > 1 ? x + 3.5 : x + w / 2, ty);
  });
}

function drawPointer(ctx: CanvasRenderingContext2D, cx: number, bottom: number) {
  ctx.fillStyle = '#ffe14d';
  ctx.strokeStyle = '#2a2233';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(cx - 3, bottom - 5);
  ctx.lineTo(cx + 3, bottom - 5);
  ctx.lineTo(cx, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// ───────────── 静的レイヤー（地面・木・建物）は起動時に一度だけ描く ─────────────

function renderStaticLayer(map: WorldMap): HTMLCanvasElement {
  const layer = document.createElement('canvas');
  layer.width = map.width * TILE * SCALE;
  layer.height = map.height * TILE * SCALE;
  const ctx = layer.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) drawTile(ctx, map.tiles[y * map.width + x], x, y);
  }
  for (const place of Object.values(map.places)) {
    if (place.building) drawBuilding(ctx, place.building);
  }
  return layer;
}

const GROUND: Partial<Record<Tile, [string, string]>> = {
  grass: ['#7fb85a', '#6ca34b'],
  flower: ['#7fb85a', '#6ca34b'],
  tree: ['#7fb85a', '#6ca34b'],
  building: ['#7fb85a', '#6ca34b'],
  path: ['#dcc38c', '#c7ab72'],
  stone: ['#cfc9bb', '#b8b1a2'],
  fountain: ['#cfc9bb', '#b8b1a2'],
  water: ['#4f8fd0', '#4682c2'],
  bridge: ['#4f8fd0', '#4682c2'],
  dock: ['#a0703c', '#8a5e30'],
  field: ['#8a5a32', '#77492a'],
};

function drawTile(ctx: CanvasRenderingContext2D, tile: Tile, x: number, y: number) {
  const px = x * TILE;
  const py = y * TILE;
  const [base, speck] = GROUND[tile]!;
  ctx.fillStyle = base;
  ctx.fillRect(px, py, TILE, TILE);
  ctx.fillStyle = speck;
  for (let i = 0; i < 4; i++) {
    const sx = Math.floor(hash2(x * 7 + i, y * 13) * 15);
    const sy = Math.floor(hash2(x * 3, y * 11 + i) * 14);
    ctx.fillRect(px + sx, py + sy, 1, 2);
  }

  switch (tile) {
    case 'stone':
    case 'fountain':
      ctx.fillStyle = '#b3ac9d';
      ctx.fillRect(px, py + 15, TILE, 1);
      ctx.fillRect(px + (y % 2 === 0 ? 15 : 7), py, 1, TILE);
      break;
    case 'flower': {
      const colors = ['#f7a8c4', '#fff3a8', '#ffffff', '#c9a8f7'];
      for (let i = 0; i < 3; i++) {
        const fx = 2 + Math.floor(hash2(x + i * 5, y) * 11);
        const fy = 2 + Math.floor(hash2(x, y + i * 9) * 11);
        ctx.fillStyle = colors[Math.floor(hash2(x * i + 1, y * i + 2) * colors.length)];
        ctx.fillRect(px + fx, py + fy, 2, 2);
      }
      break;
    }
    case 'tree':
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(px + 3, py + 12, 11, 3);
      ctx.fillStyle = '#6b4a2b';
      ctx.fillRect(px + 6, py + 9, 4, 6);
      ctx.fillStyle = '#2f6b33';
      ctx.fillRect(px + 2, py + 2, 12, 9);
      ctx.fillRect(px + 3, py + 1, 10, 11);
      ctx.fillStyle = '#3f8a3f';
      ctx.fillRect(px + 3, py + 2, 9, 7);
      ctx.fillStyle = '#62ad55';
      ctx.fillRect(px + 4, py + 3, 4, 3);
      break;
    case 'field':
      for (let r = 2; r < TILE; r += 5) {
        ctx.fillStyle = '#6f4625';
        ctx.fillRect(px, py + r + 2, TILE, 1);
        ctx.fillStyle = '#7cc45a';
        for (let c = 2; c < TILE; c += 5) ctx.fillRect(px + c, py + r, 2, 2);
      }
      break;
    case 'dock':
      ctx.fillStyle = '#7a5228';
      for (let r = 0; r < TILE; r += 4) ctx.fillRect(px, py + r, TILE, 1);
      break;
    case 'bridge':
      ctx.fillStyle = '#a0703c';
      ctx.fillRect(px, py + 2, TILE, 12);
      ctx.fillStyle = '#7a5228';
      for (let c = 0; c < TILE; c += 4) ctx.fillRect(px + c, py + 2, 1, 12);
      ctx.fillStyle = '#5e3e1e';
      ctx.fillRect(px, py + 1, TILE, 2);
      ctx.fillRect(px, py + 13, TILE, 2);
      break;
    case 'grass':
    case 'path':
    case 'water':
    case 'building':
      break;
  }
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + 255 * amount)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

const roofHeight = (b: Building) => Math.floor(b.rect.h * TILE * 0.55);

function windowRects(b: Building): Rect[] {
  const wallTop = b.rect.y * TILE + roofHeight(b);
  const wins: Rect[] = [];
  for (let cx = b.rect.x; cx < b.rect.x + b.rect.w; cx++) {
    if (cx === b.door.x) continue;
    wins.push({ x: cx * TILE + 5, y: wallTop + 5, w: 6, h: 6 });
  }
  return wins;
}

function drawBuilding(ctx: CanvasRenderingContext2D, b: Building) {
  const x = b.rect.x * TILE;
  const y = b.rect.y * TILE;
  const w = b.rect.w * TILE;
  const h = b.rect.h * TILE;
  const roofH = roofHeight(b);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.fillRect(x + 3, y + 4, w, h);

  // 壁
  ctx.fillStyle = shade(b.wall, -0.35);
  ctx.fillRect(x, y + roofH, w, h - roofH);
  ctx.fillStyle = b.wall;
  ctx.fillRect(x + 1, y + roofH, w - 2, h - roofH - 1);
  ctx.fillStyle = shade(b.wall, -0.08);
  ctx.fillRect(x + 1, y + h - 4, w - 2, 3);

  // 屋根
  ctx.fillStyle = shade(b.roof, -0.3);
  ctx.fillRect(x - 2, y, w + 4, roofH + 2);
  ctx.fillStyle = b.roof;
  ctx.fillRect(x - 1, y + 1, w + 2, roofH);
  ctx.fillStyle = shade(b.roof, -0.12);
  for (let yy = y + 4; yy < y + roofH; yy += 4) ctx.fillRect(x - 1, yy, w + 2, 1);
  ctx.fillStyle = shade(b.roof, 0.15);
  ctx.fillRect(x - 1, y + 1, w + 2, 1);

  // 窓
  for (const win of windowRects(b)) {
    ctx.fillStyle = shade(b.wall, -0.45);
    ctx.fillRect(win.x - 1, win.y - 1, win.w + 2, win.h + 2);
    ctx.fillStyle = '#4a5d73';
    ctx.fillRect(win.x, win.y, win.w, win.h);
    ctx.fillStyle = '#8fb4d6';
    ctx.fillRect(win.x, win.y, 2, 2);
  }

  // 扉
  const dx = b.door.x * TILE + 4;
  const dy = y + h - 11;
  ctx.fillStyle = '#4a2c18';
  ctx.fillRect(dx - 1, dy - 1, 10, 12);
  ctx.fillStyle = '#7a4a2a';
  ctx.fillRect(dx, dy, 8, 11);
  ctx.fillStyle = '#e8c35a';
  ctx.fillRect(dx + 6, dy + 6, 1, 1);
}

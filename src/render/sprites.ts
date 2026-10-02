import type { Palette } from '../world/residents';

// h: 髪 s: 肌 e: 目 c: 服 p: ズボン k: 靴
const BODY = [
  '.hhhhhh.',
  'hhhhhhhh',
  'hssssssh',
  '.sesses.',
  '.ssssss.',
  '.cccccc.',
  'cccccccc',
  'sccccccs',
  '.cccccc.',
  '.pppppp.',
];

const LEGS = [
  ['.pp..pp.', '.kk..kk.'],
  ['.pp...p.', '.kk...k.'],
  ['..p..pp.', '..k..kk.'],
];

export const SPRITE_W = 8;

export function spriteHeight(child: boolean): number {
  return BODY.length + 2 - (child ? 1 : 0);
}

export interface SpriteOptions {
  /** 0: 立ち 1,2: 歩き */
  frame: number;
  facing: 1 | -1;
  child: boolean;
}

/** (px, py) を左上として 1px = 1ドットで描く */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  colors: Palette,
  px: number,
  py: number,
  { frame, facing, child }: SpriteOptions,
): void {
  const rows = [...(child ? BODY.filter((_, i) => i !== 8) : BODY), ...LEGS[frame]];
  const colorOf: Record<string, string> = {
    h: colors.hair,
    s: colors.skin,
    e: '#2a1f1a',
    c: colors.shirt,
    p: colors.pants,
    k: colors.shoes,
  };
  rows.forEach((row, y) => {
    for (let x = 0; x < SPRITE_W; x++) {
      const ch = row[facing === 1 ? x : SPRITE_W - 1 - x];
      if (ch === '.') continue;
      ctx.fillStyle = colorOf[ch];
      ctx.fillRect(px + x, py + y, 1, 1);
    }
  });
}

/** 建物の中にいる住民を示す小さな顔 */
export function drawMiniFace(ctx: CanvasRenderingContext2D, colors: Palette, px: number, py: number): void {
  ctx.fillStyle = '#2a1f1a';
  ctx.fillRect(px - 1, py - 1, 7, 7);
  ctx.fillStyle = colors.skin;
  ctx.fillRect(px, py, 5, 5);
  ctx.fillStyle = colors.hair;
  ctx.fillRect(px, py, 5, 2);
  ctx.fillStyle = '#2a1f1a';
  ctx.fillRect(px + 1, py + 3, 1, 1);
  ctx.fillRect(px + 3, py + 3, 1, 1);
}

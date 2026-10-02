import { drawCharacter, spriteHeight, SPRITE_W } from '../render/sprites';
import type { Palette } from '../world/residents';

/** 一覧や相関図で使う、住民の立ち絵 */
export function avatar(colors: Palette): HTMLCanvasElement {
  const scale = 4;
  const canvas = document.createElement('canvas');
  canvas.className = 'avatar';
  canvas.width = (SPRITE_W + 2) * scale;
  canvas.height = 13 * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  drawCharacter(ctx, colors, 1, 13 - spriteHeight(false), { frame: 0, facing: 1, child: false });
  return canvas;
}

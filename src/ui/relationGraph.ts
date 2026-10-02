import { affinityLabel } from '../ai/prompt';
import type { Resident, Simulation } from '../world/sim';
import { avatar } from './avatar';

// 好意（暖色）と反感（寒色）の両極。中間はグレー。暗い背景に対して検証済み
const POSITIVE = [0xe4, 0x58, 0x74];
const NEGATIVE = [0x4c, 0x8a, 0xe4];
const NEUTRAL = [0x6a, 0x64, 0x80];

/** 好感度 -100〜100 を色にする */
export function affinityColor(affinity: number): string {
  const t = Math.min(1, Math.abs(affinity) / 100);
  const pole = affinity >= 0 ? POSITIVE : NEGATIVE;
  const [r, g, b] = NEUTRAL.map((n, i) => Math.round(n + (pole[i] - n) * t));
  return `rgb(${r}, ${g}, ${b})`;
}

export function formatAffinity(affinity: number): string {
  return `${affinity > 0 ? '+' : ''}${affinity}（${affinityLabel(affinity)}）`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIZE = 320;
const NODE_R = 17;

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** 住民全員の気持ちを矢印でつないだ相関図 */
export class RelationGraph {
  private readonly root = document.getElementById('panel-graph')!;
  private readonly svg: SVGSVGElement;
  private readonly info: HTMLElement;

  constructor(
    private readonly sim: Simulation,
    private readonly onSelect: (id: string) => void,
  ) {
    this.root.innerHTML = `
      <p class="graph-help">矢印は「誰が誰をどう思っているか」。線の太さが気持ちの強さです。矢印か人物にカーソルを合わせると詳しく見られます。</p>
      <div class="graph-wrap"></div>
      <p class="graph-info" aria-live="polite"></p>
      <ul class="graph-legend">
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="${affinityColor(80)}" stroke-width="3"/></svg>好意</li>
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="${affinityColor(0)}" stroke-width="1.5"/></svg>ふつう</li>
        <li><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="${affinityColor(-80)}" stroke-width="3" stroke-dasharray="4 3"/></svg>反感（点線）</li>
      </ul>`;
    this.svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img', 'aria-label': '住民の相関図' });
    this.root.querySelector('.graph-wrap')!.append(this.svg);
    this.info = this.root.querySelector('.graph-info')!;
  }

  render(): void {
    const { sim, svg } = this;
    const residents = sim.residents;
    const center = SIZE / 2;
    const radius = SIZE / 2 - 38;
    const pos = new Map(
      residents.map((r, i) => {
        const angle = -Math.PI / 2 + (i / residents.length) * Math.PI * 2;
        return [r.profile.id, { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius }];
      }),
    );

    svg.replaceChildren();
    const defs = el('defs');
    const marker = el('marker', {
      id: 'arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 5,
      markerHeight: 5,
      orient: 'auto-start-reverse',
    });
    marker.append(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }));
    defs.append(marker);
    svg.append(defs);

    const edges = el('g', { class: 'edges' });
    svg.append(edges);
    for (const from of residents) {
      for (const to of residents) {
        if (from === to) continue;
        const rel = from.relations[to.profile.id];
        if (rel) edges.append(this.edge(from, to, rel.affinity, rel.impression, pos));
      }
    }

    const nodes = el('g', { class: 'nodes' });
    svg.append(nodes);
    for (const r of residents) nodes.append(this.node(r, pos.get(r.profile.id)!));
  }

  private edge(
    from: Resident,
    to: Resident,
    affinity: number,
    impression: string,
    pos: Map<string, { x: number; y: number }>,
  ): SVGGElement {
    const a = pos.get(from.profile.id)!;
    const b = pos.get(to.profile.id)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    // 行きと帰りの矢印が重ならないよう、進行方向の右側へふくらませる
    const bend = 16;
    const cx = (a.x + b.x) / 2 - uy * bend;
    const cy = (a.y + b.y) / 2 + ux * bend;
    const start = { x: a.x + ux * NODE_R - uy * 5, y: a.y + uy * NODE_R + ux * 5 };
    const end = { x: b.x - ux * (NODE_R + 2) - uy * 5, y: b.y - uy * (NODE_R + 2) + ux * 5 };
    const d = `M${start.x},${start.y} Q${cx},${cy} ${end.x},${end.y}`;
    const strength = Math.abs(affinity) / 100;

    const g = el('g', { class: 'edge', 'data-from': from.profile.id, 'data-to': to.profile.id });
    g.append(
      el('path', {
        d,
        fill: 'none',
        stroke: affinityColor(affinity),
        'stroke-width': 1 + strength * 3.5,
        'stroke-opacity': 0.35 + strength * 0.65,
        'stroke-dasharray': affinity < 0 ? '5 3' : 'none',
        'stroke-linecap': 'round',
        'marker-end': 'url(#arrow)',
      }),
      // 細い線でもカーソルを合わせやすいよう、透明な太い当たり判定を重ねる
      el('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 10, class: 'hit' }),
    );
    const describe = `${from.profile.name} → ${to.profile.name}：${formatAffinity(affinity)}「${impression}」`;
    g.addEventListener('pointerenter', () => this.highlight([g], describe));
    g.addEventListener('pointerleave', () => this.highlight(null, ''));
    return g;
  }

  private node(r: Resident, p: { x: number; y: number }): SVGGElement {
    const g = el('g', { class: 'node', tabindex: 0, role: 'button', 'aria-label': `${r.profile.name}の心を見る` });
    g.append(
      el('circle', { cx: p.x, cy: p.y, r: NODE_R, fill: '#342e44', stroke: r.profile.colors.shirt, 'stroke-width': 2.5 }),
      el('image', {
        href: avatar(r.profile.colors).toDataURL(),
        x: p.x - 10,
        y: p.y - 13,
        width: 20,
        height: 26,
        style: 'image-rendering: pixelated',
      }),
    );
    const label = el('text', { x: p.x, y: p.y + NODE_R + 13, 'text-anchor': 'middle', class: 'node-label' });
    label.textContent = r.profile.name;
    g.append(label);

    const related = () =>
      [...this.svg.querySelectorAll<SVGGElement>('.edge')].filter(
        (e) => e.dataset.from === r.profile.id || e.dataset.to === r.profile.id,
      );
    g.addEventListener('pointerenter', () => this.highlight(related(), this.summary(r)));
    g.addEventListener('pointerleave', () => this.highlight(null, ''));
    g.addEventListener('click', () => this.onSelect(r.profile.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.onSelect(r.profile.id);
      }
    });
    return g;
  }

  /** その人がいちばん好きな相手と、いちばん苦手な相手 */
  private summary(r: Resident): string {
    const rels = Object.entries(r.relations)
      .map(([id, rel]) => ({ name: this.sim.get(id)?.profile.name ?? '?', ...rel }))
      .sort((a, b) => b.affinity - a.affinity);
    if (rels.length === 0) return r.profile.name;
    const best = rels[0];
    const worst = rels[rels.length - 1];
    return `${r.profile.name}：いちばん好き ${best.name} ${formatAffinity(best.affinity)}／いちばん苦手 ${worst.name} ${formatAffinity(worst.affinity)}`;
  }

  private highlight(edges: SVGGElement[] | null, text: string) {
    this.svg.classList.toggle('focused', edges !== null);
    for (const e of this.svg.querySelectorAll('.edge')) e.classList.toggle('active', !!edges?.includes(e as SVGGElement));
    this.info.textContent = text;
  }
}

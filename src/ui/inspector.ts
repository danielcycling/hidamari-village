import { hungerLabel, knowledgeOf, secretsOf } from '../ai/prompt';
import { countItem, ITEM_IDS, ITEMS, SKILL_IDS, SKILLS } from '../world/economy';
import { ACTIONS } from '../world/planner';
import { HOME_LEVEL_NAMES, satisfactionLabel, type Resident, type Simulation } from '../world/sim';
import { avatar } from './avatar';
import { affinityColor, formatAffinity } from './relationGraph';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** 選んだ住民の心の中（状態・自己像・予定・持ち物・腕前・気持ち・記憶）を見せる */
export class Inspector {
  private readonly root = document.getElementById('panel-mind')!;
  private currentId: string | null = null;

  constructor(private readonly sim: Simulation) {}

  render(id: string | null): void {
    this.currentId = id;
    const r = id ? this.sim.get(id) : undefined;
    if (!r) {
      const message = id ? 'この人はもう村にいません。' : 'マップか下の一覧で住民を選ぶと、心の中を覗けます。';
      this.root.replaceChildren(el('p', 'mind-empty', message));
      return;
    }
    this.root.replaceChildren(
      this.head(r),
      this.state(r),
      this.selfImage(r),
      this.plan(r),
      this.belongings(r),
      this.ties(r),
      this.deeds(r),
      this.feelings(r),
      this.memories(r),
    );
  }

  /** 開いている間、数字が動くので定期的に描き直す */
  refresh(): void {
    if (this.currentId) this.render(this.currentId);
  }

  private head(r: Resident): HTMLElement {
    const head = el('header', 'mind-head');
    const title = el('div');
    title.append(
      el('h3', '', r.profile.name),
      el('p', 'mind-role', r.occupation ? `仕事：${r.occupation}` : '仕事なし'),
      el('p', 'mind-status', this.sim.statusOf(r)),
    );
    head.append(avatar(r.profile.colors), title);
    return head;
  }

  private state(r: Resident): HTMLElement {
    const section = el('section', 'mind-state');
    const meter = (label: string, value: number, cls: string, note: string) => {
      const row = el('div', 'meter');
      const bar = el('span', `meter-bar ${cls}`);
      const fill = el('i');
      fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      bar.append(fill);
      row.append(el('span', 'meter-label', label), bar, el('span', 'meter-value', note));
      return row;
    };
    section.append(
      meter('満腹度', r.satiety, 'satiety', `${Math.round(r.satiety)}（${hungerLabel(r.satiety)}）`),
      meter('体力', r.health, 'health', `${Math.round(Math.max(0, r.health))}`),
      el('p', 'mind-money', `所持金 ${r.money}G・${HOME_LEVEL_NAMES[r.homeLevel ?? 0]}`),
      el(
        'p',
        'mind-money',
        `暮らしの満足：${satisfactionLabel(r.satisfaction ?? 50)}（${Math.round(r.satisfaction ?? 50)}）${r.satisfactionNotes?.length ? `　${r.satisfactionNotes.join('・')}` : ''}`,
      ),
    );
    return section;
  }

  private selfImage(r: Resident): HTMLElement {
    const section = el('section');
    section.append(
      el('h4', '', '自己像'),
      el('p', r.selfImage ? 'self-image' : 'mind-empty', r.selfImage || 'まだ自分がどんな人間なのか、分かっていない。'),
    );
    if (r.wish) section.append(el('p', 'wish', `望み：${r.wish}`));
    if (r.faith && (r.faith.heard > 0 || r.faith.sermons > 0)) {
      section.append(el('p', 'mind-money', `天の声：${r.faith.heard}回聞いた・${r.faith.sermons}回説かれた`));
    }
    const past = r.selfImageHistory.slice(0, -1).reverse();
    if (past.length > 0) {
      const list = el('ol', 'self-history');
      for (const h of past) {
        const li = el('li');
        li.append(el('time', '', `${h.day}日目`), el('span', '', h.text));
        list.append(li);
      }
      section.append(list);
    }
    return section;
  }

  private plan(r: Resident): HTMLElement {
    const section = el('section');
    section.append(el('h4', '', '今日の予定'));
    if (!r.plan) {
      section.append(el('p', 'mind-empty', 'まだ決めていない。'));
      return section;
    }
    section.append(
      el('p', 'plan-source', r.plan.source === 'ai' ? '自分で考えた計画' : 'いつもどおりの計画（ルール）'),
      el('p', 'plan-goal', `目標：${r.plan.goal}`),
    );
    if (r.plan.thought) section.append(el('p', 'plan-thought', `本音：${r.plan.thought}`));
    const list = el('ol', 'plan');
    const h = this.sim.clock.hourOfDay;
    for (const b of r.plan.blocks) {
      const li = el('li', h >= b.from && h < b.to ? 'now' : h >= b.to ? 'done' : '');
      li.append(el('time', '', `${fmtHour(b.from)}〜${fmtHour(b.to)}`), el('span', '', ACTIONS[b.action].label));
      list.append(li);
    }
    section.append(list);
    return section;
  }

  private belongings(r: Resident): HTMLElement {
    const section = el('section');
    section.append(el('h4', '', '持ち物と腕前'));
    const items = ITEM_IDS.filter((id) => countItem(r.inventory, id) > 0);
    section.append(
      el(
        'p',
        items.length ? 'items' : 'mind-empty',
        items.length ? items.map((id) => `${ITEMS[id].name} ${countItem(r.inventory, id)}`).join('　') : '何も持っていない。',
      ),
    );
    const skills = el('ul', 'skills');
    for (const s of SKILL_IDS) {
      const li = el('li', 'meter');
      const bar = el('span', 'meter-bar skill');
      const fill = el('i');
      fill.style.width = `${r.skills[s]}%`;
      bar.append(fill);
      li.append(el('span', 'meter-label', SKILLS[s]), bar, el('span', 'meter-value', `${Math.round(r.skills[s])}`));
      skills.append(li);
    }
    section.append(skills);
    return section;
  }

  private ties(r: Resident): HTMLElement {
    const section = el('section');
    section.append(el('h4', '', '貸し借り・雇用'));
    const lines: string[] = [];
    const name = (id: string) => this.sim.get(id)?.profile.name ?? '（もういない人）';
    for (const d of this.sim.debts) {
      const late = this.sim.clock.day >= d.dueDay ? '・期限切れ' : '';
      if (d.lenderId === r.profile.id) lines.push(`${name(d.borrowerId)}に${d.remaining}G貸している（${d.dueDay}日目まで${late}）`);
      if (d.borrowerId === r.profile.id) lines.push(`${name(d.lenderId)}から${d.remaining}G借りている（${d.dueDay}日目まで${late}）`);
    }
    for (const d of this.sim.deliveries) {
      const what = `${ITEMS[d.item].name}${d.qty}個・${d.money}G・${d.dueDay}日目まで`;
      if (d.sellerId === r.profile.id) lines.push(`${name(d.buyerId)}に渡す約束（${what}）`);
      if (d.buyerId === r.profile.id) lines.push(`${name(d.sellerId)}から受け取る約束（${what}）`);
    }
    for (const e of this.sim.employments) {
      const job = ACTIONS[e.action].label;
      if (e.employerId === r.profile.id) lines.push(`${name(e.employeeId)}を雇っている（${job}・日給${e.wage}G・${e.untilDay}日目まで）`);
      if (e.employeeId === r.profile.id) lines.push(`${name(e.employerId)}に雇われている（${job}・日給${e.wage}G・${e.untilDay}日目まで）`);
    }
    if (lines.length === 0) section.append(el('p', 'mind-empty', 'なし'));
    else {
      const list = el('ul', 'ties');
      for (const l of lines) list.append(el('li', '', l));
      section.append(list);
    }
    return section;
  }

  /** 隠していることと、知っていること（神の視点では、誰が知っているかも見える） */
  private deeds(r: Resident): HTMLElement {
    const section = el('section');
    section.append(el('h4', '', '隠していること・知っていること'));
    const mine = this.sim.deedsBy(r);
    const known = knowledgeOf(this.sim, r);
    if (mine.length === 0 && known.length === 0) {
      section.append(el('p', 'mind-empty', 'なし'));
      return section;
    }
    const list = el('ul', 'ties deeds');
    secretsOf(this.sim, r).forEach((line, i) => {
      const d = mine.slice(-5)[i];
      const who = Object.keys(d.knownBy)
        .map((id) => this.sim.get(id)?.profile.name)
        .filter(Boolean);
      const li = el('li', 'secret', `隠している ${line}`);
      li.append(el('span', 'deed-truth', `　本当に知っている人：${who.length ? who.join('、') : '誰もいない'}`));
      list.append(li);
    });
    for (const line of known) list.append(el('li', '', `知っている ${line}`));
    section.append(list);
    return section;
  }

  private feelings(r: Resident): HTMLElement {
    const section = el('section');
    section.append(el('h4', '', 'みんなへの気持ち'));
    const list = el('ul', 'feelings');
    const rels = Object.entries(r.relations).sort((a, b) => b[1].affinity - a[1].affinity);
    for (const [otherId, rel] of rels) {
      const other = this.sim.get(otherId);
      if (!other) continue;
      const li = el('li');
      const bar = el('span', 'feel-bar');
      bar.setAttribute('aria-hidden', 'true');
      const fill = el('i');
      const half = Math.min(50, Math.abs(rel.affinity) / 2);
      fill.style.background = affinityColor(rel.affinity);
      fill.style.left = rel.affinity >= 0 ? '50%' : `${50 - half}%`;
      fill.style.width = `${half}%`;
      bar.append(fill);
      li.append(
        el('span', 'feel-name', other.profile.name),
        bar,
        el('span', 'feel-value', formatAffinity(rel.affinity)),
        el('span', 'feel-note', `「${rel.impression}」${rel.notes?.length ? `　${rel.notes.slice(0, 2).map((n) => n.text).join('／')}` : ''}`),
      );
      list.append(li);
    }
    section.append(list);
    return section;
  }

  private memories(r: Resident): HTMLElement {
    const section = el('section');
    section.append(el('h4', '', `記憶（${r.memories.length}）`));
    if (r.memories.length === 0) {
      section.append(el('p', 'mind-empty', 'まだ何も覚えていない。'));
      return section;
    }
    const list = el('ol', 'memories');
    for (const m of [...r.memories].reverse()) {
      const li = el('li', /^(天の声|誰かから噂)/.test(m.text) ? 'from-god' : '');
      li.append(el('time', '', `${m.day}日目 ${m.time}`), el('span', '', m.text));
      list.append(li);
    }
    section.append(list);
    return section;
  }
}

function fmtHour(h: number): string {
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

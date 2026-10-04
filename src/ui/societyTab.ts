import { foodValue, ITEMS } from '../world/economy';
import { ACTIONS, DAILY_NEED } from '../world/planner';
import { lootText, type Deed, type Simulation } from '../world/sim';
import { CONDITIONS, WEATHER } from '../world/weather';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const DEED_TEXT: Record<Deed['kind'], (d: Deed) => string> = {
  steal: (d) => (d.success ? `${d.victimName}から${loot(d)}を盗んだ` : `${d.victimName}から盗もうとしたが、何もなかった`),
  rob: (d) => (d.success && loot(d) ? `${d.victimName}から${loot(d)}を力ずくで奪った` : `${d.victimName}から奪おうとして失敗した`),
  attack: (d) => `${d.victimName}を殴った（${d.damage ?? 0}のけが）`,
  kill: (d) => (d.success ? `${d.victimName}を殺し${loot(d) ? `、${loot(d)}を奪った` : 'た'}` : `${d.victimName}を殺そうとしたが、逃げられた`),
};

const loot = (d: Deed) => lootText(d);

/** 社会タブ：村全体のようす・決まり・集会・事件・貸し借り・お墓を、神の視点でまとめて見る */
export class SocietyTab {
  private readonly root = document.getElementById('panel-society')!;
  /** 開いていた集会の記録（描き直しても閉じないように） */
  private readonly openAssemblies = new Set<number>();

  constructor(private readonly sim: Simulation) {}

  render(): void {
    this.root.replaceChildren(
      this.overview(),
      this.laws(),
      this.assemblies(),
      this.deeds(),
      this.ties(),
      this.graves(),
    );
  }

  private section(title: string): HTMLElement {
    const s = el('section', 'society-section');
    s.append(el('h4', '', title));
    return s;
  }

  private overview(): HTMLElement {
    const s = this.section('村のようす');
    const { sim } = this;
    const people = sim.residents;
    const food = people.reduce((n, r) => n + foodValue(r.inventory), 0);
    const need = DAILY_NEED * people.length;
    const sky = WEATHER[sim.weather.kind].name;
    const conds = sim.conditions.map((c) => `${CONDITIONS[c.kind].name}（${c.untilDay}日目の朝まで）`);
    const stats = el('ul', 'society-stats');
    for (const line of [
      `住民 ${people.length}人・お墓 ${sim.graves.length}`,
      `村にある食べ物 満腹度${food}（全員で1日に要るのは${need}、およそ${(food / Math.max(1, need)).toFixed(1)}日分）`,
      `空 ${sky}${conds.length ? `・${conds.join('・')}` : ''}`,
    ]) {
      stats.append(el('li', '', line));
    }
    s.append(stats);

    // 所持金の多い順。差がどう開いていくかを見る
    const max = Math.max(1, ...people.map((r) => r.money));
    const list = el('ul', 'society-wealth');
    for (const r of [...people].sort((a, b) => b.money - a.money)) {
      const li = el('li');
      const bar = el('span', 'meter-bar money');
      const fill = el('i');
      fill.style.width = `${(r.money / max) * 100}%`;
      bar.append(fill);
      li.append(
        el('span', 'wealth-name', r.profile.name),
        bar,
        el('span', 'wealth-value', `${r.money}G・食べ物${foodValue(r.inventory)}`),
      );
      list.append(li);
    }
    s.append(list);
    return s;
  }

  private laws(): HTMLElement {
    const s = this.section(`村の決まり（${this.sim.laws.length}）`);
    if (this.sim.laws.length === 0) {
      s.append(el('p', 'mind-empty', 'まだ決まりはない。村人が集会で決めれば生まれる。'));
      return s;
    }
    const list = el('ul', 'ties');
    for (const l of this.sim.laws) {
      list.append(el('li', '', `「${l.title}」${l.text && l.text !== l.title ? `：${l.text}` : ''}（${l.enactedDay}日目）`));
    }
    s.append(list);
    return s;
  }

  private assemblies(): HTMLElement {
    const s = this.section(`集会の記録（${this.sim.assemblies.length}）`);
    if (this.sim.assemblies.length === 0) {
      s.append(el('p', 'mind-empty', 'まだ集会は開かれていない。'));
      return s;
    }
    for (const a of [...this.sim.assemblies].reverse()) {
      const box = el('details', 'assembly');
      box.open = this.openAssemblies.has(a.id);
      box.addEventListener('toggle', () => (box.open ? this.openAssemblies.add(a.id) : this.openAssemblies.delete(a.id)));
      const r = a.result;
      const status =
        a.status === 'scheduled'
          ? '予定'
          : a.status === 'deliberating'
            ? '話し合い中'
            : !r
              ? 'まとまらず'
              : r.proposal.kind === 'none'
                ? '採決なし'
                : r.passed
                  ? '可決'
                  : '否決';
      const head = el('summary');
      head.append(
        el('span', `assembly-status ${status === '可決' ? 'passed' : status === '否決' ? 'rejected' : ''}`, status),
        el('span', '', `${a.day}日目「${a.agenda}」（${a.callerName}）`),
      );
      box.append(head);
      if (r) {
        const name = (id?: string) => (id ? (this.sim.get(id)?.profile.name ?? '（今はいない人）') : '');
        const p = r.proposal;
        const proposal =
          p.kind === 'exile'
            ? `${name(p.targetId)}を追放する`
            : p.kind === 'fine'
              ? `${name(p.targetId)}に罰金${p.amount}G${p.beneficiaryId ? `（${name(p.beneficiaryId)}へ）` : ''}`
              : p.kind === 'rule'
                ? `決まり「${p.title}」を作る`
                : p.kind === 'repeal'
                  ? `決まり #${p.lawId} を廃止する`
                  : '提案なし';
        const yes = r.votes.filter((v) => v.yes).map((v) => name(v.voterId));
        const no = r.votes.filter((v) => !v.yes).map((v) => name(v.voterId));
        box.append(
          el('p', 'assembly-line', `提案：${proposal}`),
          el('p', 'assembly-line', `賛成：${yes.join('、') || 'なし'}　反対：${no.join('、') || 'なし'}`),
        );
        if (r.summary) box.append(el('p', 'assembly-line muted', r.summary));
        const speeches = el('ol', 'assembly-speeches');
        for (const sp of r.speeches) speeches.append(el('li', '', `${name(sp.speakerId)}「${sp.text}」`));
        const reasons = el('ul', 'assembly-votes');
        for (const v of r.votes) reasons.append(el('li', '', `${name(v.voterId)}：${v.yes ? '賛成' : '反対'}（${v.reason}）`));
        box.append(speeches, reasons);
      }
      s.append(box);
    }
    return s;
  }

  private deeds(): HTMLElement {
    const s = this.section(`事件簿（神の視点・${this.sim.deeds.length}件）`);
    if (this.sim.deeds.length === 0) {
      s.append(el('p', 'mind-empty', 'まだ何も起きていない。'));
      return s;
    }
    const list = el('ul', 'ties deeds');
    for (const d of [...this.sim.deeds].reverse()) {
      const knowers = Object.keys(d.knownBy)
        .map((id) => this.sim.get(id)?.profile.name)
        .filter(Boolean);
      const hushed = d.hushed.map((id) => this.sim.get(id)?.profile.name).filter(Boolean);
      const li = el('li', 'secret', `${d.day}日目 ${d.time} ${d.placeName}：${d.actorName}が${DEED_TEXT[d.kind](d)}`);
      li.append(
        el(
          'span',
          'deed-truth',
          `　${d.public ? '村じゅうが知っている' : `知っている人：${knowers.join('、') || '誰もいない'}`}${hushed.length ? `／口止め：${hushed.join('、')}` : ''}`,
        ),
      );
      list.append(li);
    }
    s.append(list);
    return s;
  }

  private ties(): HTMLElement {
    const s = this.section('貸し借り・雇用・約束の品');
    const name = (id: string) => this.sim.get(id)?.profile.name ?? '（今はいない人）';
    const lines = [
      ...this.sim.debts.map((d) => `${name(d.borrowerId)}が${name(d.lenderId)}に${d.remaining}Gの借り（${d.dueDay}日目まで）`),
      ...this.sim.employments.map(
        (e) => `${name(e.employerId)}が${name(e.employeeId)}を雇っている（${ACTIONS[e.action].label}・日給${e.wage}G・${e.untilDay}日目まで）`,
      ),
      ...this.sim.deliveries.map(
        (d) => `${name(d.sellerId)}が${name(d.buyerId)}に${ITEMS[d.item].name}${d.qty}個を渡す約束（${d.money}G・${d.dueDay}日目まで）`,
      ),
    ];
    if (lines.length === 0) s.append(el('p', 'mind-empty', 'なし'));
    else {
      const list = el('ul', 'ties');
      for (const l of lines) list.append(el('li', '', l));
      s.append(list);
    }
    return s;
  }

  private graves(): HTMLElement {
    const s = this.section(`お墓（${this.sim.graves.length}）`);
    if (this.sim.graves.length === 0) {
      s.append(el('p', 'mind-empty', 'まだ誰も亡くなっていない。'));
      return s;
    }
    const list = el('ul', 'ties');
    for (const g of [...this.sim.graves].reverse()) list.append(el('li', '', `${g.name}　${g.day}日目 ${g.time}・${g.cause}`));
    s.append(list);
    return s;
  }
}

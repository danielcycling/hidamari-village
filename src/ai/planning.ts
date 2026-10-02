import {
  BAKE_INPUT,
  COOK_INPUT,
  countItem,
  describeInventory,
  foodValue,
  FARM_PER_HOUR,
  FISH_PER_HOUR,
  ITEM_IDS,
  ITEMS,
  SKILL_IDS,
  skillFactor,
  SKILLS,
  type ItemId,
} from '../world/economy';
import { findWalkPath } from '../world/map';
import { ACTIONS, DAILY_NEED, PLAN_ACTIONS, type ActionId, type DailyPlan, type PlanBlock } from '../world/planner';
import { SLEEP_FROM, WAKE_AT } from '../world/residents';
import type { Resident, Simulation } from '../world/sim';
import type { ChatMessage } from './llm';
import { affinityLabel, hungerLabel } from './prompt';

const RECENT_MEMORIES = 8;

// ───────────── 共通の材料 ─────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 相場：実際に売れた値段の平均。売れたことがなければ null（こちらから値段の手がかりは与えない） */
function referencePrice(sim: Simulation, id: ItemId): number | null {
  const sold = sim.market.today.sold[id] ?? sim.market.yesterday.sold[id];
  return sold ? Math.round(sold.revenue / sold.qty) : null;
}

function priceGuide(sim: Simulation): string {
  const known = ITEM_IDS.map((id) => [id, referencePrice(sim, id)] as const).filter(([, p]) => p !== null);
  const text = known.length > 0 ? `最近の相場: ${known.map(([id, p]) => `${ITEMS[id].name}${p}G`).join('・')}` : 'まだ相場はない';
  return `${text}。値段は自由に決めてよい（高く売っても安く売ってもいい。高すぎると買ってもらえないこともある）`;
}

/** その人の腕前での、行動ごとの1時間あたりの見込みと、今できるかどうか */
function actionCatalog(sim: Simulation, r: Resident): string {
  const f = (s: keyof typeof SKILLS) => skillFactor(r.skills[s]);
  const wheat = countItem(r.inventory, 'wheat');
  const veg = countItem(r.inventory, 'vegetable');
  const fish = countItem(r.inventory, 'fish');
  const forSale = ITEM_IDS.filter((id) => sim.sellable(r, id) > 0).map((id) => `${ITEMS[id].name}${sim.sellable(r, id)}`);
  const can: Partial<Record<ActionId, string>> = {
    bake: wheat >= 1 ? `（今は小麦${wheat}を持っている）` : '（今は小麦が0。先に畑で採るか買わないと焼けない）',
    cook:
      veg >= 2 && fish >= 1
        ? `（今は野菜${veg}・魚${fish}を持っている）`
        : `（今は野菜${veg}・魚${fish}。足りないので先に採るか買う必要がある）`,
    sell: forSale.length > 0 ? `（今売れる余り: ${forSale.join('・')}）` : '（今は売れる余りがない）',
    buy: `（所持金${r.money}G）`,
  };
  const lines: Record<ActionId, string> = {
    farm: `小麦${round1(FARM_PER_HOUR.wheat * f('farm'))}・野菜${round1(FARM_PER_HOUR.vegetable * f('farm'))}が採れる`,
    fish: `魚が${round1(FISH_PER_HOUR * f('fish'))}匹ほど釣れる（運次第）`,
    bake: `小麦${BAKE_INPUT.wheat}をパン${round1(f('bake'))}個にする（30分ごと）。小麦が要る`,
    cook: `野菜${COOK_INPUT.vegetable}＋魚${COOK_INPUT.fish}を定食1つにする（30分ごと、成功率${Math.round(Math.min(1, 0.3 + 0.5 * f('cook')) * 100)}%）`,
    sell: `持ち物に値段をつけて売る（自分が1日に食べる分は残る）。prices で値段を決める。${priceGuide(sim)}`,
    buy: '売っている人から食べ物を買う。この日パンを焼く予定なら小麦も買う',
    visit: '誰かに会いに行って話す（相談・交渉・取引・頼みごと・取り立てなど）。target に相手の名前、purpose に用件を書く',
    work_for: employmentLine(sim, r),
    beg: '広場で施しを求める（誰かが分けてくれるかもしれない）',
    wander: '広場をぶらついて、たまたま会った人と話す',
    rest: '何もしない',
  };
  return PLAN_ACTIONS.map((a) => {
    const place = ACTIONS[a].place === 'home' ? '自分の家' : ACTIONS[a].place;
    return `- ${a}（${ACTIONS[a].label}、場所:${placeLabel(place)}）: ${lines[a]}${can[a] ?? ''}`;
  }).join('\n');
}

const PLACE_LABELS: Record<string, string> = {
  field: '畑',
  fishing: '釣り場',
  bakery: 'パン焼き小屋',
  kitchen: '食堂',
  plaza: '広場',
};
const placeLabel = (id: string) => PLACE_LABELS[id] ?? id;

/** 今日、その人が主にしていたこと */
function mainActivities(r: Resident): string {
  const top = Object.entries(r.today.hours)
    .filter(([a, h]) => (h ?? 0) >= 0.5 && a !== 'rest')
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 2)
    .map(([a, h]) => `${ACTIONS[a as ActionId].label}${round1(h ?? 0)}時間`);
  return top.length > 0 ? top.join('・') : '特になし';
}

function marketReport(sim: Simulation): string {
  const { sold, leftover } = sim.market.today;
  const soldText = ITEM_IDS.filter((id) => sold[id])
    .map((id) => `${ITEMS[id].name}${sold[id]!.qty}個（平均${Math.round(sold[id]!.revenue / sold[id]!.qty)}G）`)
    .join('、');
  const leftText = ITEM_IDS.filter((id) => leftover[id])
    .map((id) => `${ITEMS[id].name}${leftover[id]}`)
    .join('、');
  return [`- 売れたもの: ${soldText || 'なし（取引がなかった）'}`, `- 売れ残っていたもの: ${leftText || 'なし'}`].join('\n');
}

function facilityReport(sim: Simulation): string {
  const uses: [string, ActionId][] = [
    ['field', 'farm'],
    ['fishing', 'fish'],
    ['bakery', 'bake'],
    ['kitchen', 'cook'],
  ];
  return uses
    .map(([placeId, action]) => {
      const place = sim.map.places[placeId];
      const users = sim.residents.filter((r) => (r.today.hours[action] ?? 0) >= 0.5).map((r) => r.profile.name);
      return `- ${place.name}（同時に${place.capacity}人まで）: ${users.length > 0 ? users.join('、') : '誰も使っていない'}`;
    })
    .join('\n');
}

function othersReport(sim: Simulation, self: Resident): string {
  const others = sim.residents.filter((o) => o !== self);
  if (others.length === 0) return '- 誰もいない';
  return others
    .map((o) => {
      const rel = self.relations[o.profile.id];
      const feel = rel ? `あなたの気持ち: ${affinityLabel(rel.affinity)}（${rel.affinity}）「${rel.impression}」` : '';
      const why = rel?.notes?.length ? `（理由: ${rel.notes.slice(0, 2).map((n) => n.text).join('／')}）` : '';
      const looks = o.satiety <= 0 ? 'ひどくやつれている' : o.satiety < 30 ? '腹を空かせている' : '元気そう';
      const stock = foodValue(o.inventory) >= DAILY_NEED * 2 ? '、食べ物をたくさん抱えている' : '';
      return `- ${o.profile.name}: 仕事「${o.occupation || 'なし'}」、今日は${mainActivities(o)}。${looks}${stock}。${feel}${why}`;
    })
    .join('\n');
}

function employmentLine(sim: Simulation, r: Resident): string {
  const emp = sim.employmentOf(r);
  const employer = emp && sim.get(emp.employerId);
  if (!emp || !employer) return '誰かに雇われているときだけ選べる（今は雇われていない）';
  return `雇い主${employer.profile.name}のもとで${ACTIONS[emp.action].label}をする。出来たものは雇い主のもの。6時間働けば日給${emp.wage}Gがもらえる（${emp.untilDay}日目まで）`;
}

/** 自分が関わっている貸し借り・雇用 */
function ties(sim: Simulation, r: Resident): string[] {
  const lines: string[] = [];
  for (const d of sim.debts) {
    const other = sim.get(d.lenderId === r.profile.id ? d.borrowerId : d.lenderId);
    if (!other || (d.lenderId !== r.profile.id && d.borrowerId !== r.profile.id)) continue;
    const late = sim.clock.day >= d.dueDay ? '（期限を過ぎている）' : '';
    lines.push(
      d.lenderId === r.profile.id
        ? `${other.profile.name}に${d.remaining}G貸している。${d.dueDay}日目までに返してもらう約束${late}`
        : `${other.profile.name}から${d.remaining}G借りている。${d.dueDay}日目までに返す約束${late}`,
    );
  }
  for (const e of sim.employments) {
    if (e.employerId === r.profile.id) {
      const who = sim.get(e.employeeId);
      if (who) lines.push(`${who.profile.name}を日給${e.wage}Gで雇っている（${ACTIONS[e.action].label}、${e.untilDay}日目まで）。給料は毎晩自分の所持金から払う`);
    }
    if (e.employeeId === r.profile.id) {
      const who = sim.get(e.employerId);
      if (who) lines.push(`${who.profile.name}に日給${e.wage}Gで雇われている（${ACTIONS[e.action].label}、${e.untilDay}日目まで）`);
    }
  }
  return lines;
}

/** 家から各場所まで歩いて何分か（1分に1マス歩く） */
function travelTimes(sim: Simulation, r: Resident): string {
  const home = sim.map.places[r.profile.homeId].spot;
  return Object.entries(PLACE_LABELS)
    .map(([id, name]) => {
      const path = findWalkPath(sim.map, home, sim.map.places[id].spot);
      return `${name}${path ? path.length : '?'}分`;
    })
    .join('・');
}

/** 食べ物があと何日もつか、今日どれだけ手に入れたか（本人が分かっている事実） */
function outlook(r: Resident): string {
  const days = foodValue(r.inventory) / DAILY_NEED;
  const left = days < 0.25 ? '手元の食べ物はもうほとんどない' : `手元の食べ物はあと${round1(days)}日分ほど`;
  const gotToday = ITEM_IDS.reduce(
    (n, id) => n + ITEMS[id].satiety * ((r.today.produced[id] ?? 0) + (r.today.bought[id] ?? 0)),
    0,
  );
  return `${left}。今日新しく手に入れた食べ物は満腹度${gotToday}ぶん（1日に要るのは${DAILY_NEED}）`;
}

function aboutMe(r: Resident): string {
  const skills = SKILL_IDS.map((s) => `${SKILLS[s]}${Math.round(r.skills[s])}`).join('・');
  const perishable = ITEM_IDS.filter((id) => ITEMS[id].shelfLife !== null && countItem(r.inventory, id) > 0)
    .map((id) => `${ITEMS[id].name}は${ITEMS[id].shelfLife === 'day' ? 'その日のうちに' : `${(ITEMS[id].shelfLife as number) / 1440}日で`}腐る`)
    .join('、');
  return [
    `【あなた】${r.profile.name}`,
    `自己像: ${r.selfImage || 'まだ自分がどんな人間なのか、よく分かっていない'}`,
    `名乗っている仕事: ${r.occupation || 'なし'}`,
    `状態: ${hungerLabel(r.satiety)}（満腹度${Math.round(r.satiety)}）、体力${Math.round(r.health)}、所持金${r.money}G`,
    `持ち物: ${describeInventory(r.inventory)}${perishable ? `（${perishable}）` : ''}`,
    `生活の見込み: ${outlook(r)}`,
    `腕前（0〜100。上がるほど多く・うまく作れる。使わないと少しずつ落ちる）: ${skills}`,
  ].join('\n');
}

// ───────────── 翌日の計画 ─────────────

export interface RawPlan {
  thought: string;
  goal: string;
  occupation: string;
  leave_village: boolean;
  leave_reason: string;
  blocks: {
    from: number;
    to: number;
    action: string;
    prices?: Partial<Record<ItemId, number>>;
    target?: string;
    purpose?: string;
  }[];
}

const PLAN_SYSTEM = `あなたは小さな村に暮らす村人本人です。寝る前に、明日1日の過ごし方を決めます。

## 前提
- ${WAKE_AT}時に起き、${SLEEP_FROM}時に寝る。その間の時間割を決める。
- 生きるには1日に満腹度${DAILY_NEED}ぶん食べる必要がある。食べ物がなくなると体力が減り、やがて死ぬ。
- 食事は持ち物から自動でとる。食べ物は自分で作るか、市場（広場）で買う。
- お金は村の中を巡るだけで、勝手には増えない。
- 設備は誰のものでもなく、定員を超えると使えない。
- 村にはまだ決まりも組織もない。

## 決め方
- 行動は一覧から選ぶ。時間割は${WAKE_AT}〜${SLEEP_FROM}時の範囲で、重ならないように4〜8個のまとまりで並べる。
- 材料が要る行動（パン焼き・料理）は、材料を手に入れる行動のあとに置く。売る物がないのに sell を入れない。
- prices は sell のときだけ書く。visit のときは target に相手の名前、purpose に用件を書く。
- 自分の自己像・状態・腕前・記憶・村の人たち・市場の様子をよく見て、自分にとっていちばんいいと思う計画を立てる。他の人の役に立つことを考えてもいいし、自分のことだけを考えてもいい。
- 本音は取り繕わずに書く。不安・不満・嫉妬・恨みがあればそのまま書いてよい。
- 仕事は名乗っても名乗らなくてもいい。続けていることに合わせて名乗る、変える、やめる。名乗らないなら空文字。
- どうしてもこの村で生きていけないと思ったときだけ、leave_village を true にして村を出られる（二度と戻れない）。そのときは leave_reason に理由を書く。村に残るなら leave_village は false、leave_reason は空文字。
- thought には、なぜこの計画にしたのかの本音を一人称で80文字以内で書く。goal は40文字以内。
- すべて自然な日本語で書く。出力はJSONのみ。`;

export function buildPlanMessages(sim: Simulation, r: Resident, day: number): ChatMessage[] {
  const memories = r.memories.slice(-RECENT_MEMORIES).map((m) => `- ${m.day}日目 ${m.time}: ${m.text}`);
  const news = sim.recentNews().slice(-5).map((n) => `- ${n.day}日目 ${n.time}: ${n.text}`);
  const food = ITEM_IDS.filter((id) => ITEMS[id].satiety > 0)
    .map((id) => `${ITEMS[id].name}（満腹度${ITEMS[id].satiety}）`)
    .join('、');
  const user = [
    `明日は${day}日目。`,
    '',
    aboutMe(r),
    '',
    '最近の記憶:',
    ...(memories.length > 0 ? memories : ['- 特になし']),
    '',
    '貸し借り・雇用:',
    ...(ties(sim, r).map((t) => `- ${t}`).concat(ties(sim, r).length === 0 ? ['- なし'] : [])),
    '',
    '村の人たち:',
    othersReport(sim, r),
    '',
    '今日の市場（広場）:',
    marketReport(sim),
    '',
    '今日の設備の利用:',
    facilityReport(sim),
    '',
    '村の最近の出来事:',
    ...(news.length > 0 ? news : ['- 特になし']),
    '',
    `食べ物: ${food}。小麦はそのままでは食べられない。`,
    '',
    '行動の一覧（あなたの今の腕前での1時間あたりの見込み）:',
    actionCatalog(sim, r),
    '',
    `家から歩いてかかる時間: ${travelTimes(sim, r)}。場所を移るたびに歩く時間がかかり、そのあいだは何もできない。`,
  ].join('\n');
  return [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: user },
  ];
}

export function planSchema(): object {
  const priceProps = Object.fromEntries(ITEM_IDS.map((id) => [id, { type: 'integer', minimum: 1, maximum: 500 }]));
  return {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      goal: { type: 'string' },
      occupation: { type: 'string' },
      leave_village: { type: 'boolean' },
      leave_reason: { type: 'string' },
      blocks: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            from: { type: 'number', minimum: WAKE_AT, maximum: SLEEP_FROM },
            to: { type: 'number', minimum: WAKE_AT, maximum: SLEEP_FROM },
            action: { type: 'string', enum: PLAN_ACTIONS },
            prices: { type: 'object', properties: priceProps },
            target: { type: 'string' },
            purpose: { type: 'string' },
          },
          required: ['from', 'to', 'action'],
        },
      },
    },
    required: ['thought', 'goal', 'occupation', 'leave_village', 'leave_reason', 'blocks'],
  };
}

const hasForeignWords = (text: string) => /[A-Za-z]{4,}/.test(text);
const clean = (text: unknown, max: number) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
};

/** AIの計画を検証し、時間割を整える。使えなければ null */
export function parsePlan(raw: RawPlan, day: number, current: Resident, sim: Simulation): DailyPlan | null {
  const byName = new Map(sim.residents.map((o) => [o.profile.name, o.profile.id]));
  const blocks: PlanBlock[] = (raw.blocks ?? [])
    .filter((b) => PLAN_ACTIONS.includes(b.action as ActionId))
    .map((b) => {
      // 会いに行く相手が村にいなければ、ぶらつくことにする
      const target = b.action === 'visit' ? byName.get(String(b.target ?? '').trim()) : undefined;
      const action = (b.action === 'visit' && (!target || target === current.profile.id) ? 'wander' : b.action) as ActionId;
      const purpose = clean(b.purpose, 40);
      const prices: Partial<Record<ItemId, number>> = {};
      for (const id of ITEM_IDS) {
        const p = Math.round(Number(b.prices?.[id]));
        if (Number.isFinite(p) && p >= 1) prices[id] = Math.min(500, p);
      }
      return {
        from: clamp(Number(b.from), WAKE_AT, SLEEP_FROM),
        to: clamp(Number(b.to), WAKE_AT, SLEEP_FROM),
        action,
        ...(Object.keys(prices).length > 0 ? { prices } : {}),
        ...(action === 'visit' ? { target, purpose: hasForeignWords(purpose) ? '' : purpose } : {}),
      };
    })
    .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to - b.from >= 0.25)
    .sort((a, b) => a.from - b.from);

  // 重なりを削り、すき間は「家で休む」で埋める
  const fixed: PlanBlock[] = [];
  let cursor = WAKE_AT;
  for (const b of blocks) {
    const from = Math.max(b.from, cursor);
    if (b.to - from < 0.25) continue;
    if (from > cursor) fixed.push({ from: cursor, to: from, action: 'rest' });
    fixed.push({ ...b, from });
    cursor = b.to;
  }
  if (fixed.length === 0) return null;
  if (cursor < SLEEP_FROM) fixed.push({ from: cursor, to: SLEEP_FROM, action: 'rest' });

  const occupation = clean(raw.occupation, 12).replace(/^(なし|無職|特になし)$/, '');
  // 「出る」とはっきり選んだときだけ村を出る（理由の欄だけ埋まっていても出ない）
  const leave = raw.leave_village === true ? clean(raw.leave_reason, 60) || '理由は語らなかった' : '';
  const thought = clean(raw.thought, 120);
  const goal = clean(raw.goal, 60);
  return {
    day,
    goal: goal && !hasForeignWords(goal) ? goal : '今日を生き延びる',
    thought: thought && !hasForeignWords(thought) ? thought : undefined,
    blocks: fixed,
    source: 'ai',
    occupation: hasForeignWords(occupation) ? current.occupation : occupation,
    leave: leave && !hasForeignWords(leave) ? leave : undefined,
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ───────────── 自己像 ─────────────

const SELF_SYSTEM = `あなたは小さな村に暮らす村人本人です。最近の自分の行動と出来事を振り返り、「自分はどういう人間か」を言い表します。
- 次の3つを、行動や出来事から読み取れる範囲で、具体的に入れる：
  1. 何をして暮らしているか（多く時間を使っていること、得意なこと）
  2. 人とどう関わっているか（誰と親しいか、取引や助け合いをするか、ひとりで過ごすか）
  3. 大事にしていること、または今の悩み
- 書かれていない過去や家族を作らない。
- 一人称で、20〜60文字の自然な日本語の文で書く。単語だけで答えない。出力はJSONのみ。`;

export function buildSelfImageMessages(sim: Simulation, r: Resident): ChatMessage[] {
  const totals: Partial<Record<ActionId, number>> = {};
  for (const d of [...r.history, { hours: r.today.hours }]) {
    for (const [a, h] of Object.entries(d.hours)) totals[a as ActionId] = (totals[a as ActionId] ?? 0) + (h ?? 0);
  }
  const how = Object.entries(totals)
    .filter(([a, h]) => (h ?? 0) >= 1 && a !== 'rest')
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([a, h]) => `${ACTIONS[a as ActionId].label}${Math.round(h ?? 0)}時間`)
    .join('、');
  const rels = Object.entries(r.relations)
    .map(([id, rel]) => ({ name: sim.get(id)?.profile.name, ...rel }))
    .filter((x) => x.name)
    .sort((a, b) => b.affinity - a.affinity);
  const relText = rels.map((x) => `${x.name}: ${affinityLabel(x.affinity)}「${x.impression}」`).join('、');
  const user = [
    aboutMe(r),
    '',
    `この数日の過ごし方（合計）: ${how || 'ほとんど何もしていない'}`,
    ...r.history.slice(-3).map((d) => `- ${d.day}日目: ${d.summary}`),
    '',
    `人との関係: ${relText || 'まだ誰とも親しくない'}`,
    '',
    '最近の記憶:',
    ...r.memories.slice(-12).map((m) => `- ${m.day}日目 ${m.time}: ${m.text}`),
    '',
    `これまでの自己像: ${r.selfImage || 'まだない'}`,
  ].join('\n');
  return [
    { role: 'system', content: SELF_SYSTEM },
    { role: 'user', content: user },
  ];
}

export const selfImageSchema = {
  type: 'object',
  properties: { self_image: { type: 'string' } },
  required: ['self_image'],
};

export function parseSelfImage(raw: { self_image?: string }): string | null {
  const text = clean(raw.self_image, 80);
  // 「探検中」のような単語だけの答えは自己像として使わない
  return text.length >= 12 && !hasForeignWords(text) ? text : null;
}

// ───────────── 危機の判断 ─────────────

export interface RawCrisis {
  thought: string;
  action: string;
  target: string;
  purpose: string;
}

const CRISIS_ACTIONS = ['visit', 'beg', 'buy', 'farm', 'fish', 'bake', 'rest'] as const;

const CRISIS_SYSTEM = `あなたは小さな村に暮らす村人本人です。いま空腹で、食べる物を何も持っていません。このままだと体力が減り、やがて死にます。
これからの1〜2時間、どうするかを1つ選びます。
- visit: 誰かに会いに行く（食べ物を分けてもらう、買う、借りる、頼む、など。target に名前、purpose に用件）
- beg: 広場で施しを求める
- buy: 市場で買う（売っている人がいれば）
- farm / fish: 自分で採りに行く（すぐには食べられる量にならないかもしれない）
- bake: 持っている小麦でパンを焼く
- rest: 何もしない
自分の自己像・人間関係・所持金・記憶から、自分らしく選ぶ。プライドを捨てて頼ってもいいし、誰にも頼りたくなければそうしてもいい。
thought に本音を一人称で60文字以内で書く。日本語で書く。出力はJSONのみ。`;

export function buildCrisisMessages(sim: Simulation, r: Resident): ChatMessage[] {
  const sellers = sim.residents
    .filter((o) => o !== r && o.shop)
    .map((o) => o.profile.name);
  const user = [
    aboutMe(r),
    '',
    '貸し借り・雇用:',
    ...(ties(sim, r).map((t) => `- ${t}`).concat(ties(sim, r).length === 0 ? ['- なし'] : [])),
    '',
    '村の人たち:',
    othersReport(sim, r),
    '',
    `いま市場で店を開いている人: ${sellers.length > 0 ? sellers.join('、') : 'いない'}`,
    '',
    '最近の記憶:',
    ...r.memories.slice(-6).map((m) => `- ${m.day}日目 ${m.time}: ${m.text}`),
  ].join('\n');
  return [
    { role: 'system', content: CRISIS_SYSTEM },
    { role: 'user', content: user },
  ];
}

export const crisisSchema = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: CRISIS_ACTIONS },
    target: { type: 'string' },
    purpose: { type: 'string' },
  },
  required: ['thought', 'action', 'target', 'purpose'],
};

export function parseCrisis(
  raw: RawCrisis,
  r: Resident,
  sim: Simulation,
): { action: ActionId; target?: string; purpose?: string; thought: string } {
  const thought = clean(raw.thought, 80);
  const action = (CRISIS_ACTIONS as readonly string[]).includes(raw.action) ? (raw.action as ActionId) : 'fish';
  if (action === 'visit') {
    const t = sim.residents.find((o) => o.profile.name === String(raw.target ?? '').trim() && o !== r);
    if (t) return { action, target: t.profile.id, purpose: clean(raw.purpose, 40) || '食べ物を分けてほしい', thought };
    return { action: 'beg', thought };
  }
  return { action, thought: hasForeignWords(thought) ? '' : thought };
}

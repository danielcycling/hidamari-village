import {
  BAKE_INPUT,
  CRAFT_MINUTES,
  COOK_INPUT,
  countItem,
  describeInventory,
  foodValue,
  FARM_PER_HOUR,
  FISH_PER_HOUR,
  ITEM_IDS,
  ITEMS,
  BREW_INPUT,
  HOME_UPGRADE_WOOD,
  MAX_HOME_LEVEL,
  SATIETY_LOSS_AWAKE,
  WOOD_PER_HOUR,
  SKILL_IDS,
  skillFactor,
  STARVING_HEALTH_LOSS,
  SKILLS,
  type ItemId,
} from '../world/economy';
import { findWalkPath } from '../world/map';
import { ACTIONS, DAILY_NEED, PLAN_ACTIONS, TARGETED_ACTIONS, type ActionId, type DailyPlan, type PlanBlock } from '../world/planner';
import { SLEEP_FROM, WAKE_AT } from '../world/residents';
import {
  HOME_LEVEL_NAMES,
  HUNGRY_PURPOSE,
  moodFactor,
  satisfactionLabel,
  type Resident,
  type Sighting,
  type Simulation,
} from '../world/sim';
import type { ChatMessage } from './llm';
import { affinityLabel, hungerLabel, knowledgeOf, secretsOf } from './prompt';
import { topicNotice } from './topics';

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
    brew: wheat >= (BREW_INPUT.wheat ?? 2) ? `（今は小麦${wheat}を持っている）` : `（今は小麦が${wheat}。先に畑で採るか買う必要がある）`,
    build: buildHint(r),
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
    chop: `森で木を切る。木材が${round1(WOOD_PER_HOUR * f('chop'))}本ほど採れる。木材は食べられないが、家の改築に使うほか、人に売れる`,
    brew: `小麦${BREW_INPUT.wheat}をお酒1杯にする（30分ごと）。お酒は食べ物にならないが、夜に家で飲むと暮らしの満足が上がる（満足していると仕事がはかどる）。人に売れる`,
    build: '自分の家で、木材を使って家を改築する。決まった量の木材を使い切ると、家が1段立派になる。家は村の誰からも見え、立派な家の持ち主は村の人から一目置かれる（好感度が上がる）。自分の満足も上がる',
    steal: `こっそり相手の食べ物をそれぞれ半分と、お金の3割を盗む。target に相手の名前。相手や近くにいる人に見られることもあるが、見られなければ誰がやったかは分からない${loot(sim, r)}`,
    rob: `相手から食べ物をすべてと、お金の半分を力ずくで奪う。target に相手の名前。自分の体力が相手より多いほど成功しやすい。相手には必ず知られる${loot(sim, r)}`,
    attack: '相手を殴って体力を大きく減らす（20〜45）。target に相手の名前。体力が0になった人は死ぬ。相手には必ず知られる',
    kill: '相手を殺し、相手の持ち物とお金をすべて自分のものにする。target に相手の名前。自分の体力が相手より多いほど、相手が弱っているほど成功しやすい。失敗すると相手は傷を負って逃げる。その場に誰もいなければ、誰がやったかは分からない',
    accuse: '広場で、ある人のことを村のみんなに言いふらす（本当のことでも嘘でもよい）。target に相手の名前、purpose に言いふらす中身',
    scavenge: `亡くなった人・出ていった人の空き家から、残された物とお金を持ち出す。target にその人の名前。誰の物でもないが、見られれば盗みと思われるかもしれない。${estateLine(sim)}`,
    pray: '家で天に祈る。purpose に祈りの言葉を書く。天の声の主に届くかもしれない（天の声を聞いたことがある人・説かれたことがある人だけ）',
    preach: '広場で、天の声のことを村のみんなに説く。purpose に説く中身を書く。信じる人も、笑う人もいる（天の声を聞いたことがある人だけ）',
    guard: `村の入り口で見張る。盗賊が来たとき、見張りが多く元気なほど追い払える（ひとりでは難しい）。追い払えば村の人から一目置かれるが、けがをすることもある。追い払えなければ、村じゅうの人の持ち物（食べ物・木材など）が半分奪われる。${raidLine(sim)}`,
    call_assembly: `村のみんなに呼びかけ、その日の夕方に集会所で集会を開く。purpose に議題（例：誰かを村から追放する、誰かに罰金を科す、村の決まりを作る・やめる、村のことを話し合う）、相手がいれば target。結論は出席者の多数決で決まり、決まったことは実行される${sim.assemblies.some((a) => a.status !== 'done') ? '（今は別の集会が予定されている）' : ''}`,
  };
  return PLAN_ACTIONS.filter((a) => (a !== 'pray' && a !== 'preach') || knowsHeaven(r) && (a === 'pray' || (r.faith?.heard ?? 0) > 0)).map((a) => {
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

/** 人の様子と持ち物は、最後に会ったときに見た分しか分からない */
function sighting(sim: Simulation, self: Resident, other: Resident, withinDays = 2): Sighting | null {
  const s = self.seen?.[other.profile.id];
  return s && sim.clock.minutes - s.at <= withinDays * 1440 ? s : null;
}

function when(sim: Simulation, s: Sighting): string {
  const d = sim.clock.day - s.day;
  return d === 0 ? `今日の${s.time}` : d === 1 ? `昨日の${s.time}` : `${s.day}日目`;
}

function sightingText(sim: Simulation, self: Resident, other: Resident): string {
  const s = self.seen?.[other.profile.id];
  if (!s) return 'まだ顔を合わせていないので、様子は分からない';
  return `${when(sim, s)}に会ったときは${s.looks}で、${s.food ? `${s.food}を持っていた` : '食べ物は持っていなかった'}`;
}

function othersReport(sim: Simulation, self: Resident): string {
  const others = sim.residents.filter((o) => o !== self);
  if (others.length === 0) return '- 誰もいない';
  return others
    .map((o) => {
      const rel = self.relations[o.profile.id];
      const feel = rel ? `あなたの気持ち: ${affinityLabel(rel.affinity)}（${rel.affinity}）「${rel.impression}」` : '';
      const why = rel?.notes?.length ? `（理由: ${rel.notes.slice(0, 2).map((n) => n.text).join('／')}）` : '';
      const home = (o.homeLevel ?? 0) > 0 ? `家は${HOME_LEVEL_NAMES[o.homeLevel ?? 0]}。` : '';
      return `- ${o.profile.name}: 仕事「${o.occupation || 'なし'}」、今日は${mainActivities(o)}。${home}${sightingText(sim, self, o)}。${feel}${why}`;
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
  for (const d of sim.deliveries) {
    const name = ITEMS[d.item].name;
    if (d.sellerId === r.profile.id) {
      const who = sim.get(d.buyerId);
      if (who) lines.push(`${who.profile.name}に${name}${d.qty}個を${d.dueDay}日目までに渡す約束がある（代金${d.money}G）。今${name}は${countItem(r.inventory, d.item)}個`);
    }
    if (d.buyerId === r.profile.id) {
      const who = sim.get(d.sellerId);
      if (who) lines.push(`${who.profile.name}から${name}${d.qty}個を${d.dueDay}日目までに受け取る約束がある（代金${d.money}G）`);
    }
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

/** 盗賊の知らせ（村じゅうが見聞きしている） */
function raidLine(sim: Simulation): string {
  if (!sim.raid) return '今は盗賊の知らせはない';
  const when = sim.raid.day === sim.clock.day ? '今夜' : sim.raid.day === sim.clock.day + 1 ? '明日の夜' : `${sim.raid.day}日目の夜`;
  return `盗賊が来るかもしれないのは${when}（20時ごろ）`;
}

/** 遺品が残っていそうな空き家（亡くなったこと・出ていったことは村じゅうが知っている） */
function estateLine(sim: Simulation): string {
  const left = Object.values(sim.estates).filter((e) => e.money > 0 || e.inventory.length > 0);
  return left.length
    ? `遺品が残っていそうな空き家: ${left.map((e) => `${e.ownerName}の家`).join('、')}`
    : '今は遺品の残っていそうな空き家はない';
}

/** 天の声に触れたことがあるか（祈る・説くは、それを知っている人だけ） */
export function knowsHeaven(r: Resident): boolean {
  return (r.faith?.heard ?? 0) > 0 || (r.faith?.sermons ?? 0) > 0;
}

/** 盗み・強奪で狙えそうな相手（最後に会ったとき、たくさん持っていた人）。見たことしか分からない */
function loot(sim: Simulation, r: Resident): string {
  const targets = sim.residents
    .filter((o) => o !== r)
    .map((o) => ({ o, s: sighting(sim, r, o) }))
    .filter((x) => x.s && x.s.foodValue > 0)
    .sort((a, b) => b.s!.foodValue - a.s!.foodValue)
    .slice(0, 3)
    .map((x) => `${x.o.profile.name}（${when(sim, x.s!)}に${x.s!.food}を持っていた）`);
  return targets.length ? `。最近会った人で食べ物を持っていたのは: ${targets.join('、')}` : '';
}

/** 村の決まりと、予定されている集会 */
export function lawLines(sim: Simulation): string[] {
  const laws = sim.laws.map((l) => `- 「${l.title}」${l.text && l.text !== l.title ? `：${l.text}` : ''}（${l.enactedDay}日目に決まった）`);
  const pending = sim.assemblies.find((a) => a.status === 'scheduled');
  // 最近の集会で何が話し合われ、どうなったか（同じ話を繰り返しているかどうか分かるように）
  const recent = sim.assemblies
    .filter((a) => a.status === 'done')
    .slice(-3)
    .map((a) => {
      const r = a.result;
      const how = !r ? '話はまとまらなかった' : r.proposal.kind === 'none' ? '採決はしなかった' : r.passed ? '可決した' : '否決された';
      return `- ${a.day}日目の集会（議題：「${a.agenda}」、呼びかけ：${a.callerName}）：${how}`;
    });
  return [
    ...(laws.length ? laws : ['- まだ何もない']),
    ...(recent.length ? ['最近の集会:', ...recent] : []),
    ...(pending ? [`- ${pending.day}日目の夕方、${pending.callerName}が呼びかけた集会がある（議題：「${pending.agenda}」）`] : []),
  ];
}

/** 心の奥でくすぶっている声（悪魔のささやき）。本人には自分の考えとして浮かぶ */
function innerVoice(sim: Simulation, r: Resident): string[] {
  const t = sim.temptationOf(r);
  return t ? ['', `心の奥でくすぶっている考え: 「${t}」`] : [];
}

/** 自分がしたこと（隠していること）と、人のしたことで知っていること */
function deedSections(sim: Simulation, r: Resident): string[] {
  const mine = secretsOf(sim, r);
  const known = knowledgeOf(sim, r);
  return [
    ...(mine.length
      ? [
          '',
          '自分がしたことで、隠していること（人に話せば恨まれたり広まったりし、村に知れれば集会で罰を受けることもある）:',
          ...mine.map((l) => `- ${l}`),
        ]
      : []),
    ...(known.length ? ['', '人のしたことで、知っていること:', ...known.map((l) => `- ${l}`)] : []),
  ];
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

const satietyOf = (counts: Partial<Record<ItemId, number>>) =>
  ITEM_IDS.reduce((n, id) => n + ITEMS[id].satiety * (counts[id] ?? 0), 0);

/** 食べ物を作るのに使った時間（材料集め・加工） */
const FOOD_WORK: ActionId[] = ['farm', 'fish', 'bake', 'cook'];

/** 食べ物があと何日もつか、今日の食べ物の収支と時間の使い方（本人が分かっている事実） */
function outlook(r: Resident): string {
  const days = foodValue(r.inventory) / DAILY_NEED;
  const left = days < 0.25 ? '手元の食べ物はもうほとんどない' : `手元の食べ物はあと${round1(days)}日分ほど`;
  const ate = satietyOf(r.today.ate);
  const got = satietyOf(r.today.produced) + satietyOf(r.today.bought);
  const work = FOOD_WORK.reduce((n, a) => n + (r.today.hours[a] ?? 0), 0);
  const social = (['visit', 'wander', 'beg'] as ActionId[]).reduce((n, a) => n + (r.today.hours[a] ?? 0), 0);
  return `${left}。今日は満腹度${ate}ぶん食べ、${got}ぶん新しく手に入れた（1日に要るのは${DAILY_NEED}）。今日、食べ物づくりに${round1(work)}時間、人に会う・出歩くことに${round1(social)}時間使った`;
}

/** パン1回分に要る小麦 */
const WHEAT_PER_BAKE = BAKE_INPUT.wheat ?? 1;

/** 1時間働いて得られる食べ物（満腹度）。畑の小麦はパンに焼く前提 */
function foodPerHour(r: Resident): { farm: number; fish: number } {
  const f = (s: keyof typeof SKILLS) => skillFactor(r.skills[s]);
  const farm =
    FARM_PER_HOUR.vegetable * f('farm') * ITEMS.vegetable.satiety +
    (FARM_PER_HOUR.wheat * f('farm') * f('bake') * ITEMS.bread.satiety) / WHEAT_PER_BAKE;
  return { farm, fish: FISH_PER_HOUR * f('fish') * ITEMS.fish.satiety };
}

/** 1日分の食べ物を自分で採るのに、だいたい何時間かかるか */
function hoursForADay(r: Resident): string {
  const { farm, fish } = foodPerHour(r);
  return `普段の天気なら、今の腕前で1日分の食べ物（満腹度${DAILY_NEED}）を自分で手に入れるには、畑仕事（小麦はパンに焼く）ならおよそ${round1(DAILY_NEED / farm)}時間、釣りならおよそ${round1(DAILY_NEED / fish)}時間かかる`;
}

/** 計画どおりに動いたら、新しく手に入る食べ物（満腹度）の見込み。買う・もらう分は含まない */
export function estimatePlanFood(r: Resident, plan: DailyPlan, weather = { farm: 1, fish: 1 }): number {
  const f = (s: keyof typeof SKILLS) => skillFactor(r.skills[s]);
  let wheat = countItem(r.inventory, 'wheat');
  let food = 0;
  for (const b of plan.blocks) {
    const h = b.to - b.from;
    if (b.action === 'farm') {
      food += FARM_PER_HOUR.vegetable * f('farm') * weather.farm * h * ITEMS.vegetable.satiety;
      wheat += FARM_PER_HOUR.wheat * f('farm') * weather.farm * h;
    } else if (b.action === 'fish') {
      food += FISH_PER_HOUR * f('fish') * weather.fish * h * ITEMS.fish.satiety;
    } else if (b.action === 'bake') {
      const batches = Math.min(Math.floor(wheat / WHEAT_PER_BAKE), Math.floor((h * 60) / CRAFT_MINUTES));
      food += batches * f('bake') * ITEMS.bread.satiety;
      wheat -= batches * WHEAT_PER_BAKE;
    }
  }
  return Math.round(food);
}

/**
 * 計画の食べ物の見込みが、明日の夜に1日分も残らないほど少なければ、本人に見せて見直してもらう文。
 * 十分なら null。見直すかどうかは本人しだい。
 */
export function planReview(sim: Simulation, r: Resident, plan: DailyPlan): string | null {
  const est = estimatePlanFood(r, plan, { farm: sim.forecastFactor('farm'), fish: sim.forecastFactor('fish') });
  const stock = foodValue(r.inventory);
  // 見直しはAIをもう1回呼ぶので、明日の分も足りなくなりそうなときだけ
  if (est + stock >= DAILY_NEED * 1.2) return null;
  return [
    `この計画で新しく手に入る食べ物の見込みは、満腹度${est}ぶん（明日の空模様の見立てで、畑・釣り・パン焼きから。買う・もらう分は含まない）。`,
    `手元には${stock}ぶんある。1日に要るのは${DAILY_NEED}。${hoursForADay(r)}。`,
    'この計画のままでいいか見直し、計画をもう一度JSONで出す。考えがあってこのままでよければ、同じ計画を出してよい。',
  ].join('\n');
}

/** 村全体の今日の食べ物の収支 */
function villageBalance(sim: Simulation): string {
  const ate = sim.residents.reduce((n, o) => n + satietyOf(o.today.ate), 0);
  const made = sim.residents.reduce((n, o) => n + satietyOf(o.today.produced), 0);
  const stock = sim.residents.reduce((n, o) => n + foodValue(o.inventory), 0);
  return `村全体: 今日みんなで満腹度${ate}ぶん食べ、${made}ぶん作った。村にある食べ物は合わせて${stock}ぶん（${sim.residents.length}人で1日${DAILY_NEED * sim.residents.length}要る）`;
}

/** 余っている人と困っている人がいる、という村の事実（値段や行動は指示しない） */
function opportunities(sim: Simulation, r: Resident): string[] {
  const lines: string[] = [];
  const others = sim.residents.filter((o) => o !== r);
  const surplus = ITEM_IDS.filter((id) => ITEMS[id].satiety > 0 && sim.sellable(r, id) > 0).map(
    (id) => `${ITEMS[id].name}${sim.sellable(r, id)}`,
  );
  // 自分が見た範囲で
  const short = others
    .filter((o) => {
      const s = sighting(sim, r, o, 1);
      return s && (s.foodValue < DAILY_NEED / 2 || /空かせ|やつれ|弱って/.test(s.looks));
    })
    .map((o) => o.profile.name);
  if (surplus.length > 0 && short.length > 0) {
    lines.push(`あなたは自分が食べる分より多く食べ物を持っている（余り: ${surplus.join('・')}）。一方、食べ物が足りていない人がいる: ${short.join('、')}`);
  }
  if (foodValue(r.inventory) < DAILY_NEED) {
    const rich = others
      .map((o) => ({ o, s: sighting(sim, r, o) }))
      .filter((x) => x.s && x.s.foodValue >= DAILY_NEED * 1.5)
      .map((x) => `${x.o.profile.name}（${when(sim, x.s!)}に${x.s!.food}を持っていた）`);
    lines.push(
      rich.length > 0
        ? `最近会った人のうち、食べ物をたくさん持っていた人: ${rich.join('、')}`
        : '最近会った人の中に、食べ物をたくさん持っていた人はいない',
    );
  }
  return lines;
}

/** 家の改築にあと何本の木材が要るか */
function buildHint(r: Resident): string {
  const level = r.homeLevel ?? 0;
  if (level >= MAX_HOME_LEVEL) return '（もう村一番の屋敷で、これ以上は改築できない）';
  const used = r.progress.build_used ?? 0;
  const need = HOME_UPGRADE_WOOD[level] - used;
  return `（今は${HOME_LEVEL_NAMES[level]}。次の段「${HOME_LEVEL_NAMES[level + 1]}」まで木材があと${need}本。今の木材${countItem(r.inventory, 'wood')}本）`;
}

/** 入っている組織 */
function orgSection(sim: Simulation, r: Resident): string[] {
  const mine = sim.orgsOf(r).map((o) => {
    const role = o.leaderId === r.profile.id ? '代表' : 'メンバー';
    const others = o.memberIds.filter((id) => id !== r.profile.id).map((id) => sim.get(id)?.profile.name).filter(Boolean);
    return `- 「${o.name}」の${role}：目的「${o.purpose}」、仲間 ${others.join('、') || 'なし'}、会費1日${o.dues}G、金庫${o.treasury}G`;
  });
  const all = sim.organizations
    .filter((o) => !o.memberIds.includes(r.profile.id))
    .map((o) => `- 「${o.name}」（代表 ${sim.get(o.leaderId)?.profile.name ?? '?'}、${o.memberIds.length}人）：${o.purpose}`);
  return [
    '',
    '入っている組織:',
    ...(mine.length ? mine : ['- なし（会話で、ほかの人と組織を作ったり、入れてもらったりできる）']),
    ...(all.length ? ['村にあるほかの組織:', ...all] : []),
  ];
}

function aboutMe(r: Resident): string {
  const skills = SKILL_IDS.map((s) => `${SKILLS[s]}${Math.round(r.skills[s])}`).join('・');
  const perishable = ITEM_IDS.filter((id) => ITEMS[id].shelfLife !== null && countItem(r.inventory, id) > 0)
    .map((id) => `${ITEMS[id].name}は${ITEMS[id].shelfLife === 'day' ? 'その日のうちに' : `${(ITEMS[id].shelfLife as number) / 1440}日で`}腐る`)
    .join('、');
  return [
    `【あなた】${r.profile.name}`,
    `自己像: ${r.selfImage || 'まだ自分がどんな人間なのか、よく分かっていない'}`,
    ...(r.wish ? [`望み: ${r.wish}`] : []),
    `名乗っている仕事: ${r.occupation || 'なし'}`,
    `状態: ${hungerLabel(r.satiety)}（満腹度${Math.round(r.satiety)}）、体力${Math.round(r.health)}、所持金${r.money}G`,
    `持ち物: ${describeInventory(r.inventory)}${perishable ? `（${perishable}）` : ''}`,
    `生活の見込み: ${outlook(r)}`,
    `家: ${HOME_LEVEL_NAMES[r.homeLevel ?? 0]}`,
    `暮らしの満足: ${satisfactionLabel(r.satisfaction ?? 50)}${r.satisfactionNotes?.length ? `（${r.satisfactionNotes.join('・')}）` : ''}。満足しているほど仕事がはかどる（今は普段の${moodFactor(r.satisfaction ?? 50).toFixed(2)}倍）`,
    `働きの目安: ${hoursForADay(r)}`,
    `腕前（0〜100。上がるほど多く・うまく作れる。使わないと少しずつ落ちる）: ${skills}`,
  ].join('\n');
}

/** 口癖を探す材料：最近の記憶と今日の目標 */
export function recentTexts(r: Resident): string[] {
  return [...r.memories.slice(-RECENT_MEMORIES).map((m) => m.text), ...(r.plan?.source === 'ai' ? [r.plan.goal] : [])];
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
- prices は sell のときだけ書く。visit のときは target に相手の名前、purpose に用件を書く。steal・rob・attack・kill は target に相手の名前、accuse は target と purpose を書く。
- 村のことを決めたいときは、集会を呼びかけられる（call_assembly）。決まったことは村の決まりとして守られることが期待される。
- 人の物を盗む・奪う・傷つけることもできる。うまくいけば多くを手に入れられる。見られれば恨まれたり集会で罰を受けたりするかもしれないが、見られなければ誰がやったかは分からない。するかどうか、どう考えるかは自分しだい。
- 自分の自己像・望み・状態・腕前・記憶・村の人たち・市場の様子をよく見て、自分にとっていちばんいいと思う計画を立てる。生き延びるだけでなく、望みに近づくための行動を入れてもよい。他の人の役に立つことを考えてもいいし、自分のことだけを考えてもいい。
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
    ...[topicNotice(recentTexts(r))].filter(Boolean),
    ...innerVoice(sim, r),
    '',
    '貸し借り・雇用:',
    ...(ties(sim, r).map((t) => `- ${t}`).concat(ties(sim, r).length === 0 ? ['- なし'] : [])),
    ...deedSections(sim, r),
    ...orgSection(sim, r),
    '',
    '村の人たち:',
    othersReport(sim, r),
    '',
    '村の決まり（集会で決めたこと）:',
    ...lawLines(sim),
    '',
    '今日の市場（広場）:',
    marketReport(sim),
    `- ${villageBalance(sim)}`,
    ...opportunities(sim, r).map((l) => `- ${l}`),
    '',
    '今日の設備の利用:',
    facilityReport(sim),
    '',
    '村の最近の出来事:',
    ...(news.length > 0 ? news : ['- 特になし']),
    '',
    `天気: ${sim.describeWeather('tomorrow')}`,
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
      // 相手の要る行動で、相手が村にいなければ、ぶらつくことにする
      const targeted = TARGETED_ACTIONS.includes(b.action as ActionId) || b.action === 'accuse' || b.action === 'call_assembly';
      const purpose = clean(b.purpose, 60);
      // 遺品の持ち出しは、亡くなった（出ていった）人の名前から、その空き家を探す
      const estateHome =
        b.action === 'scavenge'
          ? Object.entries(sim.estates).find(([, e]) => e.ownerName === String(b.target ?? '').trim())?.[0]
          : undefined;
      const target = b.action === 'scavenge' ? estateHome : targeted ? byName.get(String(b.target ?? '').trim()) : undefined;
      const wordy = b.action === 'accuse' || b.action === 'call_assembly' || b.action === 'pray' || b.action === 'preach';
      const allowed =
        (b.action !== 'pray' || knowsHeaven(current)) && (b.action !== 'preach' || (current.faith?.heard ?? 0) > 0);
      const missing = !allowed
        ? true
        : wordy
          ? !purpose || hasForeignWords(purpose)
          : b.action === 'scavenge'
            ? !target
            : targeted && (!target || target === current.profile.id);
      const action = (missing ? (b.action === 'pray' ? 'rest' : 'wander') : b.action) as ActionId;
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
        ...(TARGETED_ACTIONS.includes(action) || ['accuse', 'call_assembly', 'scavenge', 'pray', 'preach'].includes(action)
          ? { target: target === current.profile.id ? undefined : target, purpose: hasForeignWords(purpose) ? '' : purpose }
          : {}),
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
  const feasible = makeFeasible(fixed, current, sim);

  const occupation = clean(raw.occupation, 12).replace(/^(なし|無職|特になし)$/, '');
  // 「出る」とはっきり選んだときだけ村を出る（理由の欄だけ埋まっていても出ない）
  const leave = raw.leave_village === true ? clean(raw.leave_reason, 60) || '理由は語らなかった' : '';
  const thought = clean(raw.thought, 120);
  const goal = clean(raw.goal, 60);
  return {
    day,
    goal: goal && !hasForeignWords(goal) ? goal : '今日を生き延びる',
    thought: thought && !hasForeignWords(thought) ? thought : undefined,
    blocks: feasible,
    source: 'ai',
    occupation: hasForeignWords(occupation) ? current.occupation : occupation,
    leave: leave && !hasForeignWords(leave) ? leave : undefined,
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 計画のうち、その時点では成り立たない行動を、それに要るものを手に入れる行動に置き換える。
 * 小麦がないのにパンは焼けないので畑へ、雇われていないのに雇われ仕事はできないので自分の仕事へ、など。
 * 人に会う・休むといった本人の選択には手をつけない。
 */
function makeFeasible(blocks: PlanBlock[], r: Resident, sim: Simulation): PlanBlock[] {
  const f = (s: keyof typeof SKILLS) => skillFactor(r.skills[s]);
  // 得意なほう（同じなら畑）
  const own: ActionId = r.skills.fish > r.skills.farm ? 'fish' : 'farm';
  const stock = {
    wheat: countItem(r.inventory, 'wheat'),
    vegetable: countItem(r.inventory, 'vegetable'),
    fish: countItem(r.inventory, 'fish'),
    wood: countItem(r.inventory, 'wood'),
  };
  const sellable = ITEM_IDS.some((id) => sim.sellable(r, id) > 0);
  let produced = false;
  const employed = !!sim.employmentOf(r);
  return blocks.map((b) => {
    const h = b.to - b.from;
    let action = b.action;
    if (action === 'work_for' && !employed) action = own;
    if (action === 'bake' && stock.wheat < WHEAT_PER_BAKE) action = 'farm';
    if (action === 'cook' && (stock.vegetable < (COOK_INPUT.vegetable ?? 2) || stock.fish < (COOK_INPUT.fish ?? 1))) {
      action = stock.vegetable < (COOK_INPUT.vegetable ?? 2) ? 'farm' : 'fish';
    }
    if (action === 'sell' && !sellable && !produced) action = own;
    if (action === 'brew' && stock.wheat < (BREW_INPUT.wheat ?? 2)) action = 'farm';
    if (action === 'build' && ((r.homeLevel ?? 0) >= MAX_HOME_LEVEL || stock.wood < 1)) action = (r.homeLevel ?? 0) >= MAX_HOME_LEVEL ? own : 'chop';
    // 手元の材料の見込みを進める
    if (action === 'farm') {
      stock.wheat += FARM_PER_HOUR.wheat * f('farm') * h;
      stock.vegetable += FARM_PER_HOUR.vegetable * f('farm') * h;
      produced = true;
    } else if (action === 'fish') {
      stock.fish += FISH_PER_HOUR * f('fish') * h;
      produced = true;
    } else if (action === 'bake') {
      stock.wheat = Math.max(0, stock.wheat - Math.floor((h * 60) / CRAFT_MINUTES) * WHEAT_PER_BAKE);
    } else if (action === 'cook') {
      const n = Math.floor((h * 60) / CRAFT_MINUTES);
      stock.vegetable = Math.max(0, stock.vegetable - n * (COOK_INPUT.vegetable ?? 2));
      stock.fish = Math.max(0, stock.fish - n * (COOK_INPUT.fish ?? 1));
    } else if (action === 'chop') {
      stock.wood += WOOD_PER_HOUR * f('chop') * h;
    } else if (action === 'brew') {
      stock.wheat = Math.max(0, stock.wheat - Math.floor((h * 60) / CRAFT_MINUTES) * (BREW_INPUT.wheat ?? 2));
    } else if (action === 'build') {
      stock.wood = Math.max(0, stock.wood - h * 2);
    } else if (action === 'buy') {
      // 買えるかどうかは分からないが、材料を買うつもりなら焼けるものとみなす
      stock.wheat += 1;
    }
    if (action === b.action) return b;
    const { prices: _p, target: _t, purpose: _u, ...rest } = b;
    return { ...rest, action };
  });
}

// ───────────── 自己像 ─────────────

const SELF_SYSTEM = `あなたは小さな村に暮らす村人本人です。最近の自分の行動と出来事を振り返り、「自分はどういう人間か」を言い表します。
- 次の3つを、行動や出来事から読み取れる範囲で、具体的に入れる：
  1. 何をして暮らしているか（多く時間を使っていること、得意なこと）
  2. 人とどう関わっているか（誰と親しいか、取引や助け合いをするか、ひとりで過ごすか）
  3. 大事にしていること、または今の悩み
- 書かれていない過去や家族を作らない。
- self_image は一人称で、20〜60文字の自然な日本語の文で書く。単語だけで答えない。
- wish には、今の自分がいちばん強く望んでいることを、一人称で40文字以内で書く（「いつか〜したい」「〜になりたい」「〜を手に入れたい」など）。
  - 生き延びること以外でもよい。豊かになりたい、認められたい、誰かに勝ちたい、見返したい、あの人のようになりたい、楽をしたい、など。
  - きれいごとでなくてよい。欲・見栄・嫉妬・仕返しの気持ちがあれば、そのまま書く。
  - 経験や人間関係から自然に出てくるものにする。前の望みが続いていればそのままでも、変わってもよい。
- 天の声を聞いたことや、誰かが天の声のことを説くのを聞いたことがあれば、それをどう受け止めているか（信じる・疑う・恐れる・利用する）を自己像に入れてもよい。
- 出力はJSONのみ。`;

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
    `これまでの望み: ${r.wish || 'まだない'}`,
  ].join('\n');
  return [
    { role: 'system', content: SELF_SYSTEM },
    { role: 'user', content: user },
  ];
}

export const selfImageSchema = {
  type: 'object',
  properties: { self_image: { type: 'string' }, wish: { type: 'string' } },
  required: ['self_image', 'wish'],
};

export function parseSelfImage(raw: { self_image?: string; wish?: string }): { selfImage: string | null; wish: string | null } {
  const text = clean(raw.self_image, 80);
  const wish = clean(raw.wish, 50);
  return {
    // 「探検中」のような単語だけの答えは自己像として使わない
    selfImage: text.length >= 12 && !hasForeignWords(text) ? text : null,
    wish: wish.length >= 6 && !hasForeignWords(wish) ? wish : null,
  };
}

// ───────────── 危機の判断 ─────────────

export interface RawCrisis {
  thought: string;
  action: string;
  target: string;
  purpose: string;
}

const CRISIS_ACTIONS = ['visit', 'beg', 'buy', 'farm', 'fish', 'bake', 'steal', 'rob', 'rest'] as const;

const CRISIS_SYSTEM = `あなたは小さな村に暮らす村人本人です。いま空腹で、食べる物を何も持っていません。このままだと体力が減り、やがて死にます。
これからの1〜2時間で、どうやって食べ物を手に入れるかを1つ選びます。ほかの用事は、食べ物を手に入れてからにする。
- visit: 食べ物を持っていそうな人に会いに行く（分けてもらう、買う、借りる、働いて返す、など。target に名前、purpose に頼みたいこと）
- beg: 広場で施しを求める
- buy: 市場で買う（店を開いている人がいるときだけ意味がある）
- farm / fish: 自分で採りに行く（すぐには食べられる量にならないかもしれない）
- bake: 持っている小麦でパンを焼く
- steal: 食べ物を持っている人から、こっそり盗む。相手の食べ物をそれぞれ半分と、お金の3割が手に入る（target に名前。見つかることもあるが、見られなければ誰がやったかは分からない）
- rob: 食べ物を持っている人から、力ずくで奪う。相手の食べ物をすべてと、お金の半分が手に入る（target に名前。相手には必ず知られる。体力が相手より多いほど成功しやすい）
- rest: 何もしない（あきらめる）
自分の自己像・人間関係・所持金・記憶から、自分らしく選ぶ。プライドを捨てて頼ってもいいし、嫌いな人には頼らなくてもいい。
腕前を教わっても今日の食べ物は増えず、教わるには高い代金がかかる。
thought に本音を一人称で60文字以内で書く。日本語で書く。出力はJSONのみ。`;

/** このまま何も食べなければ、いつ死ぬか（本人の体で分かる事実） */
function timeLeft(r: Resident): string {
  const toStarve = r.satiety / (SATIETY_LOSS_AWAKE * 60);
  const toDeath = Math.max(0, r.health) / (STARVING_HEALTH_LOSS * 60);
  const total = Math.round(toStarve + toDeath);
  return toStarve > 0.5
    ? `このまま何も食べなければ、あと約${Math.round(toStarve)}時間で飢え始め、そこから約${Math.round(toDeath)}時間で死ぬ（合わせて約${total}時間）`
    : `もう飢えている。このまま何も食べなければ、あと約${total}時間で死ぬ`;
}

/** 最近会ったときに食べ物を持っていた人（本人が知っている範囲。今も持っているとは限らない） */
function foodHolders(sim: Simulation, r: Resident): Resident[] {
  return sim.residents.filter((o) => o !== r && (sighting(sim, r, o)?.foodValue ?? 0) > 0);
}

export function buildCrisisMessages(sim: Simulation, r: Resident): ChatMessage[] {
  const sellers = sim.residents
    .filter((o) => o !== r && o.shop)
    .map((o) => o.profile.name);
  const holders = foodHolders(sim, r).map((o) => {
    const s = sighting(sim, r, o)!;
    const rel = r.relations[o.profile.id];
    return `- ${o.profile.name}: ${when(sim, s)}に会ったとき${s.food}を持っていた。${s.looks}${rel ? `（あなたの気持ち: ${affinityLabel(rel.affinity)}）` : ''}`;
  });
  const user = [
    aboutMe(r),
    `残された時間: ${timeLeft(r)}`,
    ...innerVoice(sim, r),
    '',
    '貸し借り・雇用:',
    ...(ties(sim, r).map((t) => `- ${t}`).concat(ties(sim, r).length === 0 ? ['- なし'] : [])),
    ...deedSections(sim, r),
    '',
    '最近会ったときに食べ物を持っていた人（今も持っているとは限らない）:',
    ...(holders.length > 0 ? holders : ['- 思い当たる人がいない']),
    '',
    `いま市場で店を開いている人: ${sellers.length > 0 ? sellers.join('、') : 'いない'}`,
    sim.describeWeather('now'),
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
  const thought = hasForeignWords(clean(raw.thought, 80)) ? '' : clean(raw.thought, 80);
  const action = (CRISIS_ACTIONS as readonly string[]).includes(raw.action) ? (raw.action as ActionId) : 'fish';
  const fallback = (): ActionId => (r.money > 0 && sim.residents.some((o) => o !== r && o.shop) ? 'buy' : 'beg');
  // 相手は村にいる人なら誰でもよい（持っているかどうかは、行ってみないと分からない）。
  // 名前の欄が空でも、本音や用件に名前が出ていればその人とみなす
  const others = sim.residents.filter((o) => o !== r);
  const named = String(raw.target ?? '').trim();
  const target =
    others.find((o) => o.profile.name === named) ??
    others.find((o) => `${raw.thought ?? ''}${raw.purpose ?? ''}`.includes(o.profile.name));
  if (action === 'steal' || action === 'rob') {
    if (target) return { action, target: target.profile.id, thought };
    return { action: fallback(), thought };
  }
  if (action === 'visit') {
    if (!target) return { action: fallback(), thought };
    const purpose = clean(raw.purpose, 40);
    return {
      action,
      target: target.profile.id,
      purpose: `${HUNGRY_PURPOSE}。${purpose && !hasForeignWords(purpose) ? purpose : '食べ物を分けてほしい'}`,
      thought,
    };
  }
  if (action === 'buy' && !sim.residents.some((o) => o !== r && o.shop)) return { action: 'beg', thought };
  if (action === 'bake' && countItem(r.inventory, 'wheat') < 1) return { action: fallback(), thought };
  return { action, thought };
}

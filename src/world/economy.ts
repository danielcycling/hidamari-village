// ───────────── 品物 ─────────────

export type ItemId = 'wheat' | 'vegetable' | 'fish' | 'bread' | 'meal';

export interface ItemDef {
  name: string;
  /** 食べたときの満腹度。0 なら食べられない */
  satiety: number;
  /** 腐るまでの分。null なら腐らない。'day' はその日のうち */
  shelfLife: number | 'day' | null;
  /**
   * 値段が決まっていないときの代わりの値段（G）。LLMには見せない。
   * ルールの計画で動く売り手と、値段を書き忘れた売り手だけが使う。値段は本来、住民が自由に決める。
   */
  fallbackPrice: number;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  wheat: { name: '小麦', satiety: 0, shelfLife: null, fallbackPrice: 4 },
  vegetable: { name: '野菜', satiety: 15, shelfLife: 3 * 1440, fallbackPrice: 4 },
  fish: { name: '魚', satiety: 25, shelfLife: 1440, fallbackPrice: 8 },
  bread: { name: 'パン', satiety: 30, shelfLife: 2 * 1440, fallbackPrice: 10 },
  meal: { name: '定食', satiety: 50, shelfLife: 'day', fallbackPrice: 25 },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];
export const isFood = (id: ItemId) => ITEMS[id].satiety > 0;

// ───────────── 在庫（腐るものは期限ごとに分けて持つ） ─────────────

export interface Stack {
  item: ItemId;
  qty: number;
  /** 腐る時刻（1日目0:00からの分）。null なら腐らない */
  expiresAt: number | null;
}

export type Inventory = Stack[];

function expiryFor(item: ItemId, now: number): number | null {
  const life = ITEMS[item].shelfLife;
  if (life === null) return null;
  if (life === 'day') return (Math.floor(now / 1440) + 1) * 1440;
  return now + life;
}

export function addItem(inv: Inventory, item: ItemId, qty: number, now: number, expiresAt = expiryFor(item, now)) {
  if (qty <= 0) return;
  const same = inv.find((s) => s.item === item && s.expiresAt === expiresAt);
  if (same) same.qty += qty;
  else inv.push({ item, qty, expiresAt });
}

export function countItem(inv: Inventory, item: ItemId): number {
  return inv.reduce((n, s) => (s.item === item ? n + s.qty : n), 0);
}

/** 期限の近いものから取り出す。取り出したスタックを返す（他人に渡すとき期限を引き継ぐため） */
export function takeItem(inv: Inventory, item: ItemId, qty: number): Stack[] {
  const taken: Stack[] = [];
  const stacks = inv
    .filter((s) => s.item === item)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  let need = qty;
  for (const s of stacks) {
    if (need <= 0) break;
    const n = Math.min(s.qty, need);
    s.qty -= n;
    need -= n;
    taken.push({ item, qty: n, expiresAt: s.expiresAt });
  }
  for (let i = inv.length - 1; i >= 0; i--) if (inv[i].qty <= 0) inv.splice(i, 1);
  return taken;
}

export function moveItems(from: Inventory, to: Inventory, item: ItemId, qty: number, now: number): number {
  const taken = takeItem(from, item, qty);
  for (const s of taken) addItem(to, s.item, s.qty, now, s.expiresAt);
  return taken.reduce((n, s) => n + s.qty, 0);
}

/** 腐ったものを捨て、捨てた数を返す */
export function removeSpoiled(inv: Inventory, now: number): Partial<Record<ItemId, number>> {
  const spoiled: Partial<Record<ItemId, number>> = {};
  for (let i = inv.length - 1; i >= 0; i--) {
    const s = inv[i];
    if (s.expiresAt !== null && s.expiresAt <= now) {
      spoiled[s.item] = (spoiled[s.item] ?? 0) + s.qty;
      inv.splice(i, 1);
    }
  }
  return spoiled;
}

/** 持っている食べ物の満腹度の合計 */
export function foodValue(inv: Inventory): number {
  return inv.reduce((n, s) => n + ITEMS[s.item].satiety * s.qty, 0);
}

/** いちばん早く腐る食べ物（食べる順番） */
export function nextToEat(inv: Inventory): ItemId | null {
  const food = inv
    .filter((s) => isFood(s.item) && s.qty > 0)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return food[0]?.item ?? null;
}

export function describeInventory(inv: Inventory): string {
  const parts = ITEM_IDS.map((id) => [id, countItem(inv, id)] as const)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${ITEMS[id].name}${n}`);
  return parts.length > 0 ? parts.join('・') : 'なし';
}

// ───────────── 熟練度 ─────────────

export type SkillId = 'farm' | 'fish' | 'bake' | 'cook';

export const SKILLS: Record<SkillId, string> = {
  farm: '畑仕事',
  fish: '釣り',
  bake: 'パン焼き',
  cook: '料理',
};
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** 熟練度 0〜100 を、生産量の係数 0.5〜1.5 にする */
export const skillFactor = (skill: number) => 0.5 + Math.max(0, Math.min(100, skill)) / 100;

/** minutes 分働いたときの上達。上手になるほど伸びにくい（6時間で 0→約7、60時間で約51） */
export const practice = (skill: number, minutes: number) =>
  Math.min(100, 100 - (100 - skill) * Math.pow(1 - 0.0002, minutes));

/** その日使わなかった技能は少し衰える */
export const SKILL_DECAY_PER_DAY = 1;

// ───────────── 生理 ─────────────

export const SATIETY_LOSS_AWAKE = 4 / 60; // 1分あたり
export const SATIETY_LOSS_ASLEEP = 2 / 60;
export const STARVING_HEALTH_LOSS = 4 / 60;
export const HEALTH_RECOVERY = 1 / 60;
export const HUNGRY_BELOW = 30;

// ───────────── 生産 ─────────────

/**
 * 畑仕事1時間あたりの収穫（熟練係数を掛ける前）。
 * 素人が1日7〜8時間働いて、自分で焼いたパンと野菜でやっと1日分（約80）になる量。
 * 慣れれば5時間ほどで足りる。暮らしに余裕が出すぎると、困りごとが起きなくなる。
 */
export const FARM_PER_HOUR = { wheat: 0.8, vegetable: 0.65 };
/** 釣り1時間あたりに釣れる見込み（熟練係数を掛ける前）。素人だと7時間ほどで1日分 */
export const FISH_PER_HOUR = 0.9;
/** パン焼き・料理の1回にかかる分 */
export const CRAFT_MINUTES = 30;

export const BAKE_INPUT: Partial<Record<ItemId, number>> = { wheat: 1 };
export const COOK_INPUT: Partial<Record<ItemId, number>> = { vegetable: 2, fish: 1 };

export function hasInputs(inv: Inventory, inputs: Partial<Record<ItemId, number>>): boolean {
  return Object.entries(inputs).every(([id, n]) => countItem(inv, id as ItemId) >= (n ?? 0));
}

// ───────────── 初期値 ─────────────

export const STARTING_MONEY = 100;
export const STARTING_FOOD: [ItemId, number][] = [
  ['bread', 3],
  ['vegetable', 4],
];
/** お金は村の中で保存するので、新入村民は無一文でやってくる */
export const NEWCOMER_MONEY = 0;
export const NEWCOMER_FOOD: [ItemId, number][] = [['bread', 1]];

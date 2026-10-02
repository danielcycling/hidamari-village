import type { Rng } from '../core/rng';
import {
  countItem,
  FARM_PER_HOUR,
  foodValue,
  ITEMS,
  skillFactor,
  type Inventory,
  type ItemId,
  type SkillId,
} from './economy';

export type ActionId =
  | 'farm'
  | 'fish'
  | 'bake'
  | 'cook'
  | 'sell'
  | 'buy'
  | 'visit'
  | 'work_for'
  | 'beg'
  | 'wander'
  | 'rest';

/** 雇われて働ける仕事 */
export type WorkAction = 'farm' | 'fish' | 'bake' | 'cook';
export const WORK_ACTIONS: WorkAction[] = ['farm', 'fish', 'bake', 'cook'];

export interface ActionDef {
  label: string;
  /** 行く場所。'home' は自分の家 */
  place: string;
  skill?: SkillId;
}

/** 住民が選べる行動（S2ではLLMもここから選ぶ） */
export const ACTIONS: Record<ActionId, ActionDef> = {
  farm: { label: '畑仕事', place: 'field', skill: 'farm' },
  fish: { label: '釣り', place: 'fishing', skill: 'fish' },
  bake: { label: 'パン焼き', place: 'bakery', skill: 'bake' },
  cook: { label: '料理', place: 'kitchen', skill: 'cook' },
  sell: { label: '市場で売る', place: 'plaza' },
  buy: { label: '市場で買う', place: 'plaza' },
  // 相手のいる場所へ行く（場所は相手しだい）
  visit: { label: '会いに行く', place: 'plaza' },
  // 雇い主に言われた仕事をする（場所は仕事しだい）
  work_for: { label: '雇われ仕事', place: 'field' },
  beg: { label: '施しを求める', place: 'plaza' },
  wander: { label: 'ぶらぶらする', place: 'plaza' },
  rest: { label: '家で休む', place: 'home' },
};

export interface PlanBlock {
  /** 開始・終了時刻（0〜24 の小数） */
  from: number;
  to: number;
  action: ActionId;
  /** sell のときの値段 */
  prices?: Partial<Record<ItemId, number>>;
  /** visit の相手（住民ID）と目的 */
  target?: string;
  purpose?: string;
}

export interface DailyPlan {
  day: number;
  goal: string;
  blocks: PlanBlock[];
  source: 'rule' | 'ai';
  /** 計画を立てたときの本音（LLMの計画だけ） */
  thought?: string;
  /** 名乗る仕事。undefined なら変えない、空文字なら無職 */
  occupation?: string;
  /** 村を出ていく理由。あればこの日の朝に村を出る */
  leave?: string;
}

export const PLAN_ACTIONS = Object.keys(ACTIONS) as ActionId[];

/** 1日に必要な満腹度の目安 */
export const DAILY_NEED = 80;

export interface PlannerInput {
  day: number;
  inventory: Inventory;
  money: number;
  skills: Record<SkillId, number>;
  rng: Rng;
  /** 雇われているなら、その仕事 */
  employedAs?: WorkAction;
}

/**
 * ルールで1日の計画を立てる（LLMが使えないときの代役）。
 * 午前は材料を作り、昼と夕方に市場へ行き、午後は材料があれば加工する。
 */
export function rulePlan({ day, inventory, money, skills, rng, employedAs }: PlannerInput): DailyPlan {
  if (employedAs) {
    return {
      day,
      goal: `雇い主のもとで${ACTIONS[employedAs].label}をして、給料をもらう`,
      blocks: [
        { from: 6, to: 7, action: 'rest' },
        { from: 7, to: 11.5, action: 'work_for' },
        { from: 11.5, to: 13, action: money >= 10 ? 'buy' : 'wander' },
        { from: 13, to: 17, action: 'work_for' },
        { from: 17, to: 18.5, action: money >= 10 ? 'buy' : 'wander' },
        { from: 18.5, to: 22, action: 'rest' },
      ],
      source: 'rule',
    };
  }
  // 得意なほうを選ぶ。差がなければその日の気分（フラットな初期状態から差が生まれるきっかけ）
  const primary: ActionId = skills.farm + rng() * 20 >= skills.fish + rng() * 20 ? 'farm' : 'fish';
  const expectedWheat =
    countItem(inventory, 'wheat') + (primary === 'farm' ? 4.5 * FARM_PER_HOUR.wheat * skillFactor(skills.farm) : 0);
  const canCook =
    countItem(inventory, 'vegetable') >= 2 && (countItem(inventory, 'fish') >= 1 || primary === 'fish');
  const craft: ActionId = expectedWheat >= 1 ? 'bake' : canCook ? 'cook' : primary;

  const short = foodValue(inventory) < DAILY_NEED * 1.5;
  const market: ActionId = short && money >= 10 ? 'buy' : 'sell';
  const prices = Object.fromEntries(
    (Object.keys(ITEMS) as ItemId[]).map((id) => [id, Math.max(1, Math.round(ITEMS[id].fallbackPrice * (0.9 + rng() * 0.4)))]),
  ) as Record<ItemId, number>;

  const blocks: PlanBlock[] = [
    { from: 6, to: 7, action: 'rest' },
    { from: 7, to: 11.5, action: primary },
    { from: 11.5, to: 13, action: market, prices },
    { from: 13, to: 15, action: craft },
    { from: 15, to: 17, action: primary },
    { from: 17, to: 18.5, action: market === 'buy' ? 'buy' : 'sell', prices },
    { from: 18.5, to: 22, action: 'rest' },
  ];
  const goal =
    craft === 'bake'
      ? `${ACTIONS[primary].label}をして、パンを焼く`
      : craft === 'cook'
        ? `${ACTIONS[primary].label}をして、料理を作る`
        : `${ACTIONS[primary].label}で食べ物を手に入れる`;
  return { day, goal, blocks, source: 'rule' };
}

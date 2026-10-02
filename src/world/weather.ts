import type { Rng } from '../core/rng';

/** その日の空模様 */
export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm';

/** 空模様ごとの、畑仕事と釣りのはかどり具合（1 が普段どおり） */
export const WEATHER: Record<WeatherKind, { name: string; farm: number; fish: number; chance: number; note: string }> = {
  clear: { name: '晴れ', farm: 1, fish: 1, chance: 0.5, note: '' },
  cloudy: { name: '曇り', farm: 1, fish: 1.15, chance: 0.27, note: '曇りの日は魚がよく釣れる' },
  rain: { name: '雨', farm: 0.75, fish: 0.9, chance: 0.17, note: '雨の日は畑仕事がはかどらない' },
  storm: { name: '嵐', farm: 0.3, fish: 0, chance: 0.06, note: '嵐の日は川に近づけず釣りができない。畑仕事もほとんど進まない' },
};

/** 数日続く、村の外から来る出来事 */
export type ConditionKind = 'drought' | 'bounty' | 'good_catch' | 'poor_catch';

interface ConditionDef {
  name: string;
  /** 畑か川か（同じ側の出来事は重ならない） */
  domain: 'farm' | 'fish';
  factor: number;
  minDays: number;
  maxDays: number;
  start: string;
  end: string;
}

export const CONDITIONS: Record<ConditionKind, ConditionDef> = {
  drought: {
    name: '日照り',
    domain: 'farm',
    factor: 0.55,
    minDays: 3,
    maxDays: 6,
    start: '日照りが続いて、畑の作物が育たなくなってきた',
    end: '日照りが終わり、畑に元気が戻った',
  },
  bounty: {
    name: '実りの時期',
    domain: 'farm',
    factor: 1.35,
    minDays: 2,
    maxDays: 5,
    start: '畑の作物がよく実る時期になった',
    end: '畑の実りが落ち着いた',
  },
  good_catch: {
    name: '豊漁',
    domain: 'fish',
    factor: 1.6,
    minDays: 2,
    maxDays: 4,
    start: '川に魚の群れが来て、よく釣れるようになった',
    end: '魚の群れが去っていった',
  },
  poor_catch: {
    name: '不漁',
    domain: 'fish',
    factor: 0.45,
    minDays: 2,
    maxDays: 5,
    start: '川の魚がぱったり釣れなくなった',
    end: '川に魚が戻ってきた',
  },
};

export interface Condition {
  kind: ConditionKind;
  /** この日の朝に終わる */
  untilDay: number;
}

/** 1日に新しい出来事が始まる確率（畑・川それぞれ） */
const CONDITION_CHANCE = 0.07;
/** 前の晩の見立てどおりの空になる確率 */
export const FORECAST_ACCURACY = 0.7;

export function rollWeather(rng: Rng, conditions: Condition[]): WeatherKind {
  let roll = rng();
  for (const kind of Object.keys(WEATHER) as WeatherKind[]) {
    roll -= WEATHER[kind].chance;
    if (roll < 0) {
      // 日照りのあいだは雨が降らない
      if ((kind === 'rain' || kind === 'storm') && conditions.some((c) => c.kind === 'drought')) return 'clear';
      return kind;
    }
  }
  return 'clear';
}

/** 新しく始まる出来事（なければ null）。同じ側（畑・川）で続いているものがあれば始まらない */
export function rollCondition(rng: Rng, conditions: Condition[], day: number): Condition | null {
  for (const domain of ['farm', 'fish'] as const) {
    if (conditions.some((c) => CONDITIONS[c.kind].domain === domain)) continue;
    if (rng() >= CONDITION_CHANCE) continue;
    const kinds = (Object.keys(CONDITIONS) as ConditionKind[]).filter((k) => CONDITIONS[k].domain === domain);
    const kind = kinds[Math.floor(rng() * kinds.length)];
    const def = CONDITIONS[kind];
    const days = def.minDays + Math.floor(rng() * (def.maxDays - def.minDays + 1));
    return { kind, untilDay: day + days };
  }
  return null;
}

/** 空模様と出来事を合わせた、畑仕事・釣りの倍率 */
export function productionFactor(kind: WeatherKind, conditions: Condition[], domain: 'farm' | 'fish'): number {
  return conditions.reduce(
    (f, c) => (CONDITIONS[c.kind].domain === domain ? f * CONDITIONS[c.kind].factor : f),
    WEATHER[kind][domain],
  );
}

export const isWet = (kind: WeatherKind) => kind === 'rain' || kind === 'storm';

import type { Rng } from '../core/rng';

export interface Palette {
  hair: string;
  skin: string;
  shirt: string;
  pants: string;
  shoes: string;
}

/**
 * 住民の生まれ持ったもの。名前と見た目だけで、性格・年齢・性別・仕事は持たない。
 * 個性は経験から育つ（記憶・熟練度・人間関係・自己像）。
 */
export interface ResidentProfile {
  id: string;
  name: string;
  homeId: string;
  colors: Palette;
}

export interface Relation {
  /** -100（大嫌い）〜 100（大好き） */
  affinity: number;
  /** 相手への今の印象をひとことで */
  impression: string;
  /** 気持ちが動いた理由（新しい順に数件） */
  notes?: { day: number; text: string; delta: number }[];
}

export const SLEEP_ACTIVITY = '睡眠';
/** 全員共通の就寝時間（時） */
export const SLEEP_FROM = 22;
export const WAKE_AT = 6;

/** 性別や年齢を連想させにくい名前 */
const NAMES = [
  'ハル', 'ソラ', 'アオイ', 'ユウ', 'レン', 'マコト', 'ヒカル', 'ナギ',
  'カナタ', 'ミズキ', 'アサヒ', 'ツバサ', 'イツキ', 'シノ', 'トワ', 'ルイ',
];

const HAIR = ['#2b2b2b', '#5a3a22', '#8a3f1f', '#c9a25a', '#3b2a4a', '#7a7a7a', '#a33a3a'];
const SKIN = ['#f9dcc4', '#f6d3b3', '#e9b98f', '#d9a074', '#b97f56'];
const SHIRT = ['#d65d5d', '#5d8fd6', '#6fbf73', '#e0b040', '#a070c0', '#e08a50', '#50b0b0', '#e8e8e8'];
const PANTS = ['#2f3e5c', '#4a3a2a', '#2a2a3a', '#5a4a7a', '#3a5a3a'];

export function randomPalette(rng: Rng = Math.random): Palette {
  const pick = (xs: string[]) => xs[Math.floor(rng() * xs.length)];
  return { hair: pick(HAIR), skin: pick(SKIN), shirt: pick(SHIRT), pants: pick(PANTS), shoes: '#2a2018' };
}

/** まだ使われていない名前をひとつ選ぶ（尽きたら番号をつける） */
export function pickName(rng: Rng, taken: Iterable<string>): string {
  const used = new Set(taken);
  const free = NAMES.filter((n) => !used.has(n));
  if (free.length > 0) return free[Math.floor(rng() * free.length)];
  let i = 2;
  while (used.has(`${NAMES[0]}${i}`)) i++;
  return `${NAMES[0]}${i}`;
}

/** 最初の住民たち。家だけ割り当て、それ以外は全員同じ */
export function createFounders(rng: Rng, homeIds: string[]): ResidentProfile[] {
  const names: string[] = [];
  return homeIds.map((homeId, i) => {
    const name = pickName(rng, names);
    names.push(name);
    return { id: `r${i + 1}`, name, homeId, colors: randomPalette(rng) };
  });
}

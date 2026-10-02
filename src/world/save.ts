import type { Inventory, SkillId } from './economy';
import type { DailyPlan } from './planner';
import type { Relation, ResidentProfile } from './residents';
import {
  emptyDayStats,
  type DayRecord,
  type DayStats,
  type Debt,
  type Employment,
  type Estate,
  type Gathering,
  type Grave,
  type LogEntry,
  type MarketDay,
  type Memory,
  type News,
  type Simulation,
  type WeatherKind,
} from './sim';

const STORAGE_KEY = 'hidamari-village/save';
/** 2: 経済と生存（S1）。1 の保存データは読み込まない */
const SAVE_VERSION = 2;

interface SavedResident {
  profile: ResidentProfile;
  x: number;
  y: number;
  indoors: boolean;
  placeId: string | null;
  targetPlaceId: string;
  memories: Memory[];
  relations: Record<string, Relation>;
  satiety: number;
  health: number;
  money: number;
  inventory: Inventory;
  skills: Record<SkillId, number>;
  occupation: string;
  selfImage: string;
  plan: DailyPlan | null;
  progress: Partial<Record<string, number>>;
  today: DayStats;
  history: DayRecord[];
  nextPlan: DailyPlan | null;
  selfImageHistory: { day: number; text: string }[];
  leaving: string | null;
}

export interface SaveData {
  version: number;
  savedAt: string;
  clockMinutes: number;
  speed: number;
  residents: SavedResident[];
  graves: Grave[];
  estates: Record<string, Estate>;
  market: { today: MarketDay; yesterday: MarketDay };
  debts?: Debt[];
  employments?: Employment[];
  dealSeq?: number;
  news: News[];
  weather: { kind: WeatherKind; until: number };
  gatherings: Gathering[];
  lastMet: [string, number][];
  conversationSeq: number;
  placeNames: Record<string, string>;
  log: LogEntry[];
  autoGod: boolean;
}

export function serialize(sim: Simulation, autoGod: boolean): SaveData {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    clockMinutes: sim.clock.minutes,
    speed: sim.clock.speed,
    residents: sim.residents.map((r) => ({
      profile: r.profile,
      x: r.x,
      y: r.y,
      indoors: r.indoors,
      placeId: r.placeId,
      targetPlaceId: r.targetPlaceId,
      memories: r.memories,
      relations: r.relations,
      satiety: r.satiety,
      health: r.health,
      money: r.money,
      inventory: r.inventory,
      skills: r.skills,
      occupation: r.occupation,
      selfImage: r.selfImage,
      plan: r.plan,
      progress: r.progress,
      today: r.today,
      history: r.history,
      nextPlan: r.nextPlan,
      selfImageHistory: r.selfImageHistory,
      leaving: r.leaving,
    })),
    graves: sim.graves,
    estates: sim.estates,
    market: sim.market,
    debts: sim.debts,
    employments: sim.employments,
    dealSeq: sim.dealSeq,
    news: sim.news,
    weather: sim.weather,
    gatherings: sim.gatherings,
    lastMet: [...sim.lastMet],
    conversationSeq: sim.conversationSeq,
    placeNames: Object.fromEntries(Object.values(sim.map.places).map((p) => [p.id, p.name])),
    log: sim.logHistory,
    autoGod,
  };
}

/** 保存データで村を上書きする。会話の途中だったものは打ち切る */
export function restore(sim: Simulation, data: SaveData): void {
  sim.clock.minutes = data.clockMinutes;
  sim.clock.speed = data.speed;
  for (const [id, name] of Object.entries(data.placeNames)) {
    if (sim.map.places[id]) sim.map.places[id].name = name;
  }
  sim.residents.length = 0;
  for (const saved of data.residents) {
    const indoors = saved.indoors && !!saved.placeId && !!sim.map.places[saved.placeId]?.building;
    sim.residents.push({
      profile: saved.profile,
      x: Math.round(saved.x),
      y: Math.round(saved.y),
      path: [],
      state: 'idle',
      indoors,
      // 外にいた人は、次の更新で今いるべき場所へ歩き直す
      placeId: indoors ? saved.placeId : null,
      targetPlaceId: indoors ? saved.targetPlaceId : '',
      activity: '',
      action: 'rest',
      idleUntil: 0,
      conversation: null,
      memories: saved.memories,
      relations: saved.relations,
      facing: 1,
      stride: 0,
      satiety: saved.satiety,
      health: saved.health,
      money: saved.money,
      inventory: saved.inventory,
      skills: saved.skills,
      occupation: saved.occupation,
      selfImage: saved.selfImage,
      plan: saved.plan,
      override: null,
      progress: saved.progress,
      shop: null,
      nextBuyAt: 0,
      today: { ...emptyDayStats(), ...saved.today },
      history: saved.history ?? [],
      nextPlan: saved.nextPlan ?? null,
      selfImageHistory: saved.selfImageHistory ?? [],
      leaving: saved.leaving ?? null,
    });
  }
  replace(sim.graves, data.graves);
  for (const k of Object.keys(sim.estates)) delete sim.estates[k];
  Object.assign(sim.estates, data.estates);
  if (data.market) sim.market = data.market;
  replace(sim.debts, data.debts ?? []);
  replace(sim.employments, data.employments ?? []);
  sim.dealSeq = data.dealSeq ?? 0;
  replace(sim.news, data.news);
  sim.weather = data.weather;
  replace(sim.gatherings, data.gatherings);
  sim.lastMet.clear();
  for (const [k, v] of data.lastMet) sim.lastMet.set(k, v);
  sim.conversationSeq = data.conversationSeq;
  replace(sim.logHistory, data.log);
  sim.resyncClock();
}

const replace = <T>(target: T[], items: T[]) => target.splice(0, target.length, ...items);

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return data.version === SAVE_VERSION ? data : null;
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 消せなくても致命的ではない
  }
}

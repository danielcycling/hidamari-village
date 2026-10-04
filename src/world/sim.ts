import { Emitter } from '../core/emitter';
import { mulberry32, randInt, type Rng } from '../core/rng';
import {
  CONDITIONS,
  FORECAST_ACCURACY,
  isWet,
  productionFactor,
  rollCondition,
  rollWeather,
  WEATHER,
  type Condition,
  type ConditionKind,
  type WeatherKind,
} from './weather';
import { Clock } from './clock';
import {
  addItem,
  BAKE_INPUT,
  BREW_INPUT,
  BUILD_MINUTES_PER_WOOD,
  HOME_UPGRADE_WOOD,
  MAX_HOME_LEVEL,
  WOOD_PER_HOUR,
  COOK_INPUT,
  countItem,
  CRAFT_MINUTES,
  describeInventory,
  FARM_PER_HOUR,
  FISH_PER_HOUR,
  foodValue,
  hasInputs,
  moveItems,
  HEALTH_RECOVERY,
  HUNGRY_BELOW,
  isFood,
  ITEM_IDS,
  ITEMS,
  NEWCOMER_FOOD,
  NEWCOMER_MONEY,
  nextToEat,
  practice,
  removeSpoiled,
  SATIETY_LOSS_ASLEEP,
  SATIETY_LOSS_AWAKE,
  SKILL_DECAY_PER_DAY,
  SKILL_IDS,
  skillFactor,
  SKILLS,
  STARVING_HEALTH_LOSS,
  takeItem,
  type Inventory,
  type ItemId,
  type SkillId,
} from './economy';
import { findWalkPath, isWalkable } from './map';
import { VILLAGE_ENTRANCE } from './mapgen';
import {
  ACTIONS,
  DAILY_NEED,
  rulePlan,
  TARGETED_ACTIONS,
  type ActionId,
  type CrimeAction,
  type DailyPlan,
  type PlanBlock,
  type WorkAction,
} from './planner';
import {
  pickName,
  randomPalette,
  SLEEP_ACTIVITY,
  SLEEP_FROM,
  WAKE_AT,
  type Relation,
  type ResidentProfile,
} from './residents';
import { rectContains, type Place, type Point, type WorldMap } from './types';

/** 1分（村時間）あたりに歩くタイル数 */
const WALK_SPEED = 1;
/** 同じ2人が再び話し始めるまでの間隔（分） */
const MEET_COOLDOWN = 180;
/**
 * 会話で2人が立ち止まる村の時間（分）。セリフは読める速さで流すので現実では数十秒かかるが、
 * それに合わせて村の時間まで止めると、話すたびに何時間も働けなくなってしまう。
 */
const AI_TALK_MINUTES = 15;
const GREETING_TALK_MINUTES = 3;
/** あいさつ1行にかかる村の時間（分） */
const GREETING_LINE_MINUTES = 1.5;
/** AIの返事をこれ以上待たない（現実の秒） */
const PENDING_TIMEOUT = 90;
const MAX_MEMORIES = 40;
/** 市場で、これだけの満腹度ぶんは手元に残す（売らない） */
const KEEP_FOOD = DAILY_NEED;
/** 市場で、これだけの満腹度ぶんになるまで買う */
const BUY_UNTIL = DAILY_NEED * 2;
/** 小麦はこれだけ手元に残す（パンを焼くため） */
const KEEP_WHEAT = 2;
const BUY_INTERVAL = 15;
/** 翌日の計画を立て始める時刻（時） */
export const PLANNING_HOUR = 21;
/** 新入村民が来るかどうかを判定する時刻（時） */
const IMMIGRATION_HOUR = 10;
/** 村の集会の時間（集会所） */
const ASSEMBLY_FROM = 18;
const ASSEMBLY_TO = 19.5;
/** 話し合いがまとまらないまま、これ以上は待たない（分） */
const ASSEMBLY_GIVE_UP = 240;
/** 家を1段改築したときに、村の人から集まる好感度（段の高さを掛ける） */
const HOME_RESPECT = 4;
/** お酒1杯で上がる満足 */
const DRINK_JOY = 15;
/** 家の立派さの呼び名（0〜3） */
export const HOME_LEVEL_NAMES = ['ふつうの家', '手入れの行き届いた家', '立派な家', '村一番の屋敷'];
/** 悪魔のささやきが心に残る時間（分） */
const TEMPTATION_MINUTES = 2 * 1440;
/** 飢えて頼んだのに断られたときの、相手への気持ちの下がり方 */
const REFUSAL_GRUDGE = 8;
/** 盗み・暴力を見ていられる距離（マス） */
const WITNESS_RANGE = 7;
/** 盗み・強奪で取れる割合（食べ物はそれぞれの種類から、お金は所持金から） */
const STEAL_SHARE = { food: 0.5, money: 0.3 };
const ROB_SHARE = { food: 1, money: 0.5 };
/** 盗まれた本人がその場で気づく確率 */
const STEAL_NOTICE = 0.35;
/** 居合わせた人が盗みに気づく確率・暴力に気づく確率 */
const STEAL_WITNESS = 0.5;
const VIOLENCE_WITNESS = 0.9;
/** やられた人・見た人の、相手への気持ちの下がり方 */
const VICTIM_GRUDGE: Record<CrimeAction, number> = { steal: 30, rob: 40, attack: 50, kill: 70 };
const WITNESS_GRUDGE: Record<CrimeAction, number> = { steal: 15, rob: 20, attack: 25, kill: 50 };
/** 「AがB〇〇」の〇〇（したこととして話すとき） */
const DEED_DONE: Record<CrimeAction, string> = {
  steal: 'から物を盗んだ',
  rob: 'から力ずくで奪った',
  attack: 'を殴った',
  kill: 'を殺した',
};
/** 「AがB〇〇」の〇〇 */
const DEED_LABEL: Record<CrimeAction, string> = {
  steal: 'から物を盗む',
  rob: 'から力ずくで奪う',
  attack: 'を殴る',
  kill: 'を殺す',
};

/** その日の空模様が決まる時刻 */
const WEATHER_HOUR = 5;
const MAX_HISTORY_DAYS = 7;
/** パンを焼く予定の人が、市場で買いそろえる小麦の数 */
const WHEAT_TO_BUY = 4;

export type ResidentState = 'walking' | 'idle' | 'talking';
export type CurrentAction = ActionId | 'sleep' | 'gather' | 'arrive';

export interface Memory {
  day: number;
  time: string;
  text: string;
}

/** その日の出来高（日の終わりに要約して記憶とログに残す） */
export interface DayStats {
  produced: Partial<Record<ItemId, number>>;
  ate: Partial<Record<ItemId, number>>;
  bought: Partial<Record<ItemId, number>>;
  sold: Partial<Record<ItemId, number>>;
  spent: number;
  earned: number;
  spoiled: Partial<Record<ItemId, number>>;
  /** 行動ごとに費やした時間 */
  hours: Partial<Record<ActionId, number>>;
  /** お酒を飲んだ数・AIの会話をした数（満足の材料） */
  drank?: number;
  talks?: number;
}

/** 過去の1日の記録（自己像や計画の材料） */
export interface DayRecord {
  day: number;
  summary: string;
  hours: Partial<Record<ActionId, number>>;
  earned: number;
  spent: number;
  starved: boolean;
}

/** 市場の1日の記録。翌朝の計画で「相場」として参照する */
export interface MarketDay {
  sold: Partial<Record<ItemId, { qty: number; revenue: number }>>;
  /** 店じまいのときに売れ残っていた数 */
  leftover: Partial<Record<ItemId, number>>;
}

const emptyMarketDay = (): MarketDay => ({ sold: {}, leftover: {} });

export interface Resident {
  profile: ResidentProfile;
  /** タイル単位の座標（小数） */
  x: number;
  y: number;
  path: Point[];
  state: ResidentState;
  /** 建物の中にいるか（中にいる間はマップに描かれない） */
  indoors: boolean;
  /** 到着済みの場所。移動中は null */
  placeId: string | null;
  targetPlaceId: string;
  /** 今していることの表示名 */
  activity: string;
  action: CurrentAction;
  idleUntil: number;
  conversation: Conversation | null;
  memories: Memory[];
  relations: Record<string, Relation>;
  facing: 1 | -1;
  /** 歩いた距離。歩行アニメーションに使う */
  stride: number;

  // ── 生存と経済 ──
  satiety: number;
  health: number;
  money: number;
  inventory: Inventory;
  skills: Record<SkillId, number>;
  /** 本人が名乗っている仕事（空なら無職） */
  occupation: string;
  /** 経験から育つ自己像（S2で生成） */
  selfImage: string;
  plan: DailyPlan | null;
  /** 計画どおりにできなかったとき、ブロックの終わりまでの代わりの行動 */
  override: Override | null;
  /** 生産の端数（1個に満たない出来高） */
  progress: Partial<Record<string, number>>;
  /** 市場で開いている店 */
  shop: { prices: Partial<Record<ItemId, number>> } | null;
  nextBuyAt: number;
  today: DayStats;
  history: DayRecord[];
  /** 前の晩に立てた、翌日の計画 */
  nextPlan: DailyPlan | null;
  selfImageHistory: { day: number; text: string }[];
  /** 家の立派さ（0〜3）。改築すると上がり、誰からも見える */
  homeLevel?: number;
  /** 暮らしの満足（0〜100）と、その理由（毎晩見直す） */
  satisfaction?: number;
  satisfactionNotes?: string[];
  /** 経験から育った望み（「いつか〜したい」）。自己像と一緒に見つめ直す */
  wish?: string;
  wishHistory?: { day: number; text: string }[];
  /** 村を出ていく理由（出ていく途中なら入る） */
  leaving: string | null;
  /** 「高すぎて買えなかった」を最後に覚えた日（同じ日に何度も覚えないため） */
  lastPriceComplaintDay?: number;
  /** 会いに行って話し終えた相手（同じブロックで何度も話しかけないため） */
  visited?: { targetId: string; until: number };
  /** 危機の判断をLLMに頼んだ時刻 */
  crisisRequestedAt?: number;
  /** 悪魔のささやき（心の奥の声）と、それが消える時刻 */
  temptation?: { text: string; until: number };
  /** 最後に会ったときに見た、相手の様子と持っていた食べ物（人の持ち物は、見たことしか分からない） */
  seen?: Record<string, Sighting>;
  /** 施しを求め始めた時刻と、そのときの食べ物（もらえたかどうかを後で確かめる） */
  begging?: { since: number; food: number; money: number };
}

/** 人を見かけたときに分かったこと */
export interface Sighting {
  day: number;
  time: string;
  at: number;
  /** 持っていた食べ物（「パン2・魚1」。何もなければ空） */
  food: string;
  foodValue: number;
  /** 見た目（やつれている・元気そう など） */
  looks: string;
}

/** 計画どおりにできないとき・危機のときの、一時的な行動 */
export interface Override {
  action: ActionId;
  until: number;
  target?: string;
  purpose?: string;
}

/** 貸し借り */
export interface Debt {
  id: number;
  lenderId: string;
  borrowerId: string;
  principal: number;
  remaining: number;
  createdDay: number;
  dueDay: number;
  /** 最後に「返してもらえない」と覚えた日 */
  lastComplainedDay?: number;
}

/** 「品物ができたら渡す」という、まだ果たされていない売買 */
export interface Delivery {
  id: number;
  sellerId: string;
  buyerId: string;
  item: ItemId;
  qty: number;
  /** 受け渡しのときに払う代金 */
  money: number;
  createdDay: number;
  dueDay: number;
}

/** 雇用 */
export interface Employment {
  id: number;
  employerId: string;
  employeeId: string;
  action: WorkAction;
  /** 日給（G）。6時間働けば満額 */
  wage: number;
  startDay: number;
  untilDay: number;
  workedToday: number;
}

export type AgreementType = 'trade' | 'gift' | 'loan' | 'repay' | 'hire' | 'quit' | 'teach' | 'promise' | 'hush';

/** 誰かが誰かにした非行・暴力の記録。誰が知っているかも持つ（秘密はここから生まれる） */
export interface Deed {
  id: number;
  kind: CrimeAction;
  actorId: string;
  actorName: string;
  victimId: string;
  victimName: string;
  /** うまくいったか（盗めた・奪えた・殺せた） */
  success: boolean;
  /** 盗んだ・奪ったもの */
  items?: { item: ItemId; qty: number }[];
  money?: number;
  /** 古い保存データ用（1種類だけ記録していたころ） */
  item?: ItemId;
  qty?: number;
  /** 殴った・抵抗されたときの傷 */
  damage?: number;
  day: number;
  time: string;
  placeName: string;
  /** 誰がやったかを知っている人（本人以外）。saw=見た、victim=やられて相手を見た、heard=人から聞いた */
  knownBy: Record<string, 'saw' | 'victim' | 'heard'>;
  /** 本人が「見られた」と気づいている相手 */
  actorSawWitness: string[];
  /** 口止めされて、黙ると約束した人 */
  hushed: string[];
  /** 広場で言いふらされたなどで、村のみんなが聞いている */
  public: boolean;
}

/** 盗まれた人が、あとで物やお金が減っていることに気づく予定 */
export interface PendingDiscovery {
  deedId: number;
  at: number;
  /** 盗まれたころ近くにいた人（犯人を含むとは限らない） */
  nearby: string[];
}

/**
 * 会話の中で決まったこと。from/to の意味は種類ごとに違う：
 * trade=売り手/買い手、gift=あげる人/もらう人、loan=貸す人/借りる人、repay=返す人/返される人、
 * hire=雇う人/雇われる人、quit=辞める人/雇い主、teach=教える人/教わる人、promise=約束する人/される人
 */
export interface Agreement {
  type: AgreementType;
  fromId: string;
  toId: string;
  item?: ItemId;
  qty?: number;
  money?: number;
  days?: number;
  action?: WorkAction;
  text?: string;
}

export interface Grave {
  name: string;
  colors: ResidentProfile['colors'];
  at: Point;
  day: number;
  time: string;
  cause: string;
}

/** 亡くなった人や出て行った人が家に残したもの */
export interface Estate {
  ownerName: string;
  money: number;
  inventory: Inventory;
}

export interface DialogueLine {
  speakerId: string;
  text: string;
}

export interface Reflection {
  /** 好感度が動いた理由（記録係が判定したとき） */
  reason?: string;
  residentId: string;
  memory: string;
  affinityDelta: number;
  impression: string;
}

export interface ConversationOutcome {
  summary: string;
  reflections: Reflection[];
  agreements: Agreement[];
}

export interface Conversation {
  id: number;
  a: Resident;
  b: Resident;
  placeName: string;
  indoors: boolean;
  /** ai: AIが中身を考える / greeting: あいさつだけ */
  kind: 'ai' | 'greeting';
  /** AIの返事待ちの間は null */
  lines: DialogueLine[] | null;
  index: number;
  /** 今の行を表示してからの現実の秒 */
  elapsed: number;
  waited: number;
  outcome: ConversationOutcome | null;
  /** 会いに行った側の目的（会いに来た会話のときだけ） */
  purpose?: string;
  /** 2人が立ち止まって話している時刻の終わり（村の分） */
  engagedUntil: number;
  /** 会いに来た側（a）が、この会話で何かを受け取ったか */
  received?: boolean;
  /** 会話で決まったことの書き出しが済んだか */
  agreementsReady?: boolean;
  /** 「飢えて頼んだのに断られた」をもう確かめたか */
  refusalChecked?: boolean;
}

/** 飢えた人が人を頼るときの用件の書き出し（断られたかどうかの判定に使う） */
export const HUNGRY_PURPOSE = '食べる物がなくて困っている';

export interface LogEntry {
  time: string;
  text: string;
  kind:
    | 'arrive'
    | 'meet'
    | 'greet'
    | 'speech'
    | 'summary'
    | 'system'
    | 'god'
    | 'trade'
    | 'life'
    | 'death'
    | 'day'
    | 'plan'
    | 'deal'
    | 'crime'
    | 'assembly';
  speakerId?: string;
  /** 同じ会話のログをまとめて表示するための番号 */
  conversationId?: number;
}

export type SimEvents = {
  log: LogEntry;
  encounter: Conversation;
  conversationEnd: Conversation;
  residentAdded: Resident;
  residentDied: Grave;
  /** 朝、その日の計画が決まった */
  planMade: Resident;
  /** 夜、翌日の計画を立てる時間になった */
  evening: { day: number };
  /** 毎時0分 */
  hourly: { day: number; hour: number };
  residentLeft: { name: string };
  /** 村の集会が始まった（AIに話し合いを考えてもらう） */
  assemblyStart: Assembly;
};

/** 村人みんなが知っている出来事 */
export interface News {
  /** 起きた時刻（1日目0:00からの分） */
  at: number;
  day: number;
  time: string;
  text: string;
}

export type { WeatherKind } from './weather';

/** 一定時間、全員の予定を上書きする（お祭りなど） */
export interface Gathering {
  from: number;
  to: number;
  placeId: string;
  activity: string;
  /** 村の集会なら、その番号 */
  assemblyId?: number;
}

/** 村の集会。誰かが呼びかけ、夕方に集会所で開かれる */
export interface Assembly {
  id: number;
  callerId: string;
  callerName: string;
  agenda: string;
  /** 議題の相手（追放・罰の対象など） */
  targetId?: string;
  targetName?: string;
  day: number;
  from: number;
  status: 'scheduled' | 'deliberating' | 'done';
  result?: AssemblyResult;
}

export type ProposalKind = 'exile' | 'fine' | 'rule' | 'repeal' | 'none';

export interface AssemblyResult {
  speeches: { speakerId: string; text: string }[];
  proposal: {
    kind: ProposalKind;
    /** 追放・罰金の相手 */
    targetId?: string;
    /** 罰金の額と、受け取る人（いなければ村のみんなで分ける） */
    amount?: number;
    beneficiaryId?: string;
    /** 決まりの名前と中身、廃止する決まりの番号 */
    title?: string;
    text?: string;
    lawId?: number;
  };
  votes: { voterId: string; yes: boolean; reason: string }[];
  passed: boolean;
  summary: string;
}

/** 村の決まり（集会で決めたもの） */
export interface Law {
  id: number;
  title: string;
  text: string;
  enactedDay: number;
  assemblyId: number;
}

interface Task {
  placeId: string;
  action: CurrentAction;
  label: string;
  block?: PlanBlock;
  target?: string;
  purpose?: string;
}

const MAX_NEWS = 20;
const MAX_LOG_HISTORY = 600;

export const emptyDayStats = (): DayStats => ({
  produced: {},
  ate: {},
  bought: {},
  sold: {},
  spent: 0,
  earned: 0,
  spoiled: {},
  hours: {},
});

export interface NewResidentOptions {
  money: number;
  food: [ItemId, number][];
  at: Point;
  indoors: boolean;
}

export class Simulation {
  readonly clock = new Clock();
  readonly events = new Emitter<SimEvents>();
  readonly residents: Resident[] = [];
  readonly conversations: Conversation[] = [];
  /** 出会ったときにAIで会話させるか、あいさつで済ませるかを決める */
  conversationGate: (a: Resident, b: Resident) => Conversation['kind'] = () => 'greeting';
  readonly news: News[] = [];
  /** 今の空。until > 0 なら神さまが降らせた一時的な雨で、過ぎると dayWeather に戻る */
  weather: { kind: WeatherKind; until: number } = { kind: 'clear', until: 0 };
  /** 今日の本来の空模様 */
  dayWeather: WeatherKind = 'clear';
  /** 前の晩の見立て（明日の空模様） */
  forecast: WeatherKind = 'clear';
  /** 数日続く出来事（日照り・豊漁など） */
  readonly conditions: Condition[] = [];
  readonly gatherings: Gathering[] = [];
  readonly graves: Grave[] = [];
  readonly estates: Record<string, Estate> = {};
  market = { today: emptyMarketDay(), yesterday: emptyMarketDay() };
  /**
   * 夜明けを待たせるかどうか（AIがまだ今日の計画を考えているあいだ true を返す）。
   * 未設定なら待たない。
   */
  dawnHold: (() => boolean) | null = null;
  /** 夜明け前で時計を止めているか */
  holdingDawn = false;
  readonly debts: Debt[] = [];
  readonly employments: Employment[] = [];
  readonly deliveries: Delivery[] = [];
  dealSeq = 0;
  /** 村の集会（予定・済み） */
  readonly assemblies: Assembly[] = [];
  /** 村の決まり */
  readonly laws: Law[] = [];
  assemblySeq = 0;
  lawSeq = 0;
  /** 非行と暴力の記録（神の視点ではすべて見える） */
  readonly deeds: Deed[] = [];
  readonly pendingDiscoveries: PendingDiscovery[] = [];
  deedSeq = 0;
  /**
   * 飢えかけた住民の判断をLLMに頼む。引き受けたら true（あとで setOverride が呼ばれる）。
   * 未設定、または false ならルールで動く。
   */
  crisisHandler: ((r: Resident) => boolean) | null = null;
  /** 保存して次回も表示するためのログ */
  readonly logHistory: LogEntry[] = [];
  /** ペアごとの最後に話した時刻（同じ2人が話しすぎないように） */
  readonly lastMet = new Map<string, number>();
  conversationSeq = 0;
  private readonly rng: Rng;
  /** 天気は別の乱数で決める（天気が住民の行動の乱数をずらさないように） */
  private readonly weatherRng: Rng;
  private lastHour = -1;
  private lastDay = 0;
  private lastEveningDay = 0;

  constructor(
    readonly map: WorldMap,
    profiles: ResidentProfile[],
    startingMoney: number,
    startingFood: [ItemId, number][],
    seed = 1,
  ) {
    this.rng = mulberry32(seed);
    this.weatherRng = mulberry32(seed ^ 0x5eed);
    for (const profile of profiles) {
      this.createResident(profile, {
        money: startingMoney,
        food: startingFood,
        at: map.places[profile.homeId].spot,
        indoors: true,
      });
    }
    this.lastDay = this.clock.day;
    this.lastHour = Math.floor(this.clock.minutes / 60);
    for (const r of this.residents) this.makePlan(r);
  }

  get(id: string): Resident | undefined {
    return this.residents.find((r) => r.profile.id === id);
  }

  /** 時計を外から動かしたあと（読み込み・時刻指定）に、日や時の区切りの判定を合わせ直す */
  resyncClock(): void {
    this.lastDay = this.clock.day;
    this.lastHour = Math.floor(this.clock.minutes / 60);
  }

  /** 村の中にあるお金の合計（総量が保存されているかの確認用） */
  totalMoney(): number {
    return (
      this.residents.reduce((n, r) => n + r.money, 0) + Object.values(this.estates).reduce((n, e) => n + e.money, 0)
    );
  }

  /** 現実の経過秒ぶん村を進める。大きく進むときも1分刻みで処理する */
  update(realSeconds: number): void {
    // AIの会話中に早送りすると、数行話すだけで何時間も経ってしまうので等速に抑える
    const speed = this.isSlowedForConversation ? 1 : this.clock.speed;
    let remaining = this.clock.scaledDelta(realSeconds, speed);
    const startMinutes = this.clock.minutes;
    this.holdingDawn = false;
    while (remaining > 0) {
      const dt = Math.min(1, remaining);
      const dawn = Math.floor(this.clock.minutes / 1440) * 1440 + WAKE_AT * 60;
      if (this.clock.minutes < dawn && this.clock.minutes + dt >= dawn && this.dawnHold?.()) {
        // みんなが今日の計画を決めるまで、夜明け直前で待つ
        this.holdingDawn = true;
        break;
      }
      this.clock.minutes += dt;
      this.onClockTick();
      for (const r of [...this.residents]) this.updateResident(r, dt);
      this.detectOutdoorEncounters();
      remaining -= dt;
    }
    if (this.clock.speed > 0) this.advanceConversations(realSeconds, this.clock.minutes - startMinutes);
  }

  get isSlowedForConversation(): boolean {
    return (
      this.clock.speed > 1 &&
      (this.conversations.some((c) => c.kind === 'ai') || this.assemblies.some((a) => a.status === 'deliberating'))
    );
  }

  /** AIが考えた会話を流し始める */
  setDialogue(conv: Conversation, lines: DialogueLine[], outcome: ConversationOutcome | null): void {
    if (!this.conversations.includes(conv) || conv.lines) return;
    conv.lines = lines;
    conv.outcome = outcome;
    conv.elapsed = 0;
    this.announceLine(conv);
  }

  /** 会話のあとで書き出された取り決めを加える。会話がもう終わっていれば、すぐ実行する */
  addAgreements(conv: Conversation, agreements: Agreement[]): void {
    if (!conv.outcome) return;
    conv.agreementsReady = true;
    if (this.conversations.includes(conv)) {
      conv.outcome.agreements.push(...agreements);
      return;
    }
    if (!this.residents.includes(conv.a) || !this.residents.includes(conv.b)) return;
    for (const ag of agreements) this.carryOut(conv, ag);
    this.checkRefusal(conv);
  }

  /** 記録係が判定した、相手への気持ちの変化（理由つき）。会話が終わっていればすぐ反映する */
  addFeelings(conv: Conversation, feelings: { fromId: string; toId: string; delta: number; reason: string }[]): void {
    if (!conv.outcome) return;
    for (const f of feelings) {
      const ref = conv.outcome.reflections.find((r) => r.residentId === f.fromId);
      if (this.conversations.includes(conv) && ref) {
        ref.affinityDelta = f.delta;
        ref.reason = f.reason;
        continue;
      }
      const self = this.get(f.fromId);
      const other = this.get(f.toId);
      if (self && other && f.delta !== 0) this.feel(self, other, f.delta, `${this.clock.day}日目、${f.reason}`);
    }
  }

  /**
   * 飢えて食べ物を頼みに来た人が、何も受け取れずに会話が終わったら、それを事実として残す。
   * 借金を返さないときと同じく、小さな恨みになる（それをどう扱うかは本人しだい）。
   */
  private checkRefusal(conv: Conversation) {
    if (conv.refusalChecked || conv.kind !== 'ai' || !conv.purpose?.startsWith(HUNGRY_PURPOSE)) return;
    conv.refusalChecked = true;
    const asker = conv.a;
    const other = conv.b;
    if (conv.received || !this.residents.includes(asker) || !this.residents.includes(other)) return;
    const had = foodValue(other.inventory) > 0;
    const text = had
      ? `飢えて${other.profile.name}に食べ物を頼んだが、何も分けてもらえなかった（${other.profile.name}は食べ物を持っていた）`
      : `飢えて${other.profile.name}に食べ物を頼んだが、${other.profile.name}も何も持っていなかった`;
    this.remember(asker, text);
    if (had) this.feel(asker, other, -REFUSAL_GRUDGE, `${this.clock.day}日目、飢えて頼んだのに何も分けてくれなかった`);
  }

  /** AIが会話を考えられなかったときは、あいさつで済ませる */
  fallbackToGreeting(conv: Conversation): void {
    if (!this.conversations.includes(conv) || conv.lines) return;
    conv.kind = 'greeting';
    this.setDialogue(conv, greetingLines(conv.a, conv.b, this.clock.hourOfDay), null);
  }

  currentLine(conv: Conversation): DialogueLine | null {
    return conv.lines?.[conv.index] ?? null;
  }

  statusOf(r: Resident): string {
    if (r.conversation) {
      const { a, b } = r.conversation;
      const partner = a === r ? b : a;
      return `${partner.profile.name}と話している`;
    }
    const target = this.map.places[r.targetPlaceId];
    if (!target) return '…';
    if (r.placeId === null) return `${target.name}へ向かっている`;
    return `${r.activity}（${target.name}）`;
  }

  /** 朝の計画を差し替える（S2でLLMが立てた計画を反映する） */
  setPlan(r: Resident, plan: DailyPlan): void {
    r.plan = plan;
    r.override = null;
  }

  // ───────────── 神の力 ─────────────

  /** 村じゅうに知れ渡る出来事を起こす */
  announce(text: string, kind: LogEntry['kind'] = 'god'): void {
    this.news.push({ at: this.clock.minutes, day: this.clock.day, time: this.clock.formatTime(), text });
    if (this.news.length > MAX_NEWS) this.news.shift();
    this.log(text, kind);
  }

  /** 最近（既定では2日以内）の出来事 */
  recentNews(withinMinutes = 2 * 1440): News[] {
    return this.news.filter((n) => this.clock.minutes - n.at <= withinMinutes);
  }

  /** 神さまが数日続く出来事を起こす（同じ側＝畑か川の出来事は入れ替わる） */
  startCondition(kind: ConditionKind, days?: number): void {
    const def = CONDITIONS[kind];
    for (const c of this.conditions.filter((c) => CONDITIONS[c.kind].domain === def.domain)) {
      this.conditions.splice(this.conditions.indexOf(c), 1);
    }
    const len = days ?? def.minDays + Math.floor(this.weatherRng() * (def.maxDays - def.minDays + 1));
    this.conditions.push({ kind, untilDay: this.clock.day + len });
    if (kind === 'drought' && isWet(this.weather.kind)) this.weather = { kind: 'clear', until: 0 };
    this.announce(def.start);
  }

  /** 神さまが嵐を起こす（hours 時間） */
  startStorm(hours: number): void {
    this.weather = { kind: 'storm', until: this.clock.minutes + hours * 60 };
    this.announce('急に空が暗くなり、嵐がやってきた。川は荒れ、畑仕事もままならない');
  }

  startRain(hours: number): void {
    this.weather = { kind: isWet(this.weather.kind) ? this.weather.kind : 'rain', until: this.clock.minutes + hours * 60 };
    this.announce('雨が降り出した。ぶらついていた人たちは家へ急いでいる');
  }

  /** 次の from〜to 時（今日まだなら今日、過ぎていれば明日）に全員を集める */
  holdGathering(placeId: string, fromHour: number, toHour: number, activity: string): Gathering {
    const dayStart = Math.floor(this.clock.minutes / 1440) * 1440;
    let from = dayStart + fromHour * 60;
    if (from + (toHour - fromHour) * 60 <= this.clock.minutes) from += 1440;
    const gathering = { from, to: from + (toHour - fromHour) * 60, placeId, activity };
    this.gatherings.push(gathering);
    return gathering;
  }

  activeGathering(): Gathering | undefined {
    const now = this.clock.minutes;
    return this.gatherings.find((g) => now >= g.from && now < g.to);
  }

  /** 本人だけに聞こえる「天の声」 */
  whisper(r: Resident, text: string): void {
    this.remember(r, `天の声がささやいた「${text}」`);
    this.log(`${r.profile.name}に天の声がささやいた「${text}」`, 'god');
  }

  /**
   * 悪魔のささやき：本人には自分の心の声として聞こえる。
   * 2日のあいだ、計画・危機の判断・会話のときに思い浮かぶ（従うかどうかは本人しだい）
   */
  tempt(r: Resident, text: string): void {
    r.temptation = { text, until: this.clock.minutes + TEMPTATION_MINUTES };
    this.remember(r, `ふと、心の奥で声がした「${text}」`);
    this.log(`${r.profile.name}の心に悪魔がささやいた「${text}」`, 'god');
  }

  /** 今もくすぶっている心の声（なければ null） */
  temptationOf(r: Resident): string | null {
    return r.temptation && this.clock.minutes < r.temptation.until ? r.temptation.text : null;
  }

  /** どこからか聞いた噂として吹き込む */
  plantRumor(r: Resident, text: string): void {
    this.remember(r, `誰かから噂を聞いた: ${text}`);
    this.log(`${r.profile.name}の耳に噂が入った「${text}」`, 'god');
  }

  /** 空き家（住んでいる人がいない家） */
  vacantHomes(): string[] {
    return Object.values(this.map.places)
      .filter((p) => p.kind === 'home' && !this.residents.some((r) => r.profile.homeId === p.id))
      .map((p) => p.id);
  }

  /** 村の外から、何も持たない新入村民を迎える。名前を空にすると村が決める。空き家がなければ null */
  welcomeNewcomer(name = '', reason = ''): Resident | null {
    const homeId = this.vacantHomes()[0];
    if (!homeId) return null;
    const taken = [...this.residents.map((r) => r.profile.name), ...this.graves.map((g) => g.name)];
    const profile: ResidentProfile = {
      id: `n${Math.floor(this.clock.minutes)}_${Math.floor(this.rng() * 1e6).toString(36)}`,
      name: name.trim() || pickName(this.rng, taken),
      homeId,
      colors: randomPalette(this.rng),
    };
    const r = this.addNewcomer(profile, VILLAGE_ENTRANCE, NEWCOMER_MONEY, NEWCOMER_FOOD);
    if (reason) this.remember(r, reason);
    return r;
  }

  /** 新入村民を迎える。村の西の端から歩いてやってくる */
  addNewcomer(profile: ResidentProfile, entrance: Point, money: number, food: [ItemId, number][]): Resident {
    const r = this.createResident(profile, { money, food, at: entrance, indoors: false });
    this.map.places[profile.homeId].name = `${profile.name}の家`;
    this.remember(r, 'ひだまり村にやってきた。知り合いはまだいない');
    this.announce(`${profile.name}という人が村の外からやってきて、空き家に住むことになった`, 'life');
    this.makePlan(r);
    this.events.emit('residentAdded', r);
    return r;
  }

  remember(r: Resident, text: string): void {
    r.memories.push({ day: this.clock.day, time: this.clock.formatTime(), text });
    if (r.memories.length > MAX_MEMORIES) r.memories.shift();
  }

  // ───────────── 住民の生成と死 ─────────────

  private createResident(profile: ResidentProfile, opts: NewResidentOptions): Resident {
    const relations: Record<string, Relation> = {};
    for (const other of this.residents) {
      relations[other.profile.id] = defaultRelation();
      other.relations[profile.id] = defaultRelation();
    }
    const inventory: Inventory = [];
    for (const [item, qty] of opts.food) addItem(inventory, item, qty, this.clock.minutes);
    const r: Resident = {
      profile,
      x: opts.at.x,
      y: opts.at.y,
      path: [],
      state: 'idle',
      indoors: opts.indoors,
      placeId: opts.indoors ? profile.homeId : null,
      targetPlaceId: opts.indoors ? profile.homeId : '',
      activity: '',
      action: 'rest',
      idleUntil: 0,
      conversation: null,
      memories: [],
      relations,
      facing: 1,
      stride: 0,
      satiety: 80,
      health: 100,
      money: opts.money,
      inventory,
      skills: Object.fromEntries(SKILL_IDS.map((s) => [s, 0])) as Record<SkillId, number>,
      occupation: '',
      selfImage: '',
      plan: null,
      override: null,
      progress: {},
      shop: null,
      nextBuyAt: 0,
      today: emptyDayStats(),
      history: [],
      nextPlan: null,
      selfImageHistory: [],
      leaving: null,
    };
    this.residents.push(r);
    if (opts.indoors) this.map.places[profile.homeId].name = `${profile.name}の家`;
    return r;
  }

  private die(r: Resident, cause: string, announcement = `${r.profile.name}が${cause}で亡くなった`) {
    if (r.conversation) this.finishConversation(r.conversation);
    this.residents.splice(this.residents.indexOf(r), 1);
    const home = this.map.places[r.profile.homeId];
    const grave: Grave = {
      name: r.profile.name,
      colors: r.profile.colors,
      at: { x: home.spot.x - 1, y: home.spot.y },
      day: this.clock.day,
      time: this.clock.formatTime(),
      cause,
    };
    this.graves.push(grave);
    // 残したものは家に置かれたまま（誰のものでもなくなる）
    this.estates[home.id] = { ownerName: r.profile.name, money: r.money, inventory: r.inventory };
    home.name = '空き家';
    for (const o of this.residents) this.remember(o, announcement);
    this.announce(announcement, 'death');
    this.events.emit('residentDied', grave);
  }

  /** 村の入り口に着いた、出ていく住民を村から消す */
  private departVillage(r: Resident) {
    if (r.conversation) this.finishConversation(r.conversation);
    this.residents.splice(this.residents.indexOf(r), 1);
    const home = this.map.places[r.profile.homeId];
    this.estates[home.id] = { ownerName: r.profile.name, money: r.money, inventory: r.inventory };
    home.name = '空き家';
    for (const o of this.residents) this.remember(o, `${r.profile.name}が村を出て行った`);
    this.announce(`${r.profile.name}が村を出て行った（${r.leaving}）`, 'life');
    this.events.emit('residentLeft', { name: r.profile.name });
  }

  /**
   * 村の豊かさに応じて、外から人がやってくる。
   * 食べ物に余裕があり、みんなが満ち足りていて、最近死人が出ていないほど来やすい。
   */
  private tryImmigration() {
    if (this.residents.length === 0 || this.vacantHomes().length === 0) return;
    const avg = (f: (r: Resident) => number) => this.residents.reduce((n, r) => n + f(r), 0) / this.residents.length;
    const fed = avg((r) => r.satiety) / 100;
    const stocked = Math.min(1, avg((r) => foodValue(r.inventory)) / (DAILY_NEED * 2));
    const recentDeaths = this.graves.filter((g) => this.clock.day - g.day <= 3).length;
    const prosperity = Math.max(0, 0.5 * fed + 0.5 * stocked - 0.3 * recentDeaths);
    const chance = 0.02 + 0.3 * prosperity * prosperity;
    if (this.rng() >= chance) return;
    this.welcomeNewcomer('', 'この村は暮らしやすいという噂を聞いて、やってきた');
  }

  // ───────────── 時間の区切り ─────────────

  private onClockTick() {
    const hour = Math.floor(this.clock.minutes / 60);
    if (hour === this.lastHour) return;
    this.lastHour = hour;
    this.events.emit('hourly', { day: this.clock.day, hour: hour % 24 });
    this.settleDeliveries();
    this.discoverThefts();
    this.advanceAssemblies();
    this.updateWeather();
    for (const r of this.residents) {
      const spoiled = removeSpoiled(r.inventory, this.clock.minutes);
      for (const [id, n] of Object.entries(spoiled)) addCount(r.today.spoiled, id as ItemId, n ?? 0);
    }
    if (this.clock.day !== this.lastDay) {
      this.lastDay = this.clock.day;
      this.endOfDay();
    }
    const h = this.clock.hourOfDay;
    if (h >= WAKE_AT && h < WAKE_AT + 1) {
      for (const r of [...this.residents]) if (r.plan?.day !== this.clock.day) this.makePlan(r);
    }
    if (h >= WEATHER_HOUR && h < WEATHER_HOUR + 1) this.startDayWeather();
    if (h >= IMMIGRATION_HOUR && h < IMMIGRATION_HOUR + 1) this.tryImmigration();
    if (h >= PLANNING_HOUR && this.lastEveningDay !== this.clock.day) {
      this.lastEveningDay = this.clock.day;
      this.makeForecast();
      this.events.emit('evening', { day: this.clock.day });
    }
  }

  /** 1日の終わり：出来高を要約して記憶とログに残し、使わなかった技能を衰えさせる */
  private endOfDay() {
    const day = this.clock.day - 1;
    for (const r of this.residents) this.updateSatisfaction(r, day);
    // 飢えた人は、そのとき食べ物を余らせていた人を覚えている（恨むかどうかは本人しだい）
    for (const r of this.residents) {
      if (r.satiety > 0) continue;
      // 自分の目で見た範囲で（今日会ったときに、たくさん持っていた人）
      const rich = this.residents.filter((o) => {
        const s = r.seen?.[o.profile.id];
        return o !== r && s && s.day === day && s.foodValue >= DAILY_NEED * 1.5;
      });
      if (rich.length > 0) {
        const names = rich.map((o) => `${o.profile.name}（${r.seen![o.profile.id].time}に会ったとき${r.seen![o.profile.id].food}を持っていた）`);
        this.remember(r, `${day}日目、自分は飢えていたのに、食べ物をたくさん持っている人がいた：${names.join('、')}`);
      }
    }
    for (const r of this.residents) {
      const summary = summarizeDay(r.today);
      r.history.push({
        day,
        summary,
        hours: r.today.hours,
        earned: r.today.earned,
        spent: r.today.spent,
        starved: r.satiety <= 0,
      });
      if (r.history.length > MAX_HISTORY_DAYS) r.history.shift();
      this.remember(r, `${day}日目のふりかえり: ${summary}`);
      this.log(`${r.profile.name}の${day}日目：${summary}（所持金${r.money}G・持ち物 ${describeInventory(r.inventory)}）`, 'day');
      for (const s of SKILL_IDS) {
        if (!usedSkill(r.today, s)) r.skills[s] = Math.max(0, r.skills[s] - SKILL_DECAY_PER_DAY);
      }
      r.today = emptyDayStats();
    }
    this.market = { today: emptyMarketDay(), yesterday: this.market.today };
    this.settleEmployments(day);
    this.checkDebts(day);
  }

  /** 日の終わりに日給を払う。払えなければ雇われた側の恨みになる */
  private settleEmployments(day: number) {
    for (const emp of [...this.employments]) {
      const employer = this.get(emp.employerId);
      const employee = this.get(emp.employeeId);
      if (!employer || !employee) {
        this.employments.splice(this.employments.indexOf(emp), 1);
        continue;
      }
      if (day >= emp.startDay) {
        const due = emp.workedToday < 30 ? 0 : Math.round(emp.wage * Math.min(1, emp.workedToday / 360));
        const paid = Math.min(due, employer.money);
        employer.money -= paid;
        employee.money += paid;
        employer.today.spent += paid;
        employee.today.earned += paid;
        if (emp.workedToday < 30) {
          this.feel(employer, employee, -5, `${day}日目、雇っているのに働きに来なかった`);
        } else if (paid < due) {
          this.feel(employee, employer, -10, `${day}日目、給料を${due}Gのうち${paid}Gしか払ってもらえなかった`);
          this.remember(employee, `${employer.profile.name}から給料を${due - paid}G払ってもらえなかった`);
          this.log(`${employer.profile.name}は${employee.profile.name}に給料を${due}Gのうち${paid}Gしか払えなかった`, 'deal');
        } else if (paid > 0) {
          this.feel(employee, employer, 2, `${day}日目、給料${paid}Gをきちんと払ってくれた`);
          this.log(`${employer.profile.name}が${employee.profile.name}に給料${paid}Gを払った`, 'deal');
        }
      }
      emp.workedToday = 0;
      if (day >= emp.untilDay) {
        this.employments.splice(this.employments.indexOf(emp), 1);
        this.log(`${employee.profile.name}が${employer.profile.name}のもとで働く期間が終わった`, 'deal');
        this.remember(employee, `${employer.profile.name}に雇われる期間が終わった`);
        this.remember(employer, `${employee.profile.name}を雇う期間が終わった`);
      }
    }
  }

  /** 納品待ちの売買：品物がそろったら受け渡し、期限を過ぎたら買い手の恨みになる */
  private settleDeliveries() {
    for (const d of [...this.deliveries]) {
      const seller = this.get(d.sellerId);
      const buyer = this.get(d.buyerId);
      const drop = () => this.deliveries.splice(this.deliveries.indexOf(d), 1);
      if (!seller || !buyer) {
        drop();
        continue;
      }
      const name = ITEMS[d.item].name;
      if (countItem(seller.inventory, d.item) >= d.qty && buyer.money >= d.money) {
        moveItems(seller.inventory, buyer.inventory, d.item, d.qty, this.clock.minutes);
        buyer.money -= d.money;
        seller.money += d.money;
        buyer.today.spent += d.money;
        seller.today.earned += d.money;
        addCount(seller.today.sold, d.item, d.qty);
        addCount(buyer.today.bought, d.item, d.qty);
        drop();
        this.log(`${seller.profile.name}が約束どおり${buyer.profile.name}に${name}${d.qty}個を渡した（${d.money}G）`, 'deal');
        this.feel(buyer, seller, 3, `${this.clock.day}日目、約束どおり${name}を届けてくれた`);
      } else if (this.clock.day > d.dueDay) {
        drop();
        this.log(`${seller.profile.name}は${buyer.profile.name}に${name}${d.qty}個を渡す約束を守れなかった`, 'deal');
        this.feel(buyer, seller, -6, `${this.clock.day}日目、${name}を渡すと約束したのに守らなかった`);
        this.remember(buyer, `${seller.profile.name}が${name}${d.qty}個を渡すと約束したのに、期限までに渡さなかった`);
        this.remember(seller, `${buyer.profile.name}に${name}${d.qty}個を渡す約束を守れなかった`);
      }
    }
  }

  /** 返済期限を過ぎた借金は、貸した側の恨みになる（数日おきに思い出す） */
  private checkDebts(day: number) {
    for (const d of this.debts) {
      if (d.remaining <= 0 || day < d.dueDay) continue;
      if (d.lastComplainedDay !== undefined && day - d.lastComplainedDay < 2) continue;
      const lender = this.get(d.lenderId);
      const borrower = this.get(d.borrowerId);
      if (!lender || !borrower) continue;
      d.lastComplainedDay = day;
      this.feel(lender, borrower, -6, `${day}日目、貸した${d.remaining}Gを期限を過ぎても返さない`);
      this.remember(lender, `${borrower.profile.name}が借りた${d.remaining}Gを返さない（期限は${d.dueDay}日目）`);
      this.remember(borrower, `${lender.profile.name}への借金${d.remaining}Gの返済期限（${d.dueDay}日目）を過ぎている`);
    }
  }

  /** 朝、その日の計画を決める。前の晩にAIが立てた計画があればそれを、なければルールで立てる */
  private makePlan(r: Resident) {
    const fromNight = r.nextPlan?.day === this.clock.day ? r.nextPlan : null;
    r.nextPlan = null;
    const plan =
      fromNight ??
      rulePlan({
        day: this.clock.day,
        inventory: r.inventory,
        money: r.money,
        skills: r.skills,
        rng: this.rng,
        employedAs: this.employmentOf(r)?.action,
      });
    r.plan = plan;
    r.override = null;
    if (plan.occupation !== undefined && plan.occupation !== r.occupation) {
      const before = r.occupation;
      r.occupation = plan.occupation;
      const text = !plan.occupation
        ? `${r.profile.name}は「${before}」をやめた`
        : before
          ? `${r.profile.name}は「${before}」をやめて、「${plan.occupation}」を名乗ることにした`
          : `${r.profile.name}は今日から「${plan.occupation}」を名乗ることにした`;
      this.announce(text, 'life');
    }
    if (plan.source === 'ai') {
      this.log(`${r.profile.name}の今日の目標：${plan.goal}`, 'plan', { speakerId: r.profile.id });
    }
    if (plan.leave) {
      r.leaving = plan.leave;
      this.remember(r, `村を出ることにした（${plan.leave}）`);
      this.log(`${r.profile.name}は村を出る決心をした：${plan.leave}`, 'life');
    }
    this.events.emit('planMade', r);
  }

  /** 危機の判断などで、一時的な行動を割り込ませる */
  setOverride(r: Resident, override: Omit<Override, 'until'> & { minutes: number }): void {
    if (!this.residents.includes(r)) return;
    const { minutes, ...rest } = override;
    r.override = { ...rest, until: this.clock.minutes + minutes };
    r.crisisRequestedAt = undefined;
  }

  employmentOf(r: Resident): Employment | undefined {
    return this.employments.find((e) => e.employeeId === r.profile.id);
  }

  /** a が b に負っている借金の残り */
  owed(borrower: Resident, lender: Resident): number {
    return this.debts
      .filter((d) => d.borrowerId === borrower.profile.id && d.lenderId === lender.profile.id)
      .reduce((n, d) => n + d.remaining, 0);
  }

  /** 相手への気持ちを、理由つきで動かす */
  feel(self: Resident, other: Resident, delta: number, reason: string): void {
    const rel = (self.relations[other.profile.id] ??= defaultRelation());
    rel.affinity = Math.max(-100, Math.min(100, rel.affinity + delta));
    rel.notes = [{ day: this.clock.day, text: reason, delta }, ...(rel.notes ?? [])].slice(0, 6);
  }

  /** 夜のうちに立てた翌日の計画を受け取る */
  setNextPlan(r: Resident, plan: DailyPlan): void {
    if (this.residents.includes(r)) r.nextPlan = plan;
  }

  /** 望みを更新する */
  setWish(r: Resident, text: string): void {
    if (!this.residents.includes(r) || !text || text === r.wish) return;
    r.wish = text;
    (r.wishHistory ??= []).push({ day: this.clock.day, text });
    if (r.wishHistory.length > 10) r.wishHistory.shift();
    this.log(`${r.profile.name}の望み：「${text}」`, 'plan', { speakerId: r.profile.id });
  }

  /** 自己像を更新する */
  setSelfImage(r: Resident, text: string): void {
    if (!this.residents.includes(r) || !text || text === r.selfImage) return;
    r.selfImage = text;
    r.selfImageHistory.push({ day: this.clock.day, text });
    if (r.selfImageHistory.length > 10) r.selfImageHistory.shift();
    this.log(`${r.profile.name}の自己像：「${text}」`, 'plan', { speakerId: r.profile.id });
  }

  private updateWeather() {
    if (this.weather.until > 0 && this.clock.minutes >= this.weather.until) {
      this.weather = { kind: this.dayWeather, until: 0 };
      if (!isWet(this.dayWeather)) this.announce('雨が上がった');
    }
  }

  /** 朝5時：今日の空模様と、数日続く出来事を決める */
  private startDayWeather() {
    const day = this.clock.day;
    for (const c of this.conditions.filter((c) => c.untilDay <= day)) {
      this.conditions.splice(this.conditions.indexOf(c), 1);
      this.announce(CONDITIONS[c.kind].end, 'system');
    }
    const fresh = rollCondition(this.weatherRng, this.conditions, day);
    if (fresh) {
      this.conditions.push(fresh);
      this.announce(CONDITIONS[fresh.kind].start, 'system');
    }
    this.dayWeather = this.weatherRng() < FORECAST_ACCURACY ? this.forecast : rollWeather(this.weatherRng, this.conditions);
    if (this.dayWeather === 'storm' && this.conditions.some((c) => c.kind === 'drought')) this.dayWeather = 'clear';
    if (this.weather.until <= this.clock.minutes) this.weather = { kind: this.dayWeather, until: 0 };
    if (this.dayWeather === 'storm') this.announce('嵐がやってきた。川は荒れ、畑仕事もままならない', 'system');
    else if (this.dayWeather === 'rain') this.announce('朝から雨が降っている', 'system');
  }

  /** 夜：明日の空模様の見立て（外れることもある） */
  private makeForecast() {
    this.forecast = rollWeather(this.weatherRng, this.conditions);
  }

  /** 今の空模様と出来事による、畑仕事・釣りの倍率 */
  productionFactor(domain: 'farm' | 'fish'): number {
    return productionFactor(this.weather.kind, this.conditions, domain);
  }

  /** 計画づくり用：明日の見立てでの倍率 */
  forecastFactor(domain: 'farm' | 'fish'): number {
    return productionFactor(this.forecast, this.conditions, domain);
  }

  /** 村人が知っている空模様と出来事（プロンプト用） */
  describeWeather(which: 'now' | 'tomorrow'): string {
    const kind = which === 'now' ? this.weather.kind : this.forecast;
    const sky = which === 'now' ? `今の空: ${WEATHER[kind].name}` : `明日の空模様の見立て: ${WEATHER[kind].name}になりそう（外れることもある）`;
    const note = WEATHER[kind].note ? `。${WEATHER[kind].note}` : '';
    const cond = this.conditions.map((c) => `${CONDITIONS[c.kind].name}（${CONDITIONS[c.kind].start}）`).join('、');
    return `${sky}${note}${cond ? `。続いていること: ${cond}` : ''}`;
  }

  // ───────────── 1分ごとの住民の更新 ─────────────

  private updateResident(r: Resident, dt: number) {
    this.updateBody(r, dt);
    if (!this.residents.includes(r)) return;
    // 話している間は立ち止まる。ただし拘束は村の時間で決まった分だけで、
    // セリフの表示が続いていても、それを過ぎたら自分の用事に戻る
    if (r.conversation && this.clock.minutes < r.conversation.engagedUntil) return;
    if (r.state === 'talking') r.state = r.path.length > 0 ? 'walking' : 'idle';

    this.handleHunger(r);
    const task = this.currentTask(r);
    r.activity = task.label;
    this.trackBegging(r, task);
    if (task.placeId !== r.targetPlaceId) {
      this.closeShop(r);
      r.action = task.action;
      this.departFor(r, task.placeId);
    }
    if (r.placeId !== null && r.action !== task.action) {
      if (r.action === 'sell') this.closeShop(r);
      r.action = task.action;
    }

    if (r.state === 'walking') this.walk(r, dt);
    else if (r.placeId === task.placeId) {
      if (task.action !== 'sleep' && task.action !== 'gather' && task.action !== 'arrive') {
        r.today.hours[task.action] = (r.today.hours[task.action] ?? 0) + dt / 60;
      }
      this.perform(r, task, dt);
      if (r.state === 'idle' && !r.indoors && this.clock.minutes >= r.idleUntil && !isStationary(task.action)) {
        this.wander(r);
      }
    }
  }

  /** 施しを求めた結果を、やめたときに記憶に残す（何ももらえなかったことも事実として覚える） */
  private trackBegging(r: Resident, task: Task) {
    const now = this.clock.minutes;
    if (task.action === 'beg') {
      r.begging ??= { since: now, food: foodValue(r.inventory), money: r.money };
      return;
    }
    if (!r.begging) return;
    const { since, food, money } = r.begging;
    r.begging = undefined;
    const minutes = now - since;
    if (minutes < 30) return;
    const got = foodValue(r.inventory) > food || r.money > money;
    const hours = Math.max(1, Math.round(minutes / 60));
    this.remember(r, got ? `広場で${hours}時間ほど施しを求め、少し分けてもらえた` : `広場で${hours}時間ほど施しを求めたが、誰も何も分けてくれなかった`);
  }

  /** 満腹度・体力・食事・死 */
  private updateBody(r: Resident, dt: number) {
    const asleep = r.action === 'sleep' && r.indoors;
    const before = r.satiety;
    r.satiety = Math.max(0, r.satiety - (asleep ? SATIETY_LOSS_ASLEEP : SATIETY_LOSS_AWAKE) * dt);
    if (r.satiety <= 0) r.health -= STARVING_HEALTH_LOSS * dt;
    else if (r.satiety >= 50) r.health = Math.min(100, r.health + HEALTH_RECOVERY * dt);

    if (!asleep) {
      this.maybeEat(r);
      this.maybeDrink(r);
    }

    if (before >= HUNGRY_BELOW && r.satiety < HUNGRY_BELOW) {
      this.log(`${r.profile.name}はお腹を空かせている（食べ物 ${describeInventory(r.inventory)}、所持金${r.money}G）`, 'life');
    }
    if (before > 0 && r.satiety <= 0) {
      this.log(`${r.profile.name}は食べる物がなく、飢え始めた`, 'life');
      this.remember(r, '食べる物がなく、飢え始めた');
    }
    if (r.health <= 0) this.die(r, '飢え');
  }

  /**
   * 暮らしの満足を1日の終わりに見直す。生き延びることとは別の「欲」の材料になる。
   * 数値よりも理由（飽きた・寂しい・羨ましい）を本人に見せる
   */
  private updateSatisfaction(r: Resident, day: number) {
    const notes: { text: string; delta: number }[] = [];
    const t = r.today;
    const ateKinds = ITEM_IDS.filter((id) => (t.ate[id] ?? 0) > 0);
    if (r.satiety <= 0 || ateKinds.length === 0) notes.push({ text: 'ろくに食べられていない', delta: -20 });
    else if (ateKinds.length >= 3) notes.push({ text: 'いろいろな物を食べられた', delta: 6 });
    else if (ateKinds.length === 1 && (t.ate[ateKinds[0]] ?? 0) >= 2) notes.push({ text: `${ITEMS[ateKinds[0]].name}ばかりで飽きた`, delta: -6 });
    if ((t.ate.meal ?? 0) > 0) notes.push({ text: '定食を味わえた', delta: 5 });
    if ((t.drank ?? 0) > 0) notes.push({ text: 'お酒を飲んでくつろいだ', delta: 0 });
    if ((t.talks ?? 0) === 0) notes.push({ text: '誰ともちゃんと話していない', delta: -8 });
    else if ((t.talks ?? 0) >= 3) notes.push({ text: '人とたくさん話した', delta: 4 });
    // 家は誰からも見えるので、比べてしまう
    const mine = r.homeLevel ?? 0;
    const best = this.residents.filter((o) => o !== r).sort((a, b) => (b.homeLevel ?? 0) - (a.homeLevel ?? 0))[0];
    const bestLevel = best?.homeLevel ?? 0;
    if (best && bestLevel > mine) {
      notes.push({ text: `${best.profile.name}の家（${HOME_LEVEL_NAMES[bestLevel]}）のほうが立派で羨ましい`, delta: -5 * (bestLevel - mine) });
    } else if (mine > 0 && mine > bestLevel) {
      notes.push({ text: '自分の家が村でいちばん立派だ', delta: 8 });
    } else if (mine > 0) {
      notes.push({ text: `${HOME_LEVEL_NAMES[mine]}に住んでいる`, delta: 3 });
    }
    // ふだんは真ん中へ戻っていき、その日のことで上下する
    const before = r.satisfaction ?? 50;
    const after = Math.max(0, Math.min(100, Math.round(before * 0.7 + 50 * 0.3 + notes.reduce((n, x) => n + x.delta, 0))));
    r.satisfaction = after;
    r.satisfactionNotes = notes.filter((n) => n.delta !== 0 || n.text.includes('お酒')).map((n) => n.text).slice(0, 4);
    if (after < 30 && r.satisfactionNotes.length) this.remember(r, `${day}日目、暮らしに満足できなかった（${r.satisfactionNotes.join('・')}）`);
  }

  /** 夕方以降、家でお酒があれば1日1杯だけ飲む（満腹にはならないが、気分がよくなる） */
  private maybeDrink(r: Resident) {
    const h = this.clock.hourOfDay;
    if (h < 19 || (r.today.drank ?? 0) >= 1 || r.placeId !== r.profile.homeId) return;
    if (countItem(r.inventory, 'drink') < 1) return;
    takeItem(r.inventory, 'drink', 1);
    r.today.drank = (r.today.drank ?? 0) + 1;
    r.satisfaction = Math.min(100, (r.satisfaction ?? 50) + DRINK_JOY);
  }

  /** 家を改築する：木材を少しずつ使い、決まった量を使い切ると家が1段立派になる */
  private buildHome(r: Resident, task: Task, dt: number) {
    const level = r.homeLevel ?? 0;
    if (level >= MAX_HOME_LEVEL) return;
    const key = 'build_wood';
    if ((r.progress[key] ?? 0) === 0 && countItem(r.inventory, 'wood') < 1) {
      this.log(`${r.profile.name}は木材がなく、家の改築ができなかった`, 'life');
      r.override = { action: 'wander', until: blockEnd(this.clock.minutes, task.block) };
      return;
    }
    const f = this.work(r, 'build', dt);
    r.progress[key] = (r.progress[key] ?? 0) + (dt * f) / BUILD_MINUTES_PER_WOOD;
    if (r.progress[key]! < 1) return;
    r.progress[key] = 0;
    takeItem(r.inventory, 'wood', 1);
    r.progress.build_used = (r.progress.build_used ?? 0) + 1;
    if (r.progress.build_used! < HOME_UPGRADE_WOOD[level]) return;
    r.progress.build_used = 0;
    r.homeLevel = level + 1;
    const text = `${r.profile.name}が家を改築した（${HOME_LEVEL_NAMES[r.homeLevel]}）`;
    this.announce(text, 'life');
    this.remember(r, `家を改築して、${HOME_LEVEL_NAMES[r.homeLevel]}にした`);
    r.satisfaction = Math.min(100, (r.satisfaction ?? 50) + 10 * r.homeLevel);
    // 立派な家は誰の目にも入る。村の人は持ち主に一目置くようになる
    for (const o of this.residents) {
      if (o === r) continue;
      this.feel(o, r, HOME_RESPECT * r.homeLevel, `${this.clock.day}日目、${r.profile.name}が家を${HOME_LEVEL_NAMES[r.homeLevel]}に改築したのを見て、一目置いた`);
    }
  }

  private maybeEat(r: Resident) {
    const h = this.clock.hourOfDay;
    const mealTime = (h >= 6.5 && h < 8) || (h >= 12 && h < 13.5) || (h >= 18.5 && h < 20.5);
    if (!(r.satiety < 35 || (mealTime && r.satiety < 65))) return;
    const item = nextToEat(r.inventory);
    if (!item || r.satiety + ITEMS[item].satiety > 110) return;
    takeItem(r.inventory, item, 1);
    r.satiety = Math.min(100, r.satiety + ITEMS[item].satiety);
    addCount(r.today.ate, item, 1);
  }

  /**
   * 空腹なのに食べる物がないときの、とっさの行動（S3ではLLMの「危機の判断」に置き換える）。
   * 小麦があれば焼く、売っている人がいれば買う、どちらもだめなら自分で採りに行く。
   */
  private handleHunger(r: Resident) {
    const now = this.clock.minutes;
    const h = this.clock.hourOfDay;
    if (r.override || r.satiety >= HUNGRY_BELOW || nextToEat(r.inventory) || h >= SLEEP_FROM || h < WAKE_AT) return;
    // まずAIに「どうするか」を考えてもらう。1時間たっても返事がなければルールで動く
    if (r.crisisRequestedAt !== undefined && now - r.crisisRequestedAt < 60) return;
    if (r.crisisRequestedAt === undefined && r.satiety < 20 && this.crisisHandler?.(r)) {
      r.crisisRequestedAt = now;
      return;
    }
    r.crisisRequestedAt = undefined;
    const free = (action: ActionId) => {
      const place = this.map.places[ACTIONS[action].place];
      return !place.capacity || this.occupants(place, r) < place.capacity;
    };
    const foodOnSale = this.residents.some(
      (s) => s !== r && s.shop && ITEM_IDS.some((id) => isFood(id) && this.sellable(s, id) > 0),
    );
    let action: ActionId;
    if (countItem(r.inventory, 'wheat') >= 1 && free('bake')) action = 'bake';
    else if (foodOnSale && r.money >= 5) action = 'buy';
    else action = (['fish', 'farm'] as const).find(free) ?? 'fish';
    r.override = { action, until: now + (action === 'buy' ? 45 : 90) };
    this.log(`${r.profile.name}は空腹に耐えかねて、${ACTIONS[action].label}をしに行った`, 'life');
  }

  /** 今いるべき場所とやること */
  private currentTask(r: Resident): Task {
    const home = r.profile.homeId;
    if (r.leaving) return { placeId: 'gate', action: 'rest', label: '村を出ていく' };
    const gathering = this.activeGathering();
    if (gathering) return { placeId: gathering.placeId, action: 'gather', label: gathering.activity };
    const h = this.clock.hourOfDay;
    if (h >= SLEEP_FROM || h < WAKE_AT) return { placeId: home, action: 'sleep', label: SLEEP_ACTIVITY };

    const now = this.clock.minutes;
    const block = r.plan?.blocks.find((b) => h >= b.from && h < b.to);
    let action: ActionId = block?.action ?? 'rest';
    let target = block?.target;
    let purpose = block?.purpose;
    if (r.override && now < r.override.until) {
      ({ action, target, purpose } = r.override);
    } else r.override = null;

    if (TARGETED_ACTIONS.includes(action)) {
      const t = target ? this.get(target) : undefined;
      const done = r.visited && r.visited.targetId === target && now < r.visited.until;
      if (t && !done) {
        const placeId = t.placeId ?? (t.targetPlaceId || 'plaza');
        // 盗みに行く人は、はた目にはぶらついているだけに見える
        const label =
          action === 'steal' ? 'ぶらぶらする' : action === 'visit' ? `${t.profile.name}に会いに行く` : `${t.profile.name}のところへ行く`;
        return { placeId, action, label, block, target, purpose };
      }
      action = 'wander';
    }
    if (action === 'accuse' || action === 'call_assembly') {
      const done = r.visited && r.visited.targetId === action && now < r.visited.until;
      if (!purpose || done) action = 'wander';
      else return { placeId: 'plaza', action, label: action === 'accuse' ? '広場で話して回る' : '集会を呼びかけて回る', block, target, purpose };
    }
    if (action === 'work_for') {
      const emp = this.employmentOf(r);
      const employer = emp && this.get(emp.employerId);
      if (emp && employer) {
        return {
          placeId: ACTIONS[emp.action].place,
          action,
          label: `${employer.profile.name}に雇われて${ACTIONS[emp.action].label}`,
          block,
        };
      }
      action = 'wander';
    }
    if (isWet(this.weather.kind) && (action === 'wander' || action === 'beg')) {
      return { placeId: home, action: 'rest', label: '雨宿り', block };
    }
    const def = ACTIONS[action];
    const placeId = def.place === 'home' ? home : def.place;
    return { placeId, action, label: block ? def.label : '家でくつろぐ', block };
  }

  /** その場所で計画の行動をする */
  private perform(r: Resident, task: Task, dt: number) {
    const now = this.clock.minutes;
    switch (task.action) {
      case 'farm':
      case 'fish':
      case 'bake':
      case 'cook':
      case 'chop':
      case 'brew':
        this.doWork(r, r, task.action, task, dt);
        break;
      case 'build':
        this.buildHome(r, task, dt);
        break;
      case 'work_for': {
        const emp = this.employmentOf(r);
        const employer = emp && this.get(emp.employerId);
        if (emp && employer) {
          emp.workedToday += dt;
          this.doWork(r, employer, emp.action, task, dt);
        }
        break;
      }
      case 'visit':
      case 'steal':
      case 'rob':
      case 'attack':
      case 'kill':
        this.approach(r, task);
        break;
      case 'accuse':
        this.accuse(r, task);
        break;
      case 'call_assembly':
        this.callAssembly(r, task);
        break;
      case 'sell':
        if (!r.shop) this.openShop(r, task.block);
        break;
      case 'buy':
        if (now >= r.nextBuyAt) {
          r.nextBuyAt = now + BUY_INTERVAL;
          this.tryBuy(r);
        }
        break;
      default:
        break;
    }
  }

  /** 仕事をする。owner が自分以外なら雇われ仕事で、材料は雇い主のものを使い、出来たものも雇い主のものになる */
  private doWork(worker: Resident, owner: Resident, action: WorkAction, task: Task, dt: number) {
    switch (action) {
      case 'farm': {
        const f = this.work(worker, 'farm', dt);
        const w = this.productionFactor('farm');
        this.accumulate(worker, owner, 'wheat', FARM_PER_HOUR.wheat * f * w * (dt / 60));
        this.accumulate(worker, owner, 'vegetable', FARM_PER_HOUR.vegetable * f * w * (dt / 60));
        break;
      }
      case 'fish': {
        const f = this.work(worker, 'fish', dt);
        if (this.rng() < FISH_PER_HOUR * f * this.productionFactor('fish') * (dt / 60)) this.produce(owner, 'fish', 1);
        break;
      }
      case 'bake':
        this.craft(worker, owner, task, 'bake', BAKE_INPUT, dt, (f) => {
          this.produce(owner, 'bread', 1 + (this.rng() < f - 0.5 ? 1 : 0));
        });
        break;
      case 'cook':
        this.craft(worker, owner, task, 'cook', COOK_INPUT, dt, (f) => {
          if (this.rng() < Math.min(1, 0.3 + 0.5 * f)) this.produce(owner, 'meal', 1);
        });
        break;
      case 'chop': {
        const f = this.work(worker, 'chop', dt);
        this.accumulate(worker, owner, 'wood', WOOD_PER_HOUR * f * (dt / 60));
        break;
      }
      case 'brew':
        this.craft(worker, owner, task, 'cook', BREW_INPUT, dt, () => this.produce(owner, 'drink', 1));
        break;
    }
  }

  /** 会いに行った相手に近づき、話せる状態なら話しかける */
  private approach(r: Resident, task: Task) {
    const t = task.target ? this.get(task.target) : undefined;
    if (!t || r.conversation) return;
    if (t.placeId !== r.placeId) return;
    const close = r.indoors || Math.hypot(r.x - t.x, r.y - t.y) <= 1.5;
    if (!close) {
      if (r.state !== 'walking') this.setPath(r, { x: Math.round(t.x), y: Math.round(t.y) });
      return;
    }
    if (task.action !== 'visit') {
      r.visited = { targetId: t.profile.id, until: this.taskEnd(r, task) };
      this.commit(r, t, task.action as CrimeAction);
      return;
    }
    if (t.conversation || t.action === 'sleep') return;
    r.visited = { targetId: t.profile.id, until: this.taskEnd(r, task) };
    this.startConversation(r, t, this.map.places[r.placeId!]?.name ?? '道ばた', r.indoors, task.purpose || '用があって会いに来た');
  }

  /** 働いた分だけ上達し、その時点の熟練係数を返す */
  private work(r: Resident, skill: SkillId, dt: number): number {
    r.skills[skill] = practice(r.skills[skill], dt);
    // 満ち足りていると仕事がはかどり、不満だとやる気が出ない
    return skillFactor(r.skills[skill]) * moodFactor(r.satisfaction ?? 50);
  }

  /** 端数は働いた本人が持ち、1個になったら持ち主のものになる */
  private accumulate(worker: Resident, owner: Resident, item: ItemId, amount: number) {
    const total = (worker.progress[item] ?? 0) + amount;
    const whole = Math.floor(total);
    worker.progress[item] = total - whole;
    if (whole > 0) this.produce(owner, item, whole);
  }

  private produce(r: Resident, item: ItemId, qty: number) {
    addItem(r.inventory, item, qty, this.clock.minutes);
    addCount(r.today.produced, item, qty);
  }

  private craft(
    worker: Resident,
    owner: Resident,
    task: Task,
    skill: SkillId,
    inputs: Partial<Record<ItemId, number>>,
    dt: number,
    output: (factor: number) => void,
  ) {
    const key = `craft_${skill}_${Object.keys(inputs).join('_')}`;
    if ((worker.progress[key] ?? 0) === 0 && !hasInputs(owner.inventory, inputs)) {
      // 材料がない：その時間は市場をぶらつく
      const missing = Object.keys(inputs).map((id) => ITEMS[id as ItemId].name).join('と');
      const whose = owner === worker ? '' : `${owner.profile.name}の`;
      this.log(`${worker.profile.name}は${whose}${missing}が足りず、${SKILLS[skill]}ができなかった`, 'life');
      worker.override = { action: 'wander', until: blockEnd(this.clock.minutes, task.block) };
      return;
    }
    const f = this.work(worker, skill, dt);
    worker.progress[key] = (worker.progress[key] ?? 0) + dt / CRAFT_MINUTES;
    if (worker.progress[key]! < 1) return;
    worker.progress[key] = 0;
    for (const [id, n] of Object.entries(inputs)) takeItem(owner.inventory, id as ItemId, n ?? 0);
    output(f);
  }

  // ───────────── 市場 ─────────────

  private openShop(r: Resident, block?: PlanBlock) {
    const prices: Partial<Record<ItemId, number>> = {};
    for (const id of ITEM_IDS) {
      // 値段が書かれていなければ、最近の相場、それもなければ代わりの値段
      const recent = this.market.today.sold[id] ?? this.market.yesterday.sold[id];
      const fallback = recent ? recent.revenue / recent.qty : ITEMS[id].fallbackPrice;
      prices[id] = Math.max(1, Math.round(block?.prices?.[id] ?? fallback));
    }
    r.shop = { prices };
  }

  private closeShop(r: Resident) {
    if (!r.shop) return;
    for (const id of ITEM_IDS) {
      const left = this.sellable(r, id);
      if (left > 0) this.market.today.leftover[id] = (this.market.today.leftover[id] ?? 0) + left;
    }
    r.shop = null;
  }

  /** 売り手が今売ってもよい数（自分の食べる分は残す） */
  sellable(r: Resident, item: ItemId): number {
    const have = countItem(r.inventory, item);
    if (item === 'wheat') return Math.max(0, have - KEEP_WHEAT);
    if (!isFood(item)) return have;
    const spare = foodValue(r.inventory) - KEEP_FOOD;
    return Math.max(0, Math.min(have, Math.floor(spare / ITEMS[item].satiety)));
  }

  private tryBuy(buyer: Resident) {
    const sellers = this.residents.filter((s) => s !== buyer && s.shop && s.placeId === buyer.placeId);
    // 市場の店先に並んだものは、買いに来た人の目に入る
    for (const s of sellers) this.observe(buyer, s);
    const bought = new Map<Resident, { item: ItemId; qty: number; paid: number }[]>();
    const record = (seller: Resident, item: ItemId, price: number) => {
      const taken = takeItem(seller.inventory, item, 1);
      for (const s of taken) addItem(buyer.inventory, s.item, s.qty, this.clock.minutes, s.expiresAt);
      buyer.money -= price;
      seller.money += price;
      buyer.today.spent += price;
      seller.today.earned += price;
      addCount(buyer.today.bought, item, 1);
      addCount(seller.today.sold, item, 1);
      const m = (this.market.today.sold[item] ??= { qty: 0, revenue: 0 });
      m.qty++;
      m.revenue += price;
      const list = bought.get(seller) ?? [];
      const same = list.find((x) => x.item === item);
      if (same) {
        same.qty++;
        same.paid += price;
      } else list.push({ item, qty: 1, paid: price });
      bought.set(seller, list);
    };

    // このあとパンを焼く予定なら、小麦も買う
    const h = this.clock.hourOfDay;
    const willBake = buyer.plan?.blocks.some((b) => b.action === 'bake' && b.from >= h);
    while (willBake && countItem(buyer.inventory, 'wheat') < WHEAT_TO_BUY) {
      const offers = sellers
        .filter((s) => this.sellable(s, 'wheat') > 0)
        .map((s) => ({ s, price: s.shop!.prices.wheat ?? ITEMS.wheat.fallbackPrice }))
        .filter((o) => o.price <= Math.min(buyer.money, willingToPay(buyer, 'wheat')))
        .sort((a, b) => a.price - b.price);
      if (offers.length === 0) break;
      record(offers[0].s, 'wheat', offers[0].price);
    }

    let tooExpensive: { seller: Resident; item: ItemId; price: number } | null = null;
    while (foodValue(buyer.inventory) < BUY_UNTIL) {
      // 出してもいい値段の範囲で、値段あたりの満腹度がいちばん高いものを選ぶ
      let best: { seller: Resident; item: ItemId; price: number; value: number } | null = null;
      for (const seller of sellers) {
        for (const item of ITEM_IDS) {
          if (!isFood(item) || this.sellable(seller, item) <= 0) continue;
          const price = seller.shop!.prices[item] ?? ITEMS[item].fallbackPrice;
          const value = ITEMS[item].satiety / price;
          if (price > buyer.money || price > willingToPay(buyer, item)) {
            if (!tooExpensive || price < tooExpensive.price) tooExpensive = { seller, item, price };
            continue;
          }
          if (!best || value > best.value) best = { seller, item, price, value };
        }
      }
      if (!best) break;
      record(best.seller, best.item, best.price);
    }
    // 欲しかったのに高くて手が出なかった（不満の種として覚えておく）
    if (tooExpensive && !bought.size && buyer.lastPriceComplaintDay !== this.clock.day) {
      buyer.lastPriceComplaintDay = this.clock.day;
      const { seller, item, price } = tooExpensive;
      const what = `${seller.profile.name}の${ITEMS[item].name}（${price}G）`;
      const why = price > buyer.money ? 'お金が足りず買えなかった' : '高すぎて買う気になれなかった';
      this.log(`${buyer.profile.name}は${what}が${why}`, 'trade');
      this.remember(buyer, `市場で${what}が${why}`);
    }
    for (const [seller, list] of bought) {
      const what = list.map((x) => `${ITEMS[x.item].name}${x.qty}個`).join('と');
      const paid = list.reduce((n, x) => n + x.paid, 0);
      this.log(`${buyer.profile.name}が${seller.profile.name}から${what}を${paid}Gで買った`, 'trade');
    }
  }

  // ───────────── 移動 ─────────────

  private departFor(r: Resident, placeId: string) {
    if (r.indoors && r.placeId) {
      const from = this.map.places[r.placeId].spot;
      r.x = from.x;
      r.y = from.y;
    }
    r.indoors = false;
    r.placeId = null;
    r.targetPlaceId = placeId;
    const place = this.map.places[placeId];
    this.setPath(r, place.area ? this.randomTileIn(place) : place.spot);
  }

  private wander(r: Resident) {
    const place = this.map.places[r.targetPlaceId];
    if (!place.area) return;
    this.setPath(r, this.randomTileIn(place));
  }

  private setPath(r: Resident, goal: Point) {
    const from = { x: Math.round(r.x), y: Math.round(r.y) };
    r.path = findWalkPath(this.map, from, goal) ?? [goal];
    r.state = 'walking';
  }

  private walk(r: Resident, dt: number) {
    let budget = WALK_SPEED * dt;
    while (budget > 0 && r.path.length > 0) {
      const next = r.path[0];
      const dx = next.x - r.x;
      const dy = next.y - r.y;
      const dist = Math.hypot(dx, dy);
      if (dx !== 0) r.facing = dx > 0 ? 1 : -1;
      if (dist <= budget) {
        r.x = next.x;
        r.y = next.y;
        r.path.shift();
        budget -= dist;
        r.stride += dist;
      } else {
        r.x += (dx / dist) * budget;
        r.y += (dy / dist) * budget;
        r.stride += budget;
        budget = 0;
      }
    }
    if (r.path.length === 0) this.arrive(r);
  }

  private arrive(r: Resident) {
    const now = this.clock.minutes;
    r.state = 'idle';
    r.idleUntil = now + randInt(this.rng, 8, 40);
    if (r.placeId === r.targetPlaceId) return; // エリア内をうろうろしているだけ

    const place = this.map.places[r.targetPlaceId];
    r.placeId = place.id;
    if (place.id === 'gate' && r.leaving) {
      this.departVillage(r);
      return;
    }
    const task = this.currentTask(r);
    // 設備を使いに来たときだけ定員を気にする（人に会いに来た・何かしに来たときは関係ない）
    const usesPlace = ACTIONS[task.action as ActionId]?.place === place.id && !TARGETED_ACTIONS.includes(task.action as ActionId);
    if (usesPlace && place.capacity && this.occupants(place, r) >= place.capacity) {
      // 満員なら、空いている別の材料集めに回る。それも無理なら市場をぶらつく
      const alt = (['fish', 'farm'] as const).find((a) => {
        const p = this.map.places[ACTIONS[a].place];
        return a !== task.action && (!p.capacity || this.occupants(p, r) < p.capacity);
      });
      const fallback: ActionId = alt ?? 'wander';
      this.log(`${r.profile.name}は${place.name}に来たが、満員だったので${ACTIONS[fallback].label}をすることにした`, 'life');
      r.override = { action: fallback, until: blockEnd(now, task.block) };
    } else if (task.action !== 'sleep') {
      this.log(`${r.profile.name}が${place.name}に着いた（${r.activity}）`, 'arrive');
    }
    if (place.building) {
      r.indoors = true;
      this.tryIndoorEncounter(r, place);
    }
  }

  /** その設備を今使っている人数 */
  private occupants(place: Place, except: Resident): number {
    return this.residents.filter(
      (o) => o !== except && o.placeId === place.id && o.action !== 'wander' && ACTIONS[o.action as ActionId]?.place === place.id,
    ).length;
  }

  // ───────────── 非行と暴力 ─────────────

  /** 顔を合わせた相手の様子と持ち物を覚える（お互いに） */
  observe(self: Resident, other: Resident): void {
    const foods = ITEM_IDS.filter((id) => isFood(id) && countItem(other.inventory, id) > 0);
    (self.seen ??= {})[other.profile.id] = {
      day: this.clock.day,
      time: this.clock.formatTime(),
      at: this.clock.minutes,
      food: foods.map((id) => `${ITEMS[id].name}${countItem(other.inventory, id)}`).join('・'),
      foodValue: foodValue(other.inventory),
      looks: looksOf(other),
    };
  }

  /** 今の行動が終わる時刻（臨時の行動ならその終わり、計画ならブロックの終わり） */
  private taskEnd(r: Resident, task: Task): number {
    const now = this.clock.minutes;
    return r.override && now < r.override.until ? r.override.until : blockEnd(now, task.block);
  }

  /** その場に居合わせて、見ていたかもしれない人 */
  private bystanders(actor: Resident, victim: Resident): Resident[] {
    return this.residents.filter((o) => {
      if (o === actor || o === victim || o.action === 'sleep' || o.leaving) return false;
      if (actor.indoors) return o.indoors && o.placeId === actor.placeId;
      return !o.indoors && Math.hypot(o.x - actor.x, o.y - actor.y) <= WITNESS_RANGE;
    });
  }

  /**
   * 相手の持ち物とお金を取る。foodShare は食べ物（allItems なら小麦なども）のそれぞれから取る割合、
   * moneyShare はお金の割合
   */
  private takeFrom(
    actor: Resident,
    victim: Resident,
    foodShare: number,
    moneyShare: number,
    allItems = false,
  ): Pick<Deed, 'items' | 'money'> {
    const items: { item: ItemId; qty: number }[] = [];
    for (const id of ITEM_IDS) {
      const have = countItem(victim.inventory, id);
      if (have <= 0 || (!allItems && !isFood(id))) continue;
      const qty = foodShare >= 1 ? have : Math.max(1, Math.ceil(have * foodShare));
      moveItems(victim.inventory, actor.inventory, id, qty, this.clock.minutes);
      items.push({ item: id, qty });
    }
    const money = Math.floor(victim.money * moneyShare);
    if (money > 0) {
      victim.money -= money;
      actor.money += money;
    }
    return { items, money: money > 0 ? money : undefined };
  }

  /** 盗んだもの・奪ったものを言葉にする */
  private loot(d: Pick<Deed, 'items' | 'money' | 'item' | 'qty'>): string {
    return lootText(d);
  }

  /** 非行・暴力を実行する（相手のそばに来たときに呼ぶ） */
  private commit(actor: Resident, victim: Resident, kind: CrimeAction) {
    const place = actor.indoors ? (this.map.places[actor.placeId!]?.name ?? '家の中') : this.locationName(actor);
    const deed: Deed = {
      id: ++this.deedSeq,
      kind,
      actorId: actor.profile.id,
      actorName: actor.profile.name,
      victimId: victim.profile.id,
      victimName: victim.profile.name,
      success: false,
      day: this.clock.day,
      time: this.clock.formatTime(),
      placeName: place,
      knownBy: {},
      actorSawWitness: [],
      hushed: [],
      public: false,
    };
    const A = actor.profile.name;
    const B = victim.profile.name;
    const asleep = victim.action === 'sleep';
    // 力くらべ：体力の差がものをいう。寝ている人・弱った人は抵抗できない
    const edge = (actor.health - victim.health) / 150 + (asleep ? 0.3 : 0);
    let what = '';

    if (kind === 'steal') {
      Object.assign(deed, this.takeFrom(actor, victim, STEAL_SHARE.food, STEAL_SHARE.money));
      deed.success = !!this.loot(deed);
      what = deed.success ? `${B}から${this.loot(deed)}を盗んだ` : `${B}から盗もうとしたが、盗めるものがなかった`;
      if (deed.success && this.rng() < (asleep ? 0.1 : STEAL_NOTICE)) {
        deed.knownBy[victim.profile.id] = 'victim';
        deed.actorSawWitness.push(victim.profile.id);
      }
    } else if (kind === 'rob') {
      deed.success = this.rng() < clamp01(0.55 + edge, 0.15, 0.9);
      if (deed.success) {
        Object.assign(deed, this.takeFrom(actor, victim, ROB_SHARE.food, ROB_SHARE.money));
        what = this.loot(deed) ? `${B}から${this.loot(deed)}を力ずくで奪った` : `${B}から奪おうとしたが、何も持っていなかった`;
        this.hurt(victim, (deed.damage = 5));
      } else {
        what = `${B}から奪おうとしたが、抵抗されて失敗した`;
        this.hurt(actor, 10);
        this.hurt(victim, (deed.damage = 5));
      }
      deed.knownBy[victim.profile.id] = 'victim';
      deed.actorSawWitness.push(victim.profile.id);
    } else if (kind === 'attack') {
      deed.success = true;
      deed.damage = Math.round(20 + this.rng() * 25);
      this.hurt(actor, 3);
      what = `${B}を殴った`;
      deed.knownBy[victim.profile.id] = 'victim';
      deed.actorSawWitness.push(victim.profile.id);
    } else {
      deed.success = this.rng() < clamp01(0.45 + edge, 0.1, 0.95);
      if (deed.success) {
        // 殺した相手の持ち物とお金は、すべて自分のものにできる
        Object.assign(deed, this.takeFrom(actor, victim, 1, 1, true));
        what = `${B}を殺し${this.loot(deed) ? `、${this.loot(deed)}を奪った` : 'た'}`;
      }
      else {
        deed.damage = Math.round(25 + this.rng() * 25);
        what = `${B}を殺そうとしたが、${B}は逃げのびた`;
        deed.knownBy[victim.profile.id] = 'victim';
        deed.actorSawWitness.push(victim.profile.id);
      }
    }

    // 居合わせた人が見ていたか（暴力はまず気づかれる、盗みは半々）
    const nearby = this.bystanders(actor, victim);
    for (const w of nearby) {
      if (this.rng() >= (kind === 'steal' ? STEAL_WITNESS : VIOLENCE_WITNESS)) continue;
      deed.knownBy[w.profile.id] = 'saw';
      if (this.rng() < 0.5 || kind !== 'steal') deed.actorSawWitness.push(w.profile.id);
    }
    this.deeds.push(deed);
    const seenBy = Object.keys(deed.knownBy)
      .filter((id) => id !== victim.profile.id)
      .map((id) => this.get(id)?.profile.name)
      .filter(Boolean);
    this.log(`${A}が${place}で${what}${seenBy.length ? `（見ていた人：${seenBy.join('、')}）` : '（誰にも見られなかった）'}`, 'crime');

    // 本人の記憶（見られたと気づいた相手だけが分かる）
    const noticed = deed.actorSawWitness.map((id) => this.get(id)?.profile.name).filter(Boolean);
    this.remember(actor, `${place}で${what}。${noticed.length ? `${noticed.join('、')}に見られた` : '誰にも見られなかったと思う'}`);

    // 被害者・目撃者の記憶と気持ち
    const label = DEED_LABEL[kind];
    if (deed.knownBy[victim.profile.id] && (kind !== 'kill' || !deed.success)) {
      const text =
        kind === 'steal'
          ? `${A}に${this.loot(deed)}を盗まれた`
          : kind === 'rob'
            ? deed.success && this.loot(deed)
              ? `${A}に${this.loot(deed)}を力ずくで奪われた`
              : `${A}に襲われ、物を奪われそうになった`
            : kind === 'attack'
              ? `${A}に殴られた`
              : `${A}に殺されかけた`;
      this.remember(victim, `${place}で${text}`);
      this.feel(victim, actor, -VICTIM_GRUDGE[kind], `${this.clock.day}日目、${text}`);
    }
    for (const id of Object.keys(deed.knownBy)) {
      if (deed.knownBy[id] !== 'saw') continue;
      const w = this.get(id)!;
      const text = deed.success || kind !== 'kill' ? `${A}が${B}${label}のを見た` : `${A}が${B}を殺そうとするのを見た`;
      this.remember(w, `${place}で${text}`);
      this.feel(w, actor, -WITNESS_GRUDGE[kind], `${this.clock.day}日目、${text}`);
    }

    // 盗まれたことに気づかなかった人は、しばらくしてから物が減っていることに気づく
    if (kind === 'steal' && deed.success && !deed.knownBy[victim.profile.id]) {
      const around = [actor, ...nearby].map((o) => o.profile.name);
      this.pendingDiscoveries.push({ deedId: deed.id, at: this.clock.minutes + 30 + this.rng() * 90, nearby: shuffle(around, this.rng) });
    }

    if (deed.damage && !(kind === 'kill' && deed.success)) this.hurt(victim, deed.damage, actor, deed);
    if (kind === 'kill' && deed.success) this.murder(victim, actor, deed);
  }

  /** 体力を減らす。0 になれば亡くなる */
  private hurt(r: Resident, amount: number, by?: Resident, deed?: Deed) {
    if (!this.residents.includes(r)) return;
    r.health -= amount;
    if (r.health > 0) return;
    if (by && deed) this.murder(r, by, deed);
    else this.die(r, 'けが');
  }

  private murder(victim: Resident, actor: Resident, deed: Deed) {
    deed.success = true;
    const known = Object.keys(deed.knownBy).some((id) => id !== victim.profile.id && this.get(id));
    const name = victim.profile.name;
    this.die(
      victim,
      '殺された',
      known
        ? `${name}が${deed.placeName}で${actor.profile.name}に殺された`
        : `${name}が${deed.placeName}で死んでいるのが見つかった。誰かに殺されたらしい`,
    );
  }

  /** 盗まれた人が、物が減っていることに気づく */
  private discoverThefts() {
    const now = this.clock.minutes;
    for (const p of this.pendingDiscoveries.filter((p) => p.at <= now)) {
      this.pendingDiscoveries.splice(this.pendingDiscoveries.indexOf(p), 1);
      const deed = this.deeds.find((d) => d.id === p.deedId);
      const victim = deed && this.get(deed.victimId);
      if (!deed || !victim) continue;
      const near = p.nearby.filter((n) => n !== victim.profile.name);
      this.remember(
        victim,
        `${deed.time}ごろ${deed.placeName}にいたあと、${this.loot(deed)}がなくなっていた。誰かに盗まれたらしい。${near.length ? `そのころ近くにいたのは${near.join('、')}` : '近くには誰もいなかったはずだ'}`,
      );
      this.log(`${victim.profile.name}は${this.loot(deed)}がなくなっていることに気づいた`, 'life');
    }
  }

  /** 広場で、誰かのことをみんなに言いふらす（本当かどうかは問わない） */
  private accuse(r: Resident, task: Task) {
    if (!task.purpose) return;
    r.visited = { targetId: 'accuse', until: this.taskEnd(r, task) };
    const target = task.target ? this.get(task.target) : undefined;
    const text = `${r.profile.name}が広場で「${task.purpose}」と言いふらしている`;
    this.announce(text, 'life');
    for (const o of this.residents) if (o !== r) this.remember(o, text);
    if (target) {
      this.feel(target, r, -15, `${this.clock.day}日目、広場で自分のことを言いふらされた`);
      // 言いふらした人が本当に知っていることなら、それは村じゅうに知れわたる
      for (const d of this.deeds) {
        if (d.actorId !== target.profile.id || !(d.knownBy[r.profile.id] || d.victimId === r.profile.id)) continue;
        d.public = true;
        for (const o of this.residents) {
          if (o.profile.id !== d.actorId && !d.knownBy[o.profile.id]) d.knownBy[o.profile.id] = 'heard';
        }
      }
    }
  }

  /** 会話で非行のことを話した：聞いた人もそれを知る */
  addDisclosures(conv: Conversation, disclosures: { deedId: number; fromId: string; toId: string }[]): void {
    for (const x of disclosures) {
      const d = this.deeds.find((d) => d.id === x.deedId);
      const from = this.get(x.fromId);
      const to = this.get(x.toId);
      if (!d || !from || !to || ![conv.a, conv.b].includes(from) || ![conv.a, conv.b].includes(to)) continue;
      const fromKnows = d.actorId === from.profile.id || !!d.knownBy[from.profile.id];
      if (!fromKnows || d.actorId === to.profile.id || d.knownBy[to.profile.id]) continue;
      d.knownBy[to.profile.id] = 'heard';
      const confessed = d.actorId === from.profile.id;
      const act = `${d.victimName}${DEED_DONE[d.kind]}`;
      const text = confessed ? `${from.profile.name}が、自分が${act}と打ち明けた` : `${from.profile.name}から、${d.actorName}が${act}と聞いた`;
      this.remember(to, text);
      this.log(`${to.profile.name}は${text}`, 'crime', { conversationId: conv.id });
      const actor = this.get(d.actorId);
      if (actor && !confessed) this.feel(to, actor, -WITNESS_GRUDGE[d.kind] / 2, `${this.clock.day}日目、${d.actorName}が${act}と聞いた`);
    }
  }

  /** その人が知っている、ほかの人の非行（本人がしたものは含まない） */
  deedsKnownBy(r: Resident): Deed[] {
    return this.deeds.filter((d) => d.actorId !== r.profile.id && (d.knownBy[r.profile.id] || (d.public && d.victimId !== r.profile.id)));
  }

  /** その人がしたこと（隠していること） */
  deedsBy(r: Resident): Deed[] {
    return this.deeds.filter((d) => d.actorId === r.profile.id);
  }

  // ───────────── 村の集会 ─────────────

  /** 広場で集会を呼びかける。夕方（間に合わなければ翌日）に集会所で開く */
  private callAssembly(r: Resident, task: Task) {
    if (!task.purpose) return;
    r.visited = { targetId: 'call_assembly', until: this.taskEnd(r, task) };
    const pending = this.assemblies.find((a) => a.status !== 'done');
    if (pending) {
      this.remember(r, `集会を呼びかけようとしたが、もう${pending.callerName}の呼びかけた集会（「${pending.agenda}」）が予定されていた`);
      return;
    }
    const g = this.holdGathering('hall', ASSEMBLY_FROM, ASSEMBLY_TO, '村の集会');
    const target = task.target ? this.get(task.target) : undefined;
    const assembly: Assembly = {
      id: ++this.assemblySeq,
      callerId: r.profile.id,
      callerName: r.profile.name,
      agenda: task.purpose,
      targetId: target?.profile.id,
      targetName: target?.profile.name,
      day: Math.floor(g.from / 1440) + 1,
      from: g.from,
      status: 'scheduled',
    };
    g.assemblyId = assembly.id;
    this.assemblies.push(assembly);
    const when = assembly.day === this.clock.day ? '今日' : '明日';
    this.announce(`${r.profile.name}が「${assembly.agenda}」について話し合うため、${when}の${ASSEMBLY_FROM}時から集会所で村の集会を開くと呼びかけた`, 'life');
  }

  /** 集会の時間になったら話し合いを始め、終わりの時間までに結論が出なければ少し延ばす */
  private advanceAssemblies() {
    const now = this.clock.minutes;
    for (const a of this.assemblies) {
      if (a.status === 'scheduled' && now >= a.from) {
        a.status = 'deliberating';
        this.log(`村の集会が始まった（議題：「${a.agenda}」、呼びかけ：${a.callerName}）`, 'assembly');
        this.events.emit('assemblyStart', a);
      }
      if (a.status !== 'deliberating') continue;
      const g = this.gatherings.find((g) => g.assemblyId === a.id);
      if (!g) continue;
      if (now >= a.from + ASSEMBLY_GIVE_UP) {
        this.concludeAssembly(a, null);
      } else if (g.to - now <= 60) {
        // 話し合いが続いているあいだは解散しない
        g.to = now + 60;
      }
    }
  }

  /** 集会の結論を受け取り、決まったことを実行する（null なら話がまとまらなかった） */
  concludeAssembly(a: Assembly, result: AssemblyResult | null): void {
    if (a.status === 'done') return;
    a.status = 'done';
    const g = this.gatherings.find((g) => g.assemblyId === a.id);
    if (g) g.to = Math.min(g.to, this.clock.minutes + 10);
    if (!result) {
      this.log(`集会は話がまとまらないまま終わった（「${a.agenda}」）`, 'assembly');
      for (const r of this.residents) this.remember(r, `集会で「${a.agenda}」について話し合ったが、話はまとまらなかった`);
      return;
    }
    a.result = result;
    for (const sp of result.speeches) {
      const who = this.get(sp.speakerId);
      if (who) this.log(`${who.profile.name}「${sp.text}」`, 'speech', { speakerId: who.profile.id });
    }
    const yes = result.votes.filter((v) => v.yes).length;
    const no = result.votes.length - yes;
    const p = result.proposal;
    const target = p.targetId ? this.get(p.targetId) : undefined;
    const outcome = this.describeProposal(p, target);
    const verdict = p.kind === 'none' ? '採決はしなかった' : `賛成${yes}・反対${no}で${result.passed ? '可決' : '否決'}`;
    this.announce(`集会で「${a.agenda}」が話し合われた。${p.kind === 'none' ? '' : `提案：${outcome}。`}${verdict}`, 'assembly');

    for (const v of result.votes) {
      const voter = this.get(v.voterId);
      if (!voter) continue;
      this.remember(voter, `集会（「${a.agenda}」）で、${p.kind === 'none' ? '話し合った' : `「${outcome}」に${v.yes ? '賛成' : '反対'}した（${verdict}）`}`);
    }
    for (const r of this.residents) {
      if (!result.votes.some((v) => v.voterId === r.profile.id)) this.remember(r, `集会で「${a.agenda}」が話し合われ、${verdict}`);
    }
    if (!result.passed || p.kind === 'none') return;

    // 罰を受ける人は、賛成した人を覚えている
    if (target && (p.kind === 'exile' || p.kind === 'fine')) {
      for (const v of result.votes) {
        const voter = this.get(v.voterId);
        if (v.yes && voter && voter !== target) this.feel(target, voter, -15, `${this.clock.day}日目の集会で、自分への「${outcome}」に賛成した`);
      }
    }
    switch (p.kind) {
      case 'exile':
        if (target) {
          target.leaving = `集会で村から追放された（${a.agenda}）`;
          target.override = null;
          this.log(`${target.profile.name}は村を出ていかなければならなくなった`, 'assembly');
        }
        return;
      case 'fine': {
        if (!target || !p.amount) return;
        const amount = Math.min(target.money, Math.round(p.amount));
        const to = p.beneficiaryId ? this.get(p.beneficiaryId) : undefined;
        const receivers = to && to !== target ? [to] : this.residents.filter((r) => r !== target);
        target.money -= amount;
        const share = Math.floor(amount / Math.max(1, receivers.length));
        receivers.forEach((r, i) => (r.money += share + (i === 0 ? amount - share * receivers.length : 0)));
        this.log(`${target.profile.name}は罰金${amount}Gを払った（${to ? `${to.profile.name}へ` : '村のみんなで分けた'}）`, 'assembly');
        return;
      }
      case 'rule': {
        // 同じ名前の決まりがすでにあれば、作り直さない
        const same = this.laws.find((l) => l.title === (p.title || '決まり'));
        if (same) {
          this.log(`決まり「${same.title}」はもうあるので、あらためて確かめ合っただけになった`, 'assembly');
          return;
        }
        const law: Law = {
          id: ++this.lawSeq,
          title: p.title || '決まり',
          text: p.text || p.title || '',
          enactedDay: this.clock.day,
          assemblyId: a.id,
        };
        this.laws.push(law);
        this.announce(`村の決まりができた：「${law.title}」${law.text && law.text !== law.title ? `（${law.text}）` : ''}`, 'assembly');
        return;
      }
      case 'repeal': {
        const i = this.laws.findIndex((l) => l.id === p.lawId);
        if (i < 0) return;
        const [law] = this.laws.splice(i, 1);
        this.announce(`村の決まり「${law.title}」が廃止された`, 'assembly');
        return;
      }
    }
  }

  private describeProposal(p: AssemblyResult['proposal'], target?: Resident): string {
    const name = target?.profile.name ?? '（誰か）';
    switch (p.kind) {
      case 'exile':
        return `${name}を村から追放する`;
      case 'fine': {
        const to = p.beneficiaryId ? this.get(p.beneficiaryId)?.profile.name : undefined;
        return `${name}に罰金${p.amount ?? 0}Gを科す${to ? `（${to}に払う）` : ''}`;
      }
      case 'rule':
        return `決まり「${p.title ?? ''}」を作る${p.text && p.text !== p.title ? `（${p.text}）` : ''}`;
      case 'repeal':
        return `決まり「${this.laws.find((l) => l.id === p.lawId)?.title ?? `#${p.lawId}`}」を廃止する`;
      default:
        return '話し合うだけ';
    }
  }

  // ───────────── 出会いと会話 ─────────────

  private tryIndoorEncounter(r: Resident, place: Place) {
    if (r.action === 'sleep' || r.action === 'gather') return;
    const other = this.residents.find(
      (o) => o !== r && o.indoors && o.placeId === place.id && !o.conversation && o.action !== 'sleep' && this.canMeet(r, o),
    );
    if (other) this.startConversation(r, other, place.name, true);
  }

  private detectOutdoorEncounters() {
    const outside = this.residents.filter((r) => !r.indoors && !r.conversation);
    for (let i = 0; i < outside.length; i++) {
      for (let j = i + 1; j < outside.length; j++) {
        const a = outside[i];
        const b = outside[j];
        if (a.conversation || b.conversation) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > 1.1 || !this.canMeet(a, b)) continue;
        // 会いに行く・何かしに行く途中の人は approach で相手に近づく
        if (TARGETED_ACTIONS.includes(a.action as ActionId) || TARGETED_ACTIONS.includes(b.action as ActionId)) continue;
        // 施しを求めている人は、通りかかった人に頼む
        const beggar = a.action === 'beg' ? a : b.action === 'beg' ? b : null;
        if (beggar) {
          const other = beggar === a ? b : a;
          this.startConversation(beggar, other, this.locationName(a), false, `${HUNGRY_PURPOSE}。通りかかった人に施しを求めている`);
          continue;
        }
        this.startConversation(a, b, this.locationName(a), false);
      }
    }
  }

  private canMeet(a: Resident, b: Resident): boolean {
    const last = this.lastMet.get(pairKey(a, b));
    return last === undefined || this.clock.minutes - last >= MEET_COOLDOWN;
  }

  private startConversation(a: Resident, b: Resident, placeName: string, indoors: boolean, purpose?: string) {
    const kind = this.conversationGate(a, b);
    const conv: Conversation = {
      id: ++this.conversationSeq,
      a,
      b,
      placeName,
      indoors,
      kind,
      lines: null,
      index: 0,
      elapsed: 0,
      waited: 0,
      outcome: null,
      purpose,
      engagedUntil: this.clock.minutes + (kind === 'ai' ? AI_TALK_MINUTES : GREETING_TALK_MINUTES),
    };
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      this.observe(self, other);
      self.conversation = conv;
      self.state = 'talking';
      if (other.x !== self.x) self.facing = other.x > self.x ? 1 : -1;
    }
    this.lastMet.set(pairKey(a, b), this.clock.minutes);
    this.conversations.push(conv);

    if (kind === 'ai') {
      this.log(`${a.profile.name}と${b.profile.name}が${placeName}で話し始めた`, 'meet', { conversationId: conv.id });
      this.events.emit('encounter', conv);
    } else {
      this.log(`${a.profile.name}と${b.profile.name}があいさつを交わした`, 'greet');
      this.setDialogue(conv, greetingLines(a, b, this.clock.hourOfDay), null);
    }
  }

  /**
   * AIの会話は読める速さで流したいので現実の時間で進める（そのあいだ村は等速に落ちる）。
   * あいさつは村の時間で進める。現実の時間にすると、早送り中はあいさつだけで何時間も止まってしまう。
   */
  private advanceConversations(realSeconds: number, gameMinutes: number) {
    for (const conv of [...this.conversations]) {
      if (!conv.lines) {
        conv.waited += realSeconds;
        if (conv.waited > PENDING_TIMEOUT) this.fallbackToGreeting(conv);
        continue;
      }
      const line = conv.lines[conv.index];
      if (conv.kind === 'greeting') {
        conv.elapsed += gameMinutes;
        if (conv.elapsed < GREETING_LINE_MINUTES) continue;
      } else {
        conv.elapsed += realSeconds;
        if (conv.elapsed < lineDuration(line.text)) continue;
      }
      conv.index++;
      conv.elapsed = 0;
      if (conv.index >= conv.lines.length) this.finishConversation(conv);
      else this.announceLine(conv);
    }
  }

  private announceLine(conv: Conversation) {
    if (conv.kind !== 'ai') return;
    const line = this.currentLine(conv);
    const speaker = line && this.get(line.speakerId);
    if (!line || !speaker) return;
    this.log(`${speaker.profile.name}「${line.text}」`, 'speech', {
      speakerId: speaker.profile.id,
      conversationId: conv.id,
    });
  }

  private finishConversation(conv: Conversation) {
    const i = this.conversations.indexOf(conv);
    if (i < 0) return;
    this.conversations.splice(i, 1);
    this.lastMet.set(pairKey(conv.a, conv.b), this.clock.minutes);
    for (const r of [conv.a, conv.b]) {
      r.conversation = null;
      if (r.state === 'talking') r.state = r.path.length > 0 ? 'walking' : 'idle';
      r.idleUntil = this.clock.minutes + randInt(this.rng, 3, 15);
    }
    if (conv.kind === 'ai') for (const r of [conv.a, conv.b]) r.today.talks = (r.today.talks ?? 0) + 1;
    // 片方が亡くなっていたら、記憶や関係は更新しない
    if (conv.outcome && this.residents.includes(conv.a) && this.residents.includes(conv.b)) {
      this.applyOutcome(conv, conv.outcome);
      for (const ag of conv.outcome.agreements) this.carryOut(conv, ag);
      if (conv.agreementsReady) this.checkRefusal(conv);
    }
    this.events.emit('conversationEnd', conv);
  }

  private applyOutcome(conv: Conversation, outcome: ConversationOutcome) {
    const changes: string[] = [];
    for (const ref of outcome.reflections) {
      const self = ref.residentId === conv.a.profile.id ? conv.a : conv.b;
      const other = self === conv.a ? conv.b : conv.a;
      if (ref.memory) this.remember(self, ref.memory);
      if (ref.reason && ref.affinityDelta !== 0) this.feel(self, other, ref.affinityDelta, `${this.clock.day}日目、${ref.reason}`);
      const rel = self.relations[other.profile.id] ?? defaultRelation();
      if (!ref.reason) rel.affinity = Math.max(-100, Math.min(100, rel.affinity + ref.affinityDelta));
      if (ref.impression) rel.impression = ref.impression;
      self.relations[other.profile.id] = rel;
      const sign = ref.affinityDelta > 0 ? '+' : '';
      changes.push(`${self.profile.name}→${other.profile.name} ♥${sign}${ref.affinityDelta}`);
    }
    this.log(`${outcome.summary}（${changes.join(' / ')}）`, 'summary', { conversationId: conv.id });
  }

  /** 会話で決まったことを実行する。できなければ「果たせなかった」として残る */
  private carryOut(conv: Conversation, ag: Agreement): void {
    const from = this.get(ag.fromId);
    const to = this.get(ag.toId);
    const inConv = (r?: Resident) => r === conv.a || r === conv.b;
    if (!from || !to || from === to || !inConv(from) || !inConv(to)) return;
    const A = from.profile.name;
    const B = to.profile.name;
    const money = Math.max(0, Math.round(ag.money ?? 0));
    const qty = Math.max(0, Math.round(ag.qty ?? 0));
    const itemName = ag.item ? ITEMS[ag.item].name : '';
    const fail = (what: string, why: string) => {
      this.log(`${A}と${B}は「${what}」で合意したが、${why}ため果たせなかった`, 'deal');
      this.remember(from, `${B}と「${what}」の約束をしたが、${why}ため果たせなかった`);
      this.remember(to, `${A}と「${what}」の約束をしたが、${why}ため果たせなかった`);
      this.feel(to, from, -3, `${this.clock.day}日目、「${what}」の約束が果たされなかった`);
    };
    const moveMoney = (payer: Resident, payee: Resident, n: number) => {
      payer.money -= n;
      payee.money += n;
      payer.today.spent += n;
      payee.today.earned += n;
    };

    switch (ag.type) {
      case 'trade': {
        if (!ag.item || qty <= 0) return;
        // 代金なしの「売買」は、実際にはあげたのと同じ
        if (money <= 0) return this.carryOut(conv, { ...ag, type: 'gift', money: 0 });
        const what = `${A}が${B}に${itemName}${qty}個を${money}Gで売る`;
        if (to.money < money) return fail(what, `${B}のお金が足りなかった`);
        if (countItem(from.inventory, ag.item) < qty) {
          // 今は持っていない：品物ができたら渡す約束として残す
          const dueDay = this.clock.day + 2;
          this.deliveries.push({
            id: ++this.dealSeq,
            sellerId: from.profile.id,
            buyerId: to.profile.id,
            item: ag.item,
            qty,
            money,
            createdDay: this.clock.day,
            dueDay,
          });
          this.log(`${A}が${B}に、${itemName}${qty}個を手に入れたら${money}Gで渡すと約束した（${dueDay}日目まで）`, 'deal');
          this.remember(from, `${B}に${itemName}${qty}個を${dueDay}日目までに渡す約束をした（代金${money}G）`);
          this.remember(to, `${A}から${itemName}${qty}個を${dueDay}日目までに受け取る約束をした（代金${money}G）`);
          return;
        }
        moveItems(from.inventory, to.inventory, ag.item, qty, this.clock.minutes);
        moveMoney(to, from, money);
        addCount(from.today.sold, ag.item, qty);
        addCount(to.today.bought, ag.item, qty);
        const m = (this.market.today.sold[ag.item] ??= { qty: 0, revenue: 0 });
        m.qty += qty;
        m.revenue += money;
        this.log(`${A}が${B}に${itemName}${qty}個を${money}Gで売った`, 'deal');
        if (to === conv.a) conv.received = true;
        return;
      }
      case 'gift': {
        const parts: string[] = [];
        if (ag.item && qty > 0) {
          if (countItem(from.inventory, ag.item) < qty) return fail(`${itemName}${qty}個をあげる`, `${A}の${itemName}が足りなかった`);
          moveItems(from.inventory, to.inventory, ag.item, qty, this.clock.minutes);
          parts.push(`${itemName}${qty}個`);
        }
        if (money > 0) {
          if (from.money < money) return fail(`${money}Gをあげる`, `${A}のお金が足りなかった`);
          moveMoney(from, to, money);
          parts.push(`${money}G`);
        }
        if (parts.length === 0) return;
        if (to === conv.a) conv.received = true;
        this.log(`${A}が${B}に${parts.join('と')}をあげた`, 'deal');
        this.feel(to, from, 6, `${this.clock.day}日目、${parts.join('と')}を分けてくれた`);
        return;
      }
      case 'hush': {
        // from が口止めを頼む人（払う人）、to が黙ると約束する人
        const parts: string[] = [];
        if (ag.item && qty > 0) {
          if (countItem(from.inventory, ag.item) < qty) return fail(`${itemName}${qty}個で口止めする`, `${A}の${itemName}が足りなかった`);
          moveItems(from.inventory, to.inventory, ag.item, qty, this.clock.minutes);
          parts.push(`${itemName}${qty}個`);
        }
        if (money > 0) {
          if (from.money < money) return fail(`${money}Gで口止めする`, `${A}のお金が足りなかった`);
          moveMoney(from, to, money);
          parts.push(`${money}G`);
        }
        const secrets = this.deeds.filter((d) => d.actorId === from.profile.id && d.knownBy[to.profile.id]);
        for (const d of secrets) if (!d.hushed.includes(to.profile.id)) d.hushed.push(to.profile.id);
        const fee = parts.length ? `（口止め料：${parts.join('と')}）` : '';
        const about = ag.text || (secrets.length ? `${A}がしたこと` : `${A}のこと`);
        this.log(`${B}は${A}に頼まれて「${about}」を黙っていると約束した${fee}`, 'crime', { conversationId: conv.id });
        this.remember(from, `${B}に「${about}」を黙っていてもらう約束をした${fee}`);
        this.remember(to, `${A}に頼まれて「${about}」を黙っていると約束した${fee}`);
        return;
      }
      case 'loan': {
        const days = Math.max(1, Math.min(14, Math.round(ag.days ?? 3)));
        if (money <= 0) return;
        if (from.money < money) return fail(`${money}Gを貸す`, `${A}のお金が足りなかった`);
        moveMoney(from, to, money);
        this.debts.push({
          id: ++this.dealSeq,
          lenderId: from.profile.id,
          borrowerId: to.profile.id,
          principal: money,
          remaining: money,
          createdDay: this.clock.day,
          dueDay: this.clock.day + days,
        });
        this.log(`${A}が${B}に${money}Gを貸した（${this.clock.day + days}日目までに返す約束）`, 'deal');
        this.remember(to, `${A}から${money}Gを借りた。${this.clock.day + days}日目までに返す約束`);
        this.remember(from, `${B}に${money}Gを貸した。${this.clock.day + days}日目までに返してもらう約束`);
        this.feel(to, from, 4, `${this.clock.day}日目、お金を貸してくれた`);
        return;
      }
      case 'repay': {
        const owed = this.owed(from, to);
        const amount = Math.min(money || owed, owed);
        if (amount <= 0) return;
        if (from.money < amount) return fail(`${amount}Gを返す`, `${A}のお金が足りなかった`);
        moveMoney(from, to, amount);
        let left = amount;
        for (const d of this.debts.filter((d) => d.borrowerId === from.profile.id && d.lenderId === to.profile.id)) {
          const n = Math.min(left, d.remaining);
          d.remaining -= n;
          left -= n;
        }
        for (let i = this.debts.length - 1; i >= 0; i--) if (this.debts[i].remaining <= 0) this.debts.splice(i, 1);
        const rest = this.owed(from, to);
        this.log(`${A}が${B}に${amount}Gを返した${rest > 0 ? `（残り${rest}G）` : '（完済）'}`, 'deal');
        if (rest === 0) this.feel(to, from, 4, `${this.clock.day}日目、借りたお金をきちんと返してくれた`);
        return;
      }
      case 'hire': {
        const action = ag.action;
        const days = Math.max(1, Math.min(14, Math.round(ag.days ?? 3)));
        if (!action || money <= 0) return;
        if (this.employmentOf(to)) return fail(`${B}が${A}に雇われる`, `${B}はすでに別の人に雇われていた`);
        this.employments.push({
          id: ++this.dealSeq,
          employerId: from.profile.id,
          employeeId: to.profile.id,
          action,
          wage: money,
          startDay: this.clock.day + 1,
          untilDay: this.clock.day + days,
          workedToday: 0,
        });
        const job = ACTIONS[action].label;
        this.log(`${A}が${B}を日給${money}Gで雇った（${job}、${this.clock.day + 1}〜${this.clock.day + days}日目）`, 'deal');
        this.remember(to, `${A}に日給${money}Gで雇われた（${job}、${this.clock.day + days}日目まで）`);
        this.remember(from, `${B}を日給${money}Gで雇った（${job}、${this.clock.day + days}日目まで）`);
        return;
      }
      case 'quit': {
        const emp = this.employments.find((e) => e.employeeId === from.profile.id && e.employerId === to.profile.id);
        if (!emp) return;
        this.employments.splice(this.employments.indexOf(emp), 1);
        this.log(`${A}は${B}のもとで働くのをやめた`, 'deal');
        this.remember(to, `${A}が自分のもとで働くのをやめた`);
        return;
      }
      case 'teach': {
        // 教える側が上手なら、差の4分の1だけ上達する
        if (!ag.action) return;
        const skill = ACTIONS[ag.action].skill;
        if (!skill) return;
        const label = SKILLS[skill];
        const gap = from.skills[skill] - to.skills[skill];
        if (gap < 5) {
          this.log(`${A}は${B}に${label}を教えようとしたが、教えられるほどの腕はなかった`, 'deal');
          // 誰が上手かは、こうした経験から知っていく
          const theirs = Math.round(from.skills[skill]);
          const mine = Math.round(to.skills[skill]);
          this.remember(to, `${A}に${label}を教わろうとしたが、${A}の${label}の腕前（${theirs}）は自分（${mine}）${theirs < mine ? 'より下手だった' : 'とほとんど変わらなかった'}`);
          this.remember(from, `${B}に${label}を教えようとしたが、自分の腕前（${theirs}）では${B}（${mine}）に教えられることはなかった`);
          return;
        }
        const gain = Math.round(gap * 0.25);
        to.skills[skill] = Math.min(100, to.skills[skill] + gain);
        this.log(`${A}が${B}に${label}を教えた（${B}の腕前 +${gain}）`, 'deal');
        this.remember(to, `${A}に${label}を教わって、少し上達した`);
        this.feel(to, from, 4, `${this.clock.day}日目、${label}を教えてくれた`);
        return;
      }
      case 'promise': {
        const text = (ag.text ?? '').trim();
        if (!text) return;
        this.log(`${A}が${B}に約束した：「${text}」`, 'deal');
        this.remember(from, `${B}に約束した：「${text}」`);
        this.remember(to, `${A}が約束してくれた：「${text}」`);
        return;
      }
    }
  }

  private locationName(r: Resident): string {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    const area = Object.values(this.map.places).find((p) => p.area && rectContains(p.area, x, y));
    return area?.name ?? '道ばた';
  }

  private randomTileIn(place: Place): Point {
    const area = place.area!;
    for (let i = 0; i < 30; i++) {
      const x = area.x + Math.floor(this.rng() * area.w);
      const y = area.y + Math.floor(this.rng() * area.h);
      if (isWalkable(this.map, x, y)) return { x, y };
    }
    return place.spot;
  }

  log(text: string, kind: LogEntry['kind'], extra: Pick<LogEntry, 'speakerId' | 'conversationId'> = {}) {
    const entry: LogEntry = { time: this.clock.formatTime(), text, kind, ...extra };
    this.logHistory.push(entry);
    if (this.logHistory.length > MAX_LOG_HISTORY) this.logHistory.shift();
    this.events.emit('log', entry);
  }
}

const pairKey = (a: Resident, b: Resident) => [a.profile.id, b.profile.id].sort().join(':');

const defaultRelation = (): Relation => ({ affinity: 0, impression: '顔見知り' });

/**
 * 買い手が1つに出してもいい値段。値段に上限はなく（インフレしてかまわない）、
 * 空腹なほど・お金を持っているほど高くても買う。満腹なら安くないと買わない。
 */
export function willingToPay(buyer: Resident, item: ItemId): number {
  const urgency = buyer.satiety <= 0 ? 1.5 : buyer.satiety < HUNGRY_BELOW ? 1 : buyer.satiety < 60 ? 0.5 : 0.25;
  // 小麦はそのまま食べられないが、パンにすれば満腹度30ほどになる
  const worth = item === 'wheat' ? 30 : ITEMS[item].satiety;
  return Math.max(1, Math.floor((buyer.money * urgency * worth) / DAILY_NEED));
}

/** 1行を表示しておく現実の秒数（長いセリフほど長く） */
const lineDuration = (text: string) => Math.min(6, Math.max(2.2, 1.2 + text.length * 0.09));

/** 釣りや畑仕事の最中はうろうろせず、その場にとどまる */
const isStationary = (action: CurrentAction) => action === 'fish' || action === 'farm' || action === 'sell';

/** 今のブロックが終わる時刻（分）。ブロックがなければ1時間後 */
function blockEnd(now: number, block?: PlanBlock): number {
  if (!block) return now + 60;
  return Math.floor(now / 1440) * 1440 + block.to * 60;
}

function addCount(target: Partial<Record<ItemId, number>>, item: ItemId, n: number) {
  target[item] = (target[item] ?? 0) + n;
}

const SKILL_OUTPUTS: Record<SkillId, ItemId[]> = {
  farm: ['wheat', 'vegetable'],
  fish: ['fish'],
  bake: ['bread'],
  cook: ['meal', 'drink'],
  chop: ['wood'],
  build: [],
};

function usedSkill(stats: DayStats, skill: SkillId): boolean {
  if (skill === 'build') return (stats.hours.build ?? 0) > 0;
  return SKILL_OUTPUTS[skill].some((id) => (stats.produced[id] ?? 0) > 0);
}

const listItems = (counts: Partial<Record<ItemId, number>>) =>
  ITEM_IDS.filter((id) => (counts[id] ?? 0) > 0)
    .map((id) => `${ITEMS[id].name}${counts[id]}`)
    .join('・');

/** その日の出来高をひとことにまとめる */
export function summarizeDay(s: DayStats): string {
  const parts: string[] = [];
  if (listItems(s.produced)) parts.push(`${listItems(s.produced)}を手に入れた`);
  if (listItems(s.sold)) parts.push(`${listItems(s.sold)}を売って${s.earned}G稼いだ`);
  if (listItems(s.bought)) parts.push(`${listItems(s.bought)}を${s.spent}Gで買った`);
  if (listItems(s.ate)) parts.push(`${listItems(s.ate)}を食べた`);
  else parts.push('何も食べられなかった');
  if (listItems(s.spoiled)) parts.push(`${listItems(s.spoiled)}が腐ってしまった`);
  return parts.join('、');
}

function greetingLines(a: Resident, b: Resident, hour: number): DialogueLine[] {
  const greet = hour >= 4 && hour < 10 ? 'おはよう' : hour >= 10 && hour < 17 ? 'こんにちは' : 'こんばんは';
  return [
    { speakerId: a.profile.id, text: `${b.profile.name}、${greet}` },
    { speakerId: b.profile.id, text: `${greet}` },
  ];
}

const clamp01 = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 並びをばらばらにする（「近くにいた人」の順番から犯人が分からないように） */
function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** はた目に見える様子 */
export function looksOf(r: Resident): string {
  if (r.health < 50) return 'ひどく弱っている';
  if (r.satiety <= 0) return 'ひどくやつれている';
  if (r.satiety < 30) return '腹を空かせている';
  if (r.health < 80) return 'けがをしているか、少し弱っている';
  return '元気そう';
}

/** 盗んだもの・奪ったもの（「パン2個・魚1個と30G」） */
export function lootText(d: Pick<Deed, 'items' | 'money' | 'item' | 'qty'>): string {
  const items = d.items ?? (d.item ? [{ item: d.item, qty: d.qty ?? 1 }] : []);
  const goods = items.map((x) => `${ITEMS[x.item].name}${x.qty}個`).join('・');
  const money = d.money ? `${d.money}G` : '';
  return [goods, money].filter(Boolean).join('と');
}

/** 暮らしの満足の言い方 */
export function satisfactionLabel(n: number): string {
  if (n >= 75) return '満ち足りている';
  if (n >= 55) return 'まずまず';
  if (n >= 35) return '物足りない';
  return '不満だらけ';
}

/** 満足による仕事のはかどり具合（満足0で0.8倍、50で1倍、100で1.2倍） */
export function moodFactor(satisfaction: number): number {
  return 0.8 + 0.4 * (Math.max(0, Math.min(100, satisfaction)) / 100);
}

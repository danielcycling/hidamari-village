import { Emitter } from '../core/emitter';
import { mulberry32, randInt, type Rng } from '../core/rng';
import { Clock } from './clock';
import {
  addItem,
  BAKE_INPUT,
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
  type ActionId,
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
  /** 村を出ていく理由（出ていく途中なら入る） */
  leaving: string | null;
  /** 「高すぎて買えなかった」を最後に覚えた日（同じ日に何度も覚えないため） */
  lastPriceComplaintDay?: number;
  /** 会いに行って話し終えた相手（同じブロックで何度も話しかけないため） */
  visited?: { targetId: string; until: number };
  /** 危機の判断をLLMに頼んだ時刻 */
  crisisRequestedAt?: number;
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

export type AgreementType = 'trade' | 'gift' | 'loan' | 'repay' | 'hire' | 'quit' | 'promise';

/**
 * 会話の中で決まったこと。from/to の意味は種類ごとに違う：
 * trade=売り手/買い手、gift=あげる人/もらう人、loan=貸す人/借りる人、repay=返す人/返される人、
 * hire=雇う人/雇われる人、quit=辞める人/雇い主、promise=約束する人/される人
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
}

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
    | 'deal';
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
};

/** 村人みんなが知っている出来事 */
export interface News {
  /** 起きた時刻（1日目0:00からの分） */
  at: number;
  day: number;
  time: string;
  text: string;
}

export type WeatherKind = 'clear' | 'rain';

/** 一定時間、全員の予定を上書きする（お祭りなど） */
export interface Gathering {
  from: number;
  to: number;
  placeId: string;
  activity: string;
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
  weather: { kind: WeatherKind; until: number } = { kind: 'clear', until: 0 };
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
  dealSeq = 0;
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
    return this.clock.speed > 1 && this.conversations.some((c) => c.kind === 'ai');
  }

  /** AIが考えた会話を流し始める */
  setDialogue(conv: Conversation, lines: DialogueLine[], outcome: ConversationOutcome | null): void {
    if (!this.conversations.includes(conv) || conv.lines) return;
    conv.lines = lines;
    conv.outcome = outcome;
    conv.elapsed = 0;
    this.announceLine(conv);
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

  startRain(hours: number): void {
    this.weather = { kind: 'rain', until: this.clock.minutes + hours * 60 };
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

  private die(r: Resident, cause: string) {
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
    for (const o of this.residents) this.remember(o, `${r.profile.name}が${cause}で亡くなった`);
    this.announce(`${r.profile.name}が${cause}で亡くなった`, 'death');
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
    if (h >= IMMIGRATION_HOUR && h < IMMIGRATION_HOUR + 1) this.tryImmigration();
    if (h >= PLANNING_HOUR && this.lastEveningDay !== this.clock.day) {
      this.lastEveningDay = this.clock.day;
      this.events.emit('evening', { day: this.clock.day });
    }
  }

  /** 1日の終わり：出来高を要約して記憶とログに残し、使わなかった技能を衰えさせる */
  private endOfDay() {
    const day = this.clock.day - 1;
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

  /** 自己像を更新する */
  setSelfImage(r: Resident, text: string): void {
    if (!this.residents.includes(r) || !text || text === r.selfImage) return;
    r.selfImage = text;
    r.selfImageHistory.push({ day: this.clock.day, text });
    if (r.selfImageHistory.length > 10) r.selfImageHistory.shift();
    this.log(`${r.profile.name}の自己像：「${text}」`, 'plan', { speakerId: r.profile.id });
  }

  private updateWeather() {
    if (this.weather.kind === 'rain' && this.clock.minutes >= this.weather.until) {
      this.weather = { kind: 'clear', until: 0 };
      this.announce('雨が上がった');
    }
  }

  // ───────────── 1分ごとの住民の更新 ─────────────

  private updateResident(r: Resident, dt: number) {
    this.updateBody(r, dt);
    if (!this.residents.includes(r) || r.conversation) return;

    this.handleHunger(r);
    const task = this.currentTask(r);
    r.activity = task.label;
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

  /** 満腹度・体力・食事・死 */
  private updateBody(r: Resident, dt: number) {
    const asleep = r.action === 'sleep' && r.indoors;
    const before = r.satiety;
    r.satiety = Math.max(0, r.satiety - (asleep ? SATIETY_LOSS_ASLEEP : SATIETY_LOSS_AWAKE) * dt);
    if (r.satiety <= 0) r.health -= STARVING_HEALTH_LOSS * dt;
    else if (r.satiety >= 50) r.health = Math.min(100, r.health + HEALTH_RECOVERY * dt);

    if (!asleep) this.maybeEat(r);

    if (before >= HUNGRY_BELOW && r.satiety < HUNGRY_BELOW) {
      this.log(`${r.profile.name}はお腹を空かせている（食べ物 ${describeInventory(r.inventory)}、所持金${r.money}G）`, 'life');
    }
    if (before > 0 && r.satiety <= 0) {
      this.log(`${r.profile.name}は食べる物がなく、飢え始めた`, 'life');
      this.remember(r, '食べる物がなく、飢え始めた');
    }
    if (r.health <= 0) this.die(r, '飢え');
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

    if (action === 'visit') {
      const t = target ? this.get(target) : undefined;
      const done = r.visited && r.visited.targetId === target && now < r.visited.until;
      if (t && !done) {
        const placeId = t.placeId ?? (t.targetPlaceId || 'plaza');
        return { placeId, action, label: `${t.profile.name}に会いに行く`, block, target, purpose };
      }
      action = 'wander';
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
    if (this.weather.kind === 'rain' && (action === 'wander' || action === 'beg')) {
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
        this.doWork(r, r, task.action, task, dt);
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
        this.approach(r, task);
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
        this.accumulate(worker, owner, 'wheat', FARM_PER_HOUR.wheat * f * (dt / 60));
        this.accumulate(worker, owner, 'vegetable', FARM_PER_HOUR.vegetable * f * (dt / 60));
        break;
      }
      case 'fish': {
        const f = this.work(worker, 'fish', dt);
        if (this.rng() < FISH_PER_HOUR * f * (dt / 60)) this.produce(owner, 'fish', 1);
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
    if (t.conversation || t.action === 'sleep') return;
    r.visited = { targetId: t.profile.id, until: blockEnd(this.clock.minutes, task.block) };
    this.startConversation(r, t, this.map.places[r.placeId!]?.name ?? '道ばた', r.indoors, task.purpose || '用があって会いに来た');
  }

  /** 働いた分だけ上達し、その時点の熟練係数を返す */
  private work(r: Resident, skill: SkillId, dt: number): number {
    r.skills[skill] = practice(r.skills[skill], dt);
    return skillFactor(r.skills[skill]);
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
    const key = `craft_${skill}`;
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
    if (place.capacity && this.occupants(place, r) >= place.capacity) {
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

  // ───────────── 出会いと会話 ─────────────

  private tryIndoorEncounter(r: Resident, place: Place) {
    if (r.action === 'sleep') return;
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
        if (a.action === 'visit' || b.action === 'visit') continue; // 会いに行く途中の人は approach で話しかける
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
    };
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
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
      r.state = r.path.length > 0 ? 'walking' : 'idle';
      r.idleUntil = this.clock.minutes + randInt(this.rng, 3, 15);
    }
    // 片方が亡くなっていたら、記憶や関係は更新しない
    if (conv.outcome && this.residents.includes(conv.a) && this.residents.includes(conv.b)) {
      this.applyOutcome(conv, conv.outcome);
      for (const ag of conv.outcome.agreements) this.carryOut(conv, ag);
    }
    this.events.emit('conversationEnd', conv);
  }

  private applyOutcome(conv: Conversation, outcome: ConversationOutcome) {
    const changes: string[] = [];
    for (const ref of outcome.reflections) {
      const self = ref.residentId === conv.a.profile.id ? conv.a : conv.b;
      const other = self === conv.a ? conv.b : conv.a;
      if (ref.memory) this.remember(self, ref.memory);
      const rel = self.relations[other.profile.id] ?? defaultRelation();
      rel.affinity = Math.max(-100, Math.min(100, rel.affinity + ref.affinityDelta));
      if (ref.impression) rel.impression = ref.impression;
      self.relations[other.profile.id] = rel;
      const sign = ref.affinityDelta > 0 ? '+' : '';
      changes.push(`${self.profile.name}→${other.profile.name} ♥${sign}${ref.affinityDelta}`);
    }
    this.log(`${outcome.summary}（${changes.join(' / ')}）`, 'summary', { conversationId: conv.id });
  }

  /** 会話で決まったことを実行する。できなければ「果たせなかった」として残る */
  private carryOut(conv: Conversation, ag: Agreement) {
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
        const what = `${A}が${B}に${itemName}${qty}個を${money}Gで売る`;
        if (!ag.item || qty <= 0) return;
        if (countItem(from.inventory, ag.item) < qty) return fail(what, `${A}の${itemName}が足りなかった`);
        if (to.money < money) return fail(what, `${B}のお金が足りなかった`);
        moveItems(from.inventory, to.inventory, ag.item, qty, this.clock.minutes);
        moveMoney(to, from, money);
        addCount(from.today.sold, ag.item, qty);
        addCount(to.today.bought, ag.item, qty);
        const m = (this.market.today.sold[ag.item] ??= { qty: 0, revenue: 0 });
        m.qty += qty;
        m.revenue += money;
        this.log(`${A}が${B}に${itemName}${qty}個を${money}Gで売った`, 'deal');
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
        this.log(`${A}が${B}に${parts.join('と')}をあげた`, 'deal');
        this.feel(to, from, 6, `${this.clock.day}日目、${parts.join('と')}を分けてくれた`);
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
  cook: ['meal'],
};

function usedSkill(stats: DayStats, skill: SkillId): boolean {
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

import { WAKE_AT } from '../world/residents';
import type { Simulation } from '../world/sim';
import type { OllamaClient } from './llm';
import {
  buildCrisisMessages,
  buildPlanMessages,
  buildSelfImageMessages,
  crisisSchema,
  parseCrisis,
  parsePlan,
  parseSelfImage,
  planReview,
  planSchema,
  selfImageSchema,
  type RawCrisis,
  type RawPlan,
} from './planning';

const ACTION_LABELS: Partial<Record<string, string>> = {
  beg: '広場で施しを求める',
  buy: '市場で食べ物を買う',
  farm: '畑で食べ物を採る',
  fish: '川で魚を釣る',
  bake: '小麦でパンを焼く',
  rest: '何もしない',
};

/** 夜明け前に、計画を待つ現実の秒数の上限（超えたらルールの計画で朝を迎える） */
const MAX_DAWN_WAIT_SECONDS = 240;
/** 自己像を見つめ直す間隔（日） */
const SELF_IMAGE_EVERY = 3;
/** 同じ人の危機の判断をAIに頼む間隔（分）。そのあいだはルールで動く */
const CRISIS_INTERVAL = 180;

interface Job {
  kind: 'plan' | 'self' | 'crisis';
  residentId: string;
  /** plan なら計画の対象日 */
  day: number;
}

/**
 * 住民の「人生の判断」をLLMに頼む係。
 * 夜21時になったら全員の翌日の計画を、数日おきの昼下がりに自己像を考えさせる。
 * 朝までに間に合わなければ夜明け前で時計を止めて待つ。
 */
export class LifePlanner {
  lastError: string | null = null;
  private queue: Job[] = [];
  private running: Job[] = [];
  private progress = { day: 0, total: 0, done: 0 };
  private dawnWaitStartedAt: number | null = null;
  private readonly lastCrisis = new Map<string, number>();

  constructor(
    private readonly sim: Simulation,
    private readonly llm: OllamaClient,
  ) {
    sim.events.on('evening', ({ day }) => this.onEvening(day));
    sim.dawnHold = () => this.shouldHoldDawn();
    // 夜の計画づくりを優先する（そのあいだの出会いはあいさつで済ませる）
    const gate = sim.conversationGate;
    sim.conversationGate = (a, b) => (this.planning ? 'greeting' : gate(a, b));
    // 飢えかけた人の判断は、ほかの仕事より先に考える
    sim.crisisHandler = (r) => {
      if (this.llm.status !== 'ready') return false;
      if (this.queue.some((j) => j.kind === 'crisis' && j.residentId === r.profile.id)) return true;
      // 何度も頼むとAIが会話に回らなくなるので、同じ人は数時間おきに（あいだはルールで動く）
      const last = this.lastCrisis.get(r.profile.id);
      if (last !== undefined && sim.clock.minutes - last < CRISIS_INTERVAL) return false;
      this.lastCrisis.set(r.profile.id, sim.clock.minutes);
      this.queue.unshift({ kind: 'crisis', residentId: r.profile.id, day: sim.clock.day });
      return true;
    };
  }

  get busy(): boolean {
    return this.running.length > 0 || this.queue.length > 0;
  }

  private get planning(): boolean {
    return [...this.queue, ...this.running].some((j) => j.kind === 'plan');
  }

  /** ヘッダーに出す進み具合（何もしていなければ null） */
  status(): string | null {
    if (!this.busy) return null;
    if (!this.planning) {
      return [...this.queue, ...this.running].some((j) => j.kind === 'self') ? 'みんなが自分を見つめ直している' : null;
    }
    return `みんなが明日の計画を考えている（${this.progress.done}/${this.progress.total}）`;
  }

  /** 毎フレーム呼ぶ。LLMに空きがあれば次の仕事を始める（同じ人の仕事は順番に） */
  tick(): void {
    this.dropStale();
    // 昼間は1件まで（もう1枠は会話に空けておく）。夜は会話がないので空きを全部使う
    const h = this.sim.clock.hourOfDay;
    const daytime = h >= WAKE_AT && h < 21;
    while (this.llm.status === 'ready' && !this.llm.busy && (!daytime || this.running.length < 1)) {
      const i = this.queue.findIndex(
        (job, idx) =>
          !this.running.some((j) => j.residentId === job.residentId) &&
          !this.queue.slice(0, idx).some((j) => j.residentId === job.residentId),
      );
      if (i < 0) return;
      const [job] = this.queue.splice(i, 1);
      this.running.push(job);
      void this.run(job).finally(() => {
        this.running = this.running.filter((j) => j !== job);
      });
    }
  }

  private onEvening(day: number) {
    if (this.llm.status !== 'ready') return;
    // 朝までに間に合わないと残りはルールの計画になるので、前の晩に間に合わなかった人
    // （新しく来た人を含む）から先に考える。あとは毎晩順番を回して、いつも同じ人が後回しにならないようにする
    const n = this.sim.residents.length;
    const order = this.sim.residents
      .map((r, i) => ({ r, late: r.plan?.source === 'ai' ? 1 : 0, turn: (i + day) % Math.max(1, n) }))
      .sort((a, b) => a.late - b.late || a.turn - b.turn);
    const planJobs: Job[] = order.map(({ r }) => ({ kind: 'plan', residentId: r.profile.id, day: day + 1 }));
    this.queue.push(...planJobs);
    this.progress = { day: day + 1, total: planJobs.length, done: 0 };
    // 自己像の見つめ直しは、計画のあと夜のうちに（昼間のAIは会話に回したいので）
    if (day % SELF_IMAGE_EVERY === 2) {
      this.queue.push(...this.sim.residents.map((r): Job => ({ kind: 'self', residentId: r.profile.id, day })));
    }
  }

  private async run(job: Job) {
    const r = this.sim.get(job.residentId);
    if (!r) return;
    try {
      if (job.kind === 'plan') {
        const messages = buildPlanMessages(this.sim, r, job.day);
        const raw = await this.llm.chatJSON<RawPlan>(messages, planSchema());
        let plan = parsePlan(raw, job.day, r, this.sim);
        // 食べ物の見込みが足りなければ、その事実を見せてもう一度だけ考えてもらう
        const review = plan && planReview(this.sim, r, plan);
        if (review) {
          const again = await this.llm.chatJSON<RawPlan>(
            [...messages, { role: 'assistant', content: JSON.stringify(raw) }, { role: 'user', content: review }],
            planSchema(),
          );
          plan = parsePlan(again, job.day, r, this.sim) ?? plan;
        }
        if (plan) this.sim.setNextPlan(r, plan);
        this.progress.done++;
      } else if (job.kind === 'crisis') {
        const raw = await this.llm.chatJSON<RawCrisis>(buildCrisisMessages(this.sim, r), crisisSchema);
        const c = parseCrisis(raw, r, this.sim);
        const minutes = c.target ? 120 : c.action === 'buy' ? 60 : 90;
        this.sim.setOverride(r, { action: c.action, target: c.target, purpose: c.purpose, minutes });
        const who = c.target ? this.sim.get(c.target)?.profile.name : '';
        const what =
          c.action === 'visit'
            ? `${who}に会いに行くことにした（${c.purpose}）`
            : c.action === 'steal'
              ? `${who}から食べ物を盗むことにした`
              : c.action === 'rob'
                ? `${who}から食べ物を力ずくで奪うことにした`
                : `${ACTION_LABELS[c.action]}ことにした`;
        this.sim.log(`${r.profile.name}は飢えに追い詰められ、${what}${c.thought ? `「${c.thought}」` : ''}`, 'life');
        if (c.thought) this.sim.remember(r, `飢えに追い詰められて思ったこと：「${c.thought}」`);
      } else {
        const raw = await this.llm.chatJSON<{ self_image?: string }>(
          buildSelfImageMessages(this.sim, r),
          selfImageSchema,
        );
        const text = parseSelfImage(raw);
        if (text) this.sim.setSelfImage(r, text);
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[lifePlanner]', e);
      if (job.kind === 'plan') this.progress.done++;
    }
  }

  /** もう朝を迎えてしまった日の計画は、考えても使われないので捨てる */
  private dropStale() {
    const { day, hourOfDay } = this.sim.clock;
    this.queue = this.queue.filter((j) => j.kind !== 'plan' || j.day > day || (j.day === day && hourOfDay < WAKE_AT));
  }

  private shouldHoldDawn(): boolean {
    const pending = this.queue.some((j) => j.kind === 'plan') || this.running.some((j) => j.kind === 'plan');
    if (!pending || this.llm.status !== 'ready') {
      this.dawnWaitStartedAt = null;
      return false;
    }
    const now = performance.now();
    this.dawnWaitStartedAt ??= now;
    if (now - this.dawnWaitStartedAt > MAX_DAWN_WAIT_SECONDS * 1000) {
      // 待ちすぎ：残りはルールの計画で朝を迎える
      this.queue = this.queue.filter((j) => j.kind !== 'plan');
      this.dawnWaitStartedAt = null;
      return false;
    }
    return true;
  }
}

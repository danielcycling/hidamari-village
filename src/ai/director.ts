import type { ItemId } from '../world/economy';
import { WORK_ACTIONS, type WorkAction } from '../world/planner';
import type {
  Agreement,
  AgreementType,
  Conversation,
  ConversationOutcome,
  DialogueLine,
  Reflection,
  Simulation,
} from '../world/sim';
import type { OllamaClient } from './llm';
import {
  AGREEMENT_TYPES,
  buildAgreementMessages,
  buildAgreementSchema,
  buildMessages,
  buildSchema,
  MAX_LINE_CHARS,
  type ConversationContext,
  type RawAgreement,
  type RawConversation,
} from './prompt';
import { ITEM_IDS, ITEMS } from '../world/economy';

/** 未接続のときに再接続を試みる間隔（ミリ秒） */
const RECONNECT_INTERVAL = 15_000;

/**
 * 出会いをAIに渡して会話を作らせる係。
 * ローカルLLMは一度に1件しかさばけないので、考えている間の出会いはあいさつで済ませる。
 */
export class ConversationDirector {
  lastError: string | null = null;

  constructor(
    private readonly sim: Simulation,
    private readonly llm: OllamaClient,
  ) {
    sim.conversationGate = () => (this.llm.status === 'ready' && !this.llm.busy ? 'ai' : 'greeting');
    sim.events.on('encounter', (conv) => void this.compose(conv));
  }

  async start(requestedModel: string | null): Promise<void> {
    await this.llm.connect(requestedModel);
    setInterval(() => {
      if (this.llm.status === 'offline') void this.llm.connect(this.llm.model ?? requestedModel);
    }, RECONNECT_INTERVAL);
  }

  private async compose(conv: Conversation) {
    try {
      const ctx: ConversationContext = {
        a: conv.a,
        b: conv.b,
        placeName: conv.placeName,
        dateTime: this.sim.clock.format(),
        hour: this.sim.clock.hourOfDay,
        weather: this.sim.describeWeather('now'),
        news: this.sim.recentNews().slice(-5).map((n) => `${n.day}日目 ${n.time}: ${n.text}`),
        sim: this.sim,
        purpose: conv.purpose,
      };
      const raw = await this.llm.chatJSON<RawConversation>(buildMessages(ctx), buildSchema(ctx));
      const parsed = parse(conv, raw);
      if (!parsed) throw new Error('AIの返事を会話として読み取れなかった');
      this.lastError = null;
      this.sim.setDialogue(conv, parsed.lines, parsed.outcome);
      // 会話を流しているあいだに、決まったことを別に書き出す（7Bは1回で両方やると取りこぼす）。
      // ただの世間話なら書き出すことがないので、AIを呼ばずに済ませる
      if (needsRecorder(conv, raw, this.sim)) void this.extractAgreements(conv, ctx, raw);
      else {
        // 演じる側は好感度を甘くつけがちなので、記録係を通さないときは控えめにする
        for (const ref of parsed.outcome.reflections) ref.affinityDelta = Math.trunc(ref.affinityDelta / 2);
        this.sim.addAgreements(conv, []);
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[director]', e);
      this.sim.fallbackToGreeting(conv);
    }
  }

  private async extractAgreements(conv: Conversation, ctx: ConversationContext, raw: RawConversation) {
    try {
      const lines = (raw.lines ?? []).map((l) => ({ speaker: l.speaker, text: clean(l.text, MAX_LINE_CHARS + 20) }));
      const res = await this.llm.chatJSON<{
        agreements?: RawAgreement[];
        disclosures?: { deed: number; from: string; to: string }[];
        feelings?: Record<string, { change?: number; reason?: string }>;
      }>(buildAgreementMessages(ctx, lines, clean(raw.summary, 80)), buildAgreementSchema(ctx));
      this.sim.addAgreements(conv, parseAgreements(conv, res.agreements ?? [], lines.map((l) => l.text)));
      const byName = new Map([conv.a, conv.b].map((r) => [r.profile.name, r.profile.id]));
      // 相手への気持ちは、会話を演じたAIではなく記録係が判定する（演じる側は仲良くまとめがちなので）
      this.sim.addFeelings(
        conv,
        [conv.a, conv.b].flatMap((self) => {
          const other = self === conv.a ? conv.b : conv.a;
          const f = res.feelings?.[self.profile.name];
          if (!f) return [];
          const delta = Math.max(-15, Math.min(15, Math.round(Number(f.change) || 0)));
          const reason = clean(f.reason, 40);
          return [{ fromId: self.profile.id, toId: other.profile.id, delta, reason: hasForeignWords(reason) ? '' : reason }];
        }),
      );
      // 非行のことを話したか（番号がセリフに出ていなくても、話した中身で記録係が判断する）
      this.sim.addDisclosures(
        conv,
        (res.disclosures ?? []).flatMap((x) => {
          const fromId = byName.get(x.from);
          const toId = byName.get(x.to);
          return fromId && toId && fromId !== toId ? [{ deedId: Number(x.deed), fromId, toId }] : [];
        }),
      );
    } catch (e) {
      console.warn('[director] agreements', e);
    }
  }
}

/** AIの出力を検証し、村で使える形に直す。使えなければ null */
function parse(
  conv: Conversation,
  raw: RawConversation,
): { lines: DialogueLine[]; outcome: ConversationOutcome } | null {
  const byName = new Map([conv.a, conv.b].map((r) => [r.profile.name, r.profile.id]));
  // 7Bモデルはときどき英語などを混ぜるので、そういう行は捨てる
  const lines = (raw.lines ?? [])
    .map((l) => ({ speakerId: byName.get(l.speaker) ?? '', text: clean(l.text, MAX_LINE_CHARS + 20) }))
    .filter((l) => l.speakerId && l.text && !hasForeignWords(l.text));
  if (lines.length < 2) return null;

  const reflections: Reflection[] = [];
  for (const r of [conv.a, conv.b]) {
    const ref = raw.reflections?.[r.profile.name];
    if (!ref) continue;
    const memory = clean(ref.memory, 80);
    const impression = clean(ref.impression, 24);
    reflections.push({
      residentId: r.profile.id,
      memory: hasForeignWords(memory) ? '' : memory,
      affinityDelta: Math.max(-15, Math.min(15, Math.round(Number(ref.affinity_change) || 0))),
      impression: hasForeignWords(impression) ? '' : impression,
    });
  }
  const summary = clean(raw.summary, 80);
  return {
    lines,
    outcome: {
      agreements: [],
      summary: summary && !hasForeignWords(summary) ? summary : `${conv.a.profile.name}と${conv.b.profile.name}は少し話をした`,
      reflections,
    },
  };
}

/** 物・お金・約束・非行の話が出たか（出ていなければ、記録係に書き出してもらうことはない） */
const DEAL_WORDS = /あげ|もら|分け|譲|売|買|貸|借|返|払|代金|雇|給料|教え|約束|黙|内緒|秘密|盗|奪|殴|殺|見た|聞いた|お金|[0-9０-９]+\s*[G個円]|パン|魚|野菜|小麦|定食/;

function needsRecorder(conv: Conversation, raw: RawConversation, sim: Simulation): boolean {
  if (conv.purpose) return true;
  if ([conv.a, conv.b].some((r) => sim.deedsBy(r).length > 0 || sim.deedsKnownBy(r).length > 0)) return true;
  const text = [...(raw.lines ?? []).map((l) => l.text), raw.summary].join(' ');
  return DEAL_WORDS.test(text);
}

/** 書き出された取り決めを検証する（同じものが重ねて出たら1つにまとめる） */
function parseAgreements(conv: Conversation, raw: RawAgreement[], spoken: string[]): Agreement[] {
  const byName = new Map([conv.a, conv.b].map((r) => [r.profile.name, r.profile.id]));
  const agreements = raw.filter((ag) => grounded(ag, spoken)).flatMap((ag): Agreement[] => {
    const fromId = byName.get(ag.from);
    const toId = byName.get(ag.to);
    if (!fromId || !toId || fromId === toId || !AGREEMENT_TYPES.includes(ag.type as AgreementType)) return [];
    const item = ITEM_IDS.includes(ag.item as ItemId) ? (ag.item as ItemId) : undefined;
    const work = WORK_ACTIONS.includes(ag.work as WorkAction) ? (ag.work as WorkAction) : undefined;
    const text = clean(ag.text, 60);
    return [
      {
        type: ag.type as AgreementType,
        fromId,
        toId,
        item,
        qty: Number(ag.qty) || 0,
        money: Number(ag.money) || 0,
        days: Number(ag.days) || undefined,
        action: work,
        text: hasForeignWords(text) ? '' : text,
      },
    ];
  });
  return agreements.filter((ag, i) => agreements.findIndex((o) => JSON.stringify(o) === JSON.stringify(ag)) === i);
}

/**
 * 書き出しが会話にもとづいているか。根拠のセリフが実際の会話にあり、
 * 品物ややりとりの中身がそのセリフに出てくるものだけを認める（記録係のでっち上げを防ぐ）
 */
function grounded(ag: RawAgreement, spoken: string[]): boolean {
  const quote = String(ag.quote ?? '').replace(/[「」『』\s]/g, '');
  if (quote.length < 4) return false;
  const norm = (t: string) => t.replace(/[「」『』\s]/g, '');
  // セリフの一部か、セリフを含んでいれば会話にあったとみなす（多少の言い換えは許す）
  const line = spoken.map(norm).find((t) => t.includes(quote.slice(0, 8)) || quote.includes(t.slice(0, 8)));
  if (!line) return false;
  const item = ITEM_IDS.includes(ag.item as ItemId) ? ITEMS[ag.item as ItemId].name : '';
  const ctx = `${quote}${line}`;
  if (['trade', 'gift'].includes(ag.type) && item && !ctx.includes(item)) return false;
  if (['loan', 'repay'].includes(ag.type) && !/\d|G|円|お金|金/.test(ctx)) return false;
  return true;
}

/** 4文字以上のアルファベットの並び（英単語など）が混ざっているか */
const hasForeignWords = (text: string) => /[A-Za-z]{4,}/.test(text);

function clean(text: unknown, max: number): string {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[「『"]|[」』"]$/g, '')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

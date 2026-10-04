import { describeInventory, foodValue, ITEM_IDS, ITEMS, SKILL_IDS, SKILLS } from '../world/economy';
import { ACTIONS, DAILY_NEED, WORK_ACTIONS } from '../world/planner';
import { deedStory, HOME_LEVEL_NAMES, lootText, satisfactionLabel, type Deed, type Resident, type Simulation } from '../world/sim';
import type { ChatMessage } from './llm';
import { topicNotice } from './topics';

export const MIN_LINES = 4;
export const MAX_LINES = 8;
export const MAX_LINE_CHARS = 40;
const RECENT_MEMORIES = 8;

export interface ConversationContext {
  a: Resident;
  b: Resident;
  placeName: string;
  dateTime: string;
  hour: number;
  weather: string;
  /** 村の最近の出来事（村人みんなが知っている） */
  news: string[];
  sim: Simulation;
  /** 会いに来た側（a）の目的 */
  purpose?: string;
}

export interface RawConversation {
  lines: { speaker: string; text: string }[];
  summary: string;
  reflections: Record<string, { memory: string; affinity_change: number; impression: string }>;
  agreements?: RawAgreement[];
}

export interface RawAgreement {
  type: string;
  from: string;
  to: string;
  item?: string;
  qty?: number;
  money?: number;
  days?: number;
  work?: string;
  text?: string;
  /** 根拠になったセリフ（そのまま抜き出す） */
  quote?: string;
}

export const AGREEMENT_TYPES = ['trade', 'gift', 'loan', 'repay', 'hire', 'quit', 'teach', 'promise', 'hush'] as const;

// ───────────── 隠していること・知っていること ─────────────

const DEED_TEXT: Record<Deed['kind'], (d: Deed) => string> = {
  steal: (d) => (d.success ? `${d.victimName}から${loot(d)}をこっそり盗んだ` : `${d.victimName}から盗もうとした`),
  rob: (d) => (d.success && loot(d) ? `${d.victimName}から${loot(d)}を力ずくで奪った` : `${d.victimName}から力ずくで奪おうとした`),
  attack: (d) => `${d.victimName}を殴った`,
  kill: (d) => (d.success ? `${d.victimName}を殺し${loot(d) ? `、${loot(d)}を奪った` : 'た'}` : `${d.victimName}を殺そうとした`),
  loot: (d) => `${d.victimName}の空き家から遺品${loot(d) ? `（${loot(d)}）` : ''}を持ち出した`,
};

const loot = (d: Deed) => lootText(d);

/** 自分がしたこと（隠していること）。番号つき */
export function secretsOf(sim: Simulation, r: Resident): string[] {
  return sim.deedsBy(r).slice(-5).map((d) => {
    const seen = d.actorSawWitness.map((id) => sim.get(id)?.profile.name).filter(Boolean);
    const hushed = d.hushed.map((id) => sim.get(id)?.profile.name).filter(Boolean);
    const known = d.public
      ? '村じゅうに知れわたっている'
      : seen.length
        ? `${seen.join('、')}に見られた`
        : '誰にも見られていないと思う';
    return `[#${d.id}] ${d.day}日目 ${d.time} ${d.placeName}で${DEED_TEXT[d.kind](d)}（${known}${hushed.length ? `。${hushed.join('、')}は黙ると約束した` : ''}）`;
  });
}

/** 人がしたことで、自分が知っていること。番号つき */
export function knowledgeOf(sim: Simulation, r: Resident): string[] {
  return sim.deedsKnownBy(r).slice(-5).map((d) => {
    const how = d.knownBy[r.profile.id];
    // 人から聞いた話は、本人が聞いたとおり（犯人や量が本当と違うこともある）
    const v = sim.versionOf(d, r.profile.id);
    const act = how === 'heard' ? `${v.actorName}が${deedStory(d, v)}` : `${d.actorName}が${DEED_TEXT[d.kind](d)}`;
    const text =
      how === 'victim'
        ? `${d.actorName}にやられた：${act}`
        : how === 'saw'
          ? `自分の目で見た：${act}`
          : `人から聞いた：${act}`;
    const promised = d.hushed.includes(r.profile.id) ? '（黙っていると約束した）' : '';
    return `[#${d.id}] ${d.day}日目 ${d.placeName}。${text}${d.public ? '（村じゅうが知っている）' : ''}${promised}`;
  });
}

const SYSTEM_PROMPT = `あなたは小さな村「ひだまり村」の観察記録係です。
村人2人がばったり出会った場面の会話を書いてください。

## この村について
- 村人はみな、自分の力で食べ物を手に入れて暮らしている。食べられなければ死ぬ。
- 畑（小麦・野菜）、釣り場（魚）、パン焼き小屋（小麦→パン）、食堂（野菜と魚→定食）、市場（広場）がある。設備は誰のものでもない。
- お金は村の中を巡るだけで、勝手には増えない。

## ルール
- 会話は${MIN_LINES}〜${MAX_LINES}行。1行は${MAX_LINE_CHARS}文字以内の話し言葉。
- 人物には決まった性格・年齢・性別・仕事はない。書かれている「自己像」「状態」「記憶」「相手への気持ち」だけを手がかりに、その人らしく話させる。書かれていないこと（家族、過去、職業）を作らない。
- 持ち物・所持金・腕前は書かれているとおりに扱い、取り違えない。
- 空腹な人は食べ物のことで頭がいっぱいになりやすい。困っている人は助けを求めたり、取引を持ちかけたりしてよい。
- 記憶にある出来事や噂は積極的に話題にする。聞いた噂を別の人に話してしまうこともある。
- あいさつや天気の話だけで終わらせない。相談、取引の話、頼みごと、からかい、口論など、少しでも関係が動くようにする。
- 無理に仲良くさせない。人物の状況や記憶に理由があれば、不満・嫉妬・恨み・怒り・軽蔑も自然に出してよい。反対に、理由がないのに対立させる必要もない。
- 好感度は会話の内容に応じて -15〜+15 の範囲で変える。上がることも下がることも同じくらい普通にある。
- 持っていない物やお金は渡せない。やりとりは、それぞれが持っている範囲でしか決まらない。
- 腕前を教わるには、教わる側が教える側に代金を払う。腕前は財産なので、安くはない（上手な人ほど高く求めてよい）。
- セリフ・summary・memory・impression は**すべて自然な日本語**で書く。英語や他の言語の単語を混ぜない。
- 出力は指定のJSONのみ。`;

function timeOfDay(hour: number): string {
  if (hour >= 4 && hour < 10) return '朝';
  if (hour >= 10 && hour < 16) return '昼';
  if (hour >= 16 && hour < 19) return '夕方';
  return '夜';
}

export function affinityLabel(affinity: number): string {
  if (affinity >= 60) return '大好き';
  if (affinity >= 30) return '好き';
  if (affinity >= 10) return '好感';
  if (affinity > -10) return 'ふつう';
  if (affinity > -30) return '苦手';
  return '嫌い';
}

export function hungerLabel(satiety: number): string {
  if (satiety <= 0) return '飢えている';
  if (satiety < 30) return '空腹';
  if (satiety < 60) return '少しお腹が空いている';
  return '満腹';
}

/** いちばん上達している技能（なければ「特になし」） */
export function bestSkills(r: Resident): string {
  const good = SKILL_IDS.filter((s) => r.skills[s] >= 10)
    .sort((a, b) => r.skills[b] - r.skills[a])
    .map((s) => `${SKILLS[s]}${Math.round(r.skills[s])}`);
  return good.length > 0 ? good.join('・') : '特になし（何をやっても素人）';
}

/** 相手について、見て分かること・二人の間にあること */
function between(sim: Simulation, self: Resident, other: Resident): string[] {
  const lines: string[] = [];
  const looks = other.satiety <= 0 ? 'ひどくやつれている' : other.satiety < 30 ? '腹を空かせているようだ' : '元気そうだ';
  const carrying =
    foodValue(other.inventory) >= DAILY_NEED * 2 ? '、食べ物をたくさん抱えている' : foodValue(other.inventory) === 0 ? '、食べ物は何も持っていないようだ' : '';
  lines.push(`${other.profile.name}の様子: ${looks}${carrying}。今は${other.activity || '特に何もしていない'}`);
  const iOwe = sim.owed(self, other);
  const theyOwe = sim.owed(other, self);
  if (iOwe > 0) lines.push(`${other.profile.name}に${iOwe}Gの借りがある`);
  if (theyOwe > 0) lines.push(`${other.profile.name}に${theyOwe}G貸している`);
  const myJob = sim.employmentOf(self);
  const theirJob = sim.employmentOf(other);
  if (myJob?.employerId === other.profile.id) lines.push(`${other.profile.name}に日給${myJob.wage}Gで雇われている`);
  if (theirJob?.employerId === self.profile.id) lines.push(`${other.profile.name}を日給${theirJob.wage}Gで雇っている`);
  const notes = self.relations[other.profile.id]?.notes ?? [];
  if (notes.length > 0) lines.push(`${other.profile.name}への気持ちの理由: ${notes.slice(0, 3).map((n) => n.text).join('／')}`);
  return lines;
}

const section = (title: string, lines: string[]) => (lines.length ? [`${title}:`, ...lines.map((l) => `- ${l}`)] : []);

function describe(sim: Simulation, self: Resident, other: Resident): string {
  const p = self.profile;
  const rel = self.relations[other.profile.id];
  const memories = self.memories.slice(-RECENT_MEMORIES);
  return [
    `【${p.name}】`,
    `自己像: ${self.selfImage || 'まだ自分がどんな人間なのか、よく分かっていない'}`,
    ...(self.wish ? [`望み: ${self.wish}`] : []),
    `名乗っている仕事: ${self.occupation || 'なし'}`,
    `状態: ${hungerLabel(self.satiety)}、体力${Math.round(self.health)}、所持金${self.money}G`,
    `持ち物: ${describeInventory(self.inventory)}`,
    `腕前（0〜100）: ${bestSkills(self)}`,
    `今していること: ${self.activity}`,
    `家: ${HOME_LEVEL_NAMES[self.homeLevel ?? 0]}、暮らしの満足: ${satisfactionLabel(self.satisfaction ?? 50)}${self.satisfactionNotes?.length ? `（${self.satisfactionNotes.slice(0, 2).join('・')}）` : ''}`,
    `${other.profile.name}への気持ち: 好感度 ${rel.affinity}（${affinityLabel(rel.affinity)}）／印象「${rel.impression}」`,
    ...between(sim, self, other),
    ...section(
      '自分がしたことで、隠していること（話すかどうかは自分しだい。話せば相手は恨むかもしれないし、ほかの人に広めるかもしれない。村に知れれば集会で罰を受けることもある。黙っていれば、知られずに済むかもしれない）',
      secretsOf(sim, self),
    ),
    ...section('人のしたことで、知っていること（話すかどうかは自分しだい）', knowledgeOf(sim, self)),
    ...(sim.temptationOf(self) ? [`心の奥でくすぶっている考え（口に出すかどうかは自分しだい）: 「${sim.temptationOf(self)}」`] : []),
    `最近の記憶:`,
    ...(memories.length > 0 ? memories.map((m) => `- ${m.day}日目 ${m.time}: ${m.text}`) : ['- 特になし']),
    ...[topicNotice(memories.map((m) => m.text))].filter(Boolean),
  ].join('\n');
}

export function buildMessages(ctx: ConversationContext): ChatMessage[] {
  const { a, b } = ctx;
  const user = [
    `日時: ${ctx.dateTime}（${timeOfDay(ctx.hour)}）　天気: ${ctx.weather}`,
    `場所: ${ctx.placeName}`,
    ...(ctx.sim.laws.length ? [`村の決まり: ${ctx.sim.laws.map((l) => `「${l.title}」`).join('、')}`] : []),
    `村の最近の出来事（みんな知っている）:`,
    ...(ctx.news.length > 0 ? ctx.news.map((n) => `- ${n}`) : ['- 特になし']),
    '',
    describe(ctx.sim, a, b),
    '',
    describe(ctx.sim, b, a),
    '',
    ctx.purpose
      ? `${a.profile.name}は「${ctx.purpose}」という用で${b.profile.name}に会いに来た。最初に話しかけるのは${a.profile.name}です。`
      : `最初に話しかけるのは${a.profile.name}です。`,
    `summary には会話で何が起きたかを1文で書く。`,
    `reflections には、それぞれの人物がこの会話から覚えておくこと（memory。新しく知ったこと・約束・噂・感じたことを具体的に。相手の職業など分かりきったことは書かない）、相手への好感度の変化（affinity_change）、相手への今の印象（impression、20文字以内）を書く。`,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Ollama の構造化出力に渡す JSON スキーマ */
export function buildSchema(ctx: ConversationContext): object {
  const names = [ctx.a.profile.name, ctx.b.profile.name];
  const reflection = {
    type: 'object',
    properties: {
      memory: { type: 'string' },
      affinity_change: { type: 'integer', minimum: -15, maximum: 15 },
      impression: { type: 'string' },
    },
    required: ['memory', 'affinity_change', 'impression'],
  };
  return {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        minItems: MIN_LINES,
        maxItems: MAX_LINES,
        items: {
          type: 'object',
          properties: {
            speaker: { type: 'string', enum: names },
            text: { type: 'string' },
          },
          required: ['speaker', 'text'],
        },
      },
      summary: { type: 'string' },
      reflections: {
        type: 'object',
        properties: Object.fromEntries(names.map((n) => [n, reflection])),
        required: names,
      },
    },
    required: ['lines', 'summary', 'reflections'],
  };
}

// ───────────── 会話で決まったことの書き出し ─────────────

const AGREEMENT_SYSTEM = `あなたは村の記録係です。村人2人の会話を読んで、その場で実際にまとまったやりとりだけを書き出します。
- 2人ともはっきり同意したものだけを書く。持ちかけただけ・断られた・「考えておく」で終わったものは書かない。
- 会話の中で物を「もらう」「分けてもらう」「借りる」と決まったら gift（品物）。あとで返す約束もしていれば、それは promise として別に書く。
- お金の貸し借りは loan、借りたお金を返すのは repay。代金を払って物を受け取るのは trade。
- 「手伝う」「明日〜する」のような、その場では何も動かない約束は promise。
- 誰かに、自分のしたことを黙っていてもらう約束がまとまったら hush（from=黙っていてほしい人、to=黙ると約束した人。口止め料があれば item・qty・money）。
- feelings には、それぞれの人物がこの会話のあと相手をどう感じたか（change は -15〜+15）と、その理由（reason、30文字以内）を書く。言葉が丁寧でも、頼みを断られた・損をさせられた・約束を破られた・見下された・相手だけが得をしたなら下がる。実際に助けられた・得をしたなら上がる。何も起きなければ 0。2人の状況（飢えているか、持っているか）も踏まえて、人間らしく冷静に判断する。
- disclosures には、会話の中で番号つきの出来事（[#番号]）について相手に話したものを書く（deed=番号、from=話した人、to=聞いた人）。ほのめかしただけ・話さなかったものは書かない。
- 持っていない物やお金は渡せない。持ち物と所持金をよく見る。
- まとめに「分けた」「渡した」「売った」などと書かれているのに対応するやりとりがあれば、それも必ず書き出す（品物と数はセリフかまとめから）。
- quote には、そのやりとりが決まった根拠のセリフ（またはまとめの文）を、そのまま抜き出す。品物の名前や数・金額が、会話の中で実際に言われていなければ書かない（数を自分で補わない）。
- 何もまとまっていなければ、agreements は空の配列にする。
- text は日本語で書く。出力はJSONのみ。`;

export function buildAgreementMessages(
  ctx: ConversationContext,
  lines: { speaker: string; text: string }[],
  summary: string,
): ChatMessage[] {
  const who = (r: Resident) =>
    `${r.profile.name}: 所持金${r.money}G、持ち物 ${describeInventory(r.inventory)}、腕前 ${SKILL_IDS.map((s) => `${SKILLS[s]}${Math.round(r.skills[s])}`).join('・')}`;
  const deeds = [ctx.a, ctx.b].flatMap((r) => [
    ...secretsOf(ctx.sim, r).map((l) => `${r.profile.name}がしたこと ${l}`),
    ...knowledgeOf(ctx.sim, r).map((l) => `${r.profile.name}が知っていること ${l}`),
  ]);
  const state = (r: Resident) =>
    `${r.profile.name}の状態: ${hungerLabel(r.satiety)}、体力${Math.round(r.health)}${foodValue(r.inventory) === 0 ? '、食べ物を何も持っていない' : ''}`;
  const user = [
    who(ctx.a),
    who(ctx.b),
    state(ctx.a),
    state(ctx.b),
    ...(ctx.purpose ? [`${ctx.a.profile.name}は「${ctx.purpose}」という用で会いに来た`] : []),
    ...(deeds.length ? ['', '番号つきの出来事:', ...deeds.map((d) => `- ${d}`)] : []),
    '',
    '会話:',
    ...lines.map((l) => `${l.speaker}「${l.text}」`),
    '',
    `まとめ: ${summary}`,
    '',
    `agreements の書き方: type は ${AGREEMENT_TYPES.join('/')}。trade は from=売る人・to=買う人・item・qty・money=代金の合計。gift は from=あげる人・to=もらう人・item と qty、または money。loan は from=貸す人・to=借りる人・money・days=返すまでの日数。repay は from=返す人・to=貸した人・money。hush は from=黙っていてほしい人・to=黙ると約束した人・口止め料があれば item・qty・money。hire は from=雇う人・to=雇われる人・work=仕事（${WORK_ACTIONS.map((w) => `${w}=${ACTIONS[w].label}`).join('、')}）・money=日給・days=日数。quit は from=辞める人・to=雇い主。teach は from=教える人・to=教わる人・work=教える仕事・money=教わる代金（その場で教える。教わる人は必ず代金を払う。教える人のほうが上手でないと効果はない）。promise は from=約束する人・to=相手・text=約束の中身。品物の item は ${ITEM_IDS.map((id) => `${id}=${ITEMS[id].name}`).join('、')}。`,
  ].join('\n');
  return [
    { role: 'system', content: AGREEMENT_SYSTEM },
    { role: 'user', content: user },
  ];
}

export function buildAgreementSchema(ctx: ConversationContext): object {
  const names = [ctx.a.profile.name, ctx.b.profile.name];
  return {
    type: 'object',
    properties: {
      agreements: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: AGREEMENT_TYPES },
            from: { type: 'string', enum: names },
            to: { type: 'string', enum: names },
            item: { type: 'string', enum: [...ITEM_IDS, ''] },
            qty: { type: 'integer', minimum: 0, maximum: 50 },
            money: { type: 'integer', minimum: 0, maximum: 10000 },
            days: { type: 'integer', minimum: 0, maximum: 14 },
            work: { type: 'string', enum: [...WORK_ACTIONS, ''] },
            text: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['type', 'quote', 'from', 'to'],
        },
      },
      feelings: {
        type: 'object',
        properties: Object.fromEntries(
          names.map((n) => [
            n,
            {
              type: 'object',
              properties: { change: { type: 'integer', minimum: -15, maximum: 15 }, reason: { type: 'string' } },
              required: ['change', 'reason'],
            },
          ]),
        ),
        required: names,
      },
      disclosures: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            deed: { type: 'integer' },
            from: { type: 'string', enum: names },
            to: { type: 'string', enum: names },
          },
          required: ['deed', 'from', 'to'],
        },
      },
    },
    required: ['agreements', 'feelings', 'disclosures'],
  };
}

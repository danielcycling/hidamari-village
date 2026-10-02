import type { Assembly, AssemblyResult, ProposalKind, Resident, Simulation } from '../world/sim';
import type { ChatMessage, OllamaClient } from './llm';
import { affinityLabel, hungerLabel, knowledgeOf, secretsOf } from './prompt';

const PROPOSAL_KINDS: ProposalKind[] = ['exile', 'fine', 'rule', 'repeal', 'none'];

const SYSTEM = `あなたは小さな村の集会の記録係です。村人全員が集会所に集まり、ある議題について話し合って多数決をとります。その様子を書きます。

## ルール
- 村人には決まった性格はない。それぞれの「自己像」「状態」「気持ち」「知っていること」「隠していること」だけを手がかりに、その人らしく話させ、投票させる。
- 各人が知っているのは、その人の欄に書かれていることだけ。ほかの人の欄の秘密や出来事を、その人は知らない。
- 自分の秘密がばれそうなら、話をそらす・黙る・別の人に矛先を向けることもありうる。
- 無理に全員一致にしない。好き嫌い・損得・恐れ・正義感で、賛否が割れるのは普通のこと。
- 話し合いの結果、提案を1つにまとめる。kind は次のどれか：
  - exile: target を村から追放する
  - fine: target に罰金（amount G）を科す。beneficiary は受け取る人（いなければ空。村のみんなで分ける）
  - rule: 村の決まりを作る（title に短い名前、text に中身）
  - repeal: 今ある決まりを廃止する（law_id に番号）
  - none: 提案はまとまらず、話し合いだけで終わる
- votes には出席者全員の賛否（yes が true なら賛成）と、その理由（20文字以内）を書く。none のときも、話し合いの流れに賛成かどうかで書く。
- speeches は、呼びかけた人から始めて、出席者のうち3〜6人が1回ずつ話す（1人40文字以内の話し言葉）。
- summary に、集会で何が起きたかを1文で書く。
- すべて自然な日本語で書く。出力はJSONのみ。`;

function personSection(sim: Simulation, r: Resident, a: Assembly): string {
  const rel = (id?: string) => {
    if (!id || id === r.profile.id) return '';
    const other = sim.get(id);
    const x = r.relations[id];
    if (!other || !x) return '';
    const why = x.notes?.length ? `（${x.notes[0].text}）` : '';
    return `${other.profile.name}への気持ち: ${affinityLabel(x.affinity)}（${x.affinity}）${why}`;
  };
  const secrets = secretsOf(sim, r);
  const known = knowledgeOf(sim, r);
  const memories = r.memories.slice(-4).map((m) => `${m.day}日目 ${m.text}`);
  return [
    `【${r.profile.name}】`,
    `自己像: ${r.selfImage || 'まだ自分がどんな人間なのか、よく分かっていない'}`,
    `状態: ${hungerLabel(r.satiety)}、体力${Math.round(r.health)}、所持金${r.money}G`,
    ...[rel(a.callerId), rel(a.targetId)].filter(Boolean),
    ...(known.length ? ['知っていること:', ...known.map((l) => `- ${l}`)] : []),
    ...(secrets.length ? ['隠していること（本人しか知らない）:', ...secrets.map((l) => `- ${l}`)] : []),
    ...(sim.temptationOf(r) ? [`心の奥でくすぶっている考え: 「${sim.temptationOf(r)}」`] : []),
    `最近の記憶: ${memories.join('／') || '特になし'}`,
  ].join('\n');
}

function buildMessages(sim: Simulation, a: Assembly, attendees: Resident[]): ChatMessage[] {
  const laws = sim.laws.map((l) => `- [#${l.id}] ${l.title}：${l.text}（${l.enactedDay}日目）`);
  const user = [
    `議題: 「${a.agenda}」`,
    `呼びかけた人: ${a.callerName}`,
    ...(a.targetName ? [`議題の相手: ${a.targetName}`] : []),
    '',
    '今ある村の決まり:',
    ...(laws.length ? laws : ['- まだない']),
    '',
    `村の最近の出来事: ${sim.recentNews().slice(-4).map((n) => n.text).join('／') || '特になし'}`,
    '',
    '出席者:',
    ...attendees.map((r) => personSection(sim, r, a)),
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

function schema(names: string[], lawIds: number[]): object {
  return {
    type: 'object',
    properties: {
      speeches: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: {
          type: 'object',
          properties: { speaker: { type: 'string', enum: names }, text: { type: 'string' } },
          required: ['speaker', 'text'],
        },
      },
      proposal: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: PROPOSAL_KINDS },
          target: { type: 'string', enum: [...names, ''] },
          amount: { type: 'integer', minimum: 0, maximum: 1000 },
          beneficiary: { type: 'string', enum: [...names, ''] },
          title: { type: 'string' },
          text: { type: 'string' },
          law_id: { type: 'integer', ...(lawIds.length ? { enum: lawIds } : {}) },
        },
        required: ['kind'],
      },
      votes: {
        type: 'array',
        minItems: names.length,
        maxItems: names.length,
        items: {
          type: 'object',
          properties: { voter: { type: 'string', enum: names }, yes: { type: 'boolean' }, reason: { type: 'string' } },
          required: ['voter', 'yes', 'reason'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['speeches', 'proposal', 'votes', 'summary'],
  };
}

interface RawAssembly {
  speeches?: { speaker: string; text: string }[];
  proposal?: {
    kind?: string;
    target?: string;
    amount?: number;
    beneficiary?: string;
    title?: string;
    text?: string;
    law_id?: number;
  };
  votes?: { voter: string; yes: boolean; reason: string }[];
  summary?: string;
}

const hasForeignWords = (text: string) => /[A-Za-z]{4,}/.test(text);
const clean = (text: unknown, max: number) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function parse(sim: Simulation, raw: RawAssembly, attendees: Resident[]): AssemblyResult | null {
  const byName = new Map(attendees.map((r) => [r.profile.name, r.profile.id]));
  const speeches = (raw.speeches ?? [])
    .map((s) => ({ speakerId: byName.get(s.speaker) ?? '', text: clean(s.text, 60) }))
    .filter((s) => s.speakerId && s.text && !hasForeignWords(s.text));
  // 1人1票（同じ人の票が重なったら最初のものだけ）
  const seen = new Set<string>();
  const votes = (raw.votes ?? []).flatMap((v) => {
    const id = byName.get(v.voter);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ voterId: id, yes: v.yes === true, reason: clean(v.reason, 30) }];
  });
  if (votes.length === 0) return null;
  const p = raw.proposal ?? {};
  let kind = (PROPOSAL_KINDS as string[]).includes(p.kind ?? '') ? (p.kind as ProposalKind) : 'none';
  const targetId = p.target ? byName.get(p.target) : undefined;
  if ((kind === 'exile' || kind === 'fine') && !targetId) kind = 'none';
  if (kind === 'repeal' && !sim.laws.some((l) => l.id === p.law_id)) kind = 'none';
  const title = clean(p.title, 20);
  const text = clean(p.text, 80);
  if (kind === 'rule' && (!title || hasForeignWords(title + text))) kind = 'none';
  const yes = votes.filter((v) => v.yes).length;
  // 出席者の過半数の賛成で可決
  const passed = kind !== 'none' && yes * 2 > attendees.length;
  return {
    speeches,
    proposal: {
      kind,
      targetId,
      amount: kind === 'fine' ? Math.max(1, Math.round(Number(p.amount) || 0)) : undefined,
      beneficiaryId: kind === 'fine' && p.beneficiary ? byName.get(p.beneficiary) : undefined,
      title: kind === 'rule' ? title : undefined,
      text: kind === 'rule' ? text : undefined,
      lawId: kind === 'repeal' ? p.law_id : undefined,
    },
    votes,
    passed,
    summary: clean(raw.summary, 100),
  };
}

/** 村の集会が始まったら、全員の発言と投票をAIに考えてもらう */
export class AssemblyDirector {
  lastError: string | null = null;

  constructor(
    private readonly sim: Simulation,
    private readonly llm: OllamaClient,
  ) {
    sim.events.on('assemblyStart', (a) => void this.deliberate(a));
  }

  private async deliberate(a: Assembly) {
    // 村を出ていく途中の人を除く、今いる全員が出席する
    const attendees = this.sim.residents.filter((r) => !r.leaving || r.profile.id === a.targetId);
    if (this.llm.status !== 'ready' || attendees.length < 2) {
      this.sim.concludeAssembly(a, null);
      return;
    }
    try {
      const names = attendees.map((r) => r.profile.name);
      const raw = await this.llm.chatJSON<RawAssembly>(
        buildMessages(this.sim, a, attendees),
        schema(
          names,
          this.sim.laws.map((l) => l.id),
        ),
        undefined,
        // 全員の投票まで書くので長めに
        1800,
      );
      this.sim.concludeAssembly(a, parse(this.sim, raw, attendees));
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[assembly]', e);
      this.sim.concludeAssembly(a, null);
    }
  }
}

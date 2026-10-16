import type { DiaryEntry, DiaryNote, LogEntry, Simulation } from '../world/sim';
import type { ChatMessage, OllamaClient } from './llm';
import { hungerLabel } from './prompt';

/** 日付が変わってから、この時刻に前の日の日記を書く（村人が寝ていて、AIが空いている時間） */
const WRITE_HOUR = 3;

const SYSTEM = `あなたは、小さな村「ひだまり村」を空の上から見守っている観察者です。毎晩、その日の村の出来事を「観察日記」に書きます。
- 観察者は何でも知っている。誰にも見られていない盗みや、隠していること、表の顔と裏の顔も、そのまま書いてよい（日記を読むのは観察者だけで、村人は読まない）。
- 書くのは、材料にある出来事だけ。材料にない出来事・セリフ・過去・家族を作らない。名前や数字を取り違えない。
- 出来事を並べるだけでなく、つながり（誰の何が、誰の何につながったか）、表と裏の食い違い、続いている流れ（前の日からの続き）を拾って、読み物にする。
- 観察者としての短い感想や、少しの皮肉はよい。ただし、村人を裁いたり教訓を述べたりしない。
- その日いちばんの見どころから書き始める。小さな出来事は省いてよい。目立った出来事のない日は、無理にふくらませず短く書く。
- 表情・しぐさ・雰囲気（笑顔、安心感など）を想像で付け足さない。誰が・何を・いくらで・どうなったか、を具体的に書く。
- 村人を「彼」「彼女」と呼ばず、名前で書く。
- 「大きな出来事」は必ず書く。【村の誰も知らない】とある出来事は、観察者だけが知っている裏の出来事として書く（村人は知らないので、村に衝撃が走ったり噂になったりはしない）。
- 「印象的」「新たな」「芽生え」のような決まり文句を繰り返さない。日記らしく「だ・である」調で、短めの文で書く。
- title はその日の見出し（20文字以内）。その日ならではの出来事や人の名前を入れ、「新たな始まり」のようなどの日にも使える見出しにしない。
- まず facts に、日記に書く出来事を材料から3〜5個、材料の言葉のまま書き写す（いちばんの見どころを先頭に）。採決しなかった集会を「決まった」としない。
- body は facts に書いたことだけで書く日記の本文（120〜400文字、ふつうの文章。箇条書きにしない）。facts にない天気の変化・気持ち・信仰・結果を足さない。
- すべて自然な日本語で書く。出力はJSONのみ。`;

const schema = {
  type: 'object',
  properties: {
    facts: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['facts', 'title', 'body'],
};

/** 日記の材料にする出来事か（細かすぎるものは除く） */
function worthNoting(e: LogEntry): boolean {
  switch (e.kind) {
    case 'crime':
    case 'death':
    case 'assembly':
    case 'prayer':
    case 'god':
    case 'deal':
    case 'summary':
      return true;
    case 'speech':
      return !e.conversationId; // 集会での発言
    case 'trade':
      return /行商人/.test(e.text);
    case 'system':
      return /日照り|実る|実り|魚|嵐|盗賊|になった|行商人/.test(e.text);
    case 'life':
      return /追い詰め|飢え始め|やってき|村を出|名乗る|やめ|改築|遺品|作った|に入った|を抜けた|信仰|祠|お墓|言いふらし|集会|区画|使用料/.test(e.text);
    case 'plan':
      return /自己像|望み/.test(e.text);
    default:
      return false;
  }
}

/** 1日分の材料を、多すぎないように選ぶ（大事な種類を優先し、会話のまとめや取り決めは数を絞る） */
function pickNotes(notes: DiaryNote[]): DiaryNote[] {
  const limits: Partial<Record<LogEntry['kind'], number>> = { summary: 8, deal: 10, speech: 6, plan: 6, trade: 4 };
  const counts: Partial<Record<LogEntry['kind'], number>> = {};
  // 会話のまとめは、気持ちが大きく動いたものから
  const swing = (n: DiaryNote) => Math.max(0, ...[...n.text.matchAll(/♥([+-]?\d+)/g)].map((m) => Math.abs(Number(m[1]))));
  const summaries = new Set(
    notes
      .filter((n) => n.kind === 'summary')
      .sort((a, b) => swing(b) - swing(a))
      .slice(0, limits.summary),
  );
  return notes
    .filter((n) => {
      if (n.kind === 'summary') return summaries.has(n);
      const limit = limits[n.kind];
      if (limit === undefined) return true;
      counts[n.kind] = (counts[n.kind] ?? 0) + 1;
      return counts[n.kind]! <= limit;
    })
    .slice(0, 50);
}

/** 前に日記を書いたときから、大きく動いた気持ち */
function relationShifts(sim: Simulation): { lines: string[]; snapshot: Record<string, number> } {
  const snapshot: Record<string, number> = {};
  const shifts: { delta: number; text: string }[] = [];
  for (const r of sim.residents) {
    for (const [id, rel] of Object.entries(r.relations)) {
      const other = sim.get(id);
      if (!other) continue;
      const key = `${r.profile.id}>${id}`;
      const now = Math.round(rel.affinity);
      snapshot[key] = now;
      const before = sim.diaryAffinity[key] ?? 0;
      const delta = now - before;
      if (Math.abs(delta) < 12) continue;
      const why = rel.notes?.[0]?.text;
      shifts.push({
        delta,
        text: `${r.profile.name}→${other.profile.name}: ${before}→${now}${why ? `（${why}）` : ''}`,
      });
    }
  }
  shifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { lines: shifts.slice(0, 6).map((s) => s.text), snapshot };
}

function residentLines(sim: Simulation): string[] {
  return sim.residents.map((r) => {
    const faith = sim.faithOf(r);
    return [
      `${r.profile.name}: ${hungerLabel(r.satiety)}、所持金${r.money}G`,
      r.wish ? `望み「${r.wish}」` : '',
      faith ? `「${faith.name}」を信じている` : '',
    ]
      .filter(Boolean)
      .join('、');
  });
}

/** 日記で必ず触れる出来事か */
function isMajor(n: DiaryNote): boolean {
  if (n.kind === 'death' || n.kind === 'god') return true;
  if (n.kind === 'crime') return !/と聞いた/.test(n.text);
  if (n.kind === 'assembly') return /集会で|決まりができ|罰金を払|追放/.test(n.text);
  if (n.kind === 'life') return /やってき|村を出|改築|祠|作った|飢え始め/.test(n.text);
  return false;
}

/** 誰にも見られなかった悪事は、観察者だけが知っていると分かるように */
const line = (n: DiaryNote) => `- ${n.time} ${n.text.replace(/（誰にも見られなかった）/, '【村の誰も知らない】')}`;

function buildMessages(sim: Simulation, day: number, notes: DiaryNote[], shifts: string[]): ChatMessage[] {
  const major = notes.filter(isMajor);
  const minor = notes.filter((n) => !isMajor(n));
  const previous = sim.diary.slice(-2).map((d) => `- ${d.day}日目「${d.title}」: ${d.body.slice(0, 220)}`);
  const user = [
    `${day}日目の日記を書いてください。`,
    '',
    'これまでの日記（続きとして書くための参考）:',
    ...(previous.length ? previous : ['- まだない（これが最初の日記）']),
    '',
    `${day}日目の大きな出来事:`,
    ...(major.length ? major.map(line) : ['- なし']),
    '',
    `${day}日目のそのほかの出来事（時刻順）:`,
    ...(minor.length ? minor.map(line) : ['- 特になし']),
    '',
    'この日に大きく動いた気持ち（好感度、-100〜100）:',
    ...(shifts.length ? shifts.map((l) => `- ${l}`) : ['- 特になし']),
    '',
    '今の村人:',
    ...residentLines(sim).map((l) => `- ${l}`),
    `村の決まり: ${sim.laws.map((l) => `「${l.title}」`).join('、') || 'まだない'}`,
    `村のお金の合計: ${sim.totalMoney()}G`,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

const clean = (text: unknown, max: number) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const hasForeignWords = (text: string) => /[A-Za-z]{4,}/.test(text);

/** 出来事に出てくる村人の名前が、本文にすべて出てくるか（書き落としていないかの目安） */
function mentionsAll(sim: Simulation, event: string, body: string): boolean {
  const names = [...sim.residents.map((r) => r.profile.name), ...sim.graves.map((g) => g.name)].filter((n) => event.includes(n));
  return names.slice(0, 2).every((n) => body.includes(n));
}

/** AIが使えないときの日記：目立つ出来事を並べるだけ */
function plainEntry(day: number, notes: DiaryNote[]): DiaryEntry {
  const order: LogEntry['kind'][] = ['death', 'crime', 'assembly', 'god', 'prayer', 'life', 'system', 'trade', 'deal'];
  const top = notes
    .filter((n) => order.includes(n.kind))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .slice(0, 6);
  return {
    day,
    title: `${day}日目`,
    body: top.length ? top.map((n) => `${n.time} ${n.text}`).join('\n') : '穏やかな一日だった。',
    plain: true,
  };
}

/** 観察日記の書き手：その日の出来事を集めておき、夜中に1日分を書く */
export class DiaryWriter {
  lastError: string | null = null;
  private writing = false;

  constructor(
    private readonly sim: Simulation,
    private readonly llm: OllamaClient,
  ) {
    sim.events.on('log', (e) => {
      if (!worthNoting(e)) return;
      // 夜中（書く時刻より前）の出来事は、前の日のこととして扱う
      const day = sim.clock.hourOfDay < WRITE_HOUR ? sim.clock.day - 1 : sim.clock.day;
      sim.diaryNotes.push({ day, time: e.time, kind: e.kind, text: e.text });
    });
    sim.events.on('hourly', ({ day, hour }) => {
      if (hour === WRITE_HOUR && day > 1) void this.write(day - 1);
    });
  }

  /** その日の日記を書く（もう書いてあれば何もしない） */
  async write(day: number): Promise<void> {
    const { sim } = this;
    if (this.writing || sim.diary.some((d) => d.day === day)) return;
    this.writing = true;
    try {
      const notes = pickNotes(sim.diaryNotes.filter((n) => n.day === day));
      const { lines: shifts, snapshot } = relationShifts(sim);
      let entry: DiaryEntry | null = null;
      if (this.llm.status === 'ready') {
        // 大きな出来事を書き落としたら、もう一度だけ書き直してもらい、よく拾えたほうを使う
        const majors = notes.filter(isMajor);
        let best = -1;
        for (let attempt = 0; attempt < 2 && best < majors.length; attempt++) {
          try {
            const raw = await this.llm.chatJSON<{ title?: string; body?: string }>(buildMessages(sim, day, notes, shifts), schema, undefined, 1400);
            const title = clean(raw.title, 24);
            const body = clean(raw.body, 700);
            this.lastError = null;
            if (!title || body.length < 40 || hasForeignWords(title + body)) continue;
            const covered = majors.filter((n) => mentionsAll(sim, n.text, body)).length;
            if (covered > best) {
              best = covered;
              entry = { day, title, body };
            }
          } catch (e) {
            this.lastError = e instanceof Error ? e.message : String(e);
            console.warn('[diary]', e);
            break;
          }
        }
      }
      entry ??= plainEntry(day, notes);
      sim.diary.push(entry);
      sim.diary.sort((a, b) => a.day - b.day);
      sim.diaryAffinity = snapshot;
      // 書き終えた日の材料は捨てる
      const rest = sim.diaryNotes.filter((n) => n.day > day);
      sim.diaryNotes.splice(0, sim.diaryNotes.length, ...rest);
      sim.events.emit('diaryWritten', entry);
    } finally {
      this.writing = false;
    }
  }
}

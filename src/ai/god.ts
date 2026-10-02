import { describeInventory, NEWCOMER_FOOD, NEWCOMER_MONEY } from '../world/economy';
import { VILLAGE_ENTRANCE } from '../world/mapgen';
import { pickName, randomPalette, type ResidentProfile } from '../world/residents';
import type { Resident, Simulation } from '../world/sim';
import type { ChatMessage, OllamaClient } from './llm';
import { affinityLabel, bestSkills, hungerLabel } from './prompt';

// ───────────── 出来事のプリセット ─────────────

export interface GodPreset {
  id: string;
  icon: string;
  label: string;
  run: (sim: Simulation) => void;
}

export const PRESETS: GodPreset[] = [
  { id: 'rain', icon: '☔', label: '雨を降らせる', run: (sim) => sim.startRain(5) },
  {
    id: 'festival',
    icon: '🏮',
    label: '今夜お祭り',
    run: (sim) => {
      const g = sim.holdGathering('plaza', 18, 21, 'お祭り');
      const when = Math.floor(g.from / 1440) + 1 === sim.clock.day ? '今夜' : '明日の夜';
      sim.announce(`${when}、広場でお祭りが開かれることになった`);
    },
  },
  {
    id: 'peddler',
    icon: '🧳',
    label: '行商人が来る',
    run: (sim) => sim.announce('珍しい品を売る旅の行商人が村にやってきた。妙に村人のことに詳しいらしい'),
  },
  {
    id: 'letter',
    icon: '✉️',
    label: '謎の手紙',
    run: (sim) => sim.announce('広場のベンチで、宛名のない古い手紙が見つかった。差出人は分からない'),
  },
];

const CANNED_RUMORS = [
  '夜中に畑のほうで、誰かが穴を掘っていたらしい',
  '酒場に見知らぬ男が訪ねてきて、誰かを探していたらしい',
  '学校の裏の木に、誰かの名前が彫られていたらしい',
  'パン屋が近いうちに店を閉めるかもしれないらしい',
  '源さんの家から、夜な夜なすすり泣く声が聞こえるらしい',
];

// ───────────── 新入村民 ─────────────

/** 村の外から新入村民を迎える。名前を空にすると、まだ村にいない名前から選ぶ。空き家がなければ null */
export function welcomeNewcomer(sim: Simulation, name = ''): Resident | null {
  const homeId = sim.vacantHomes()[0];
  if (!homeId) return null;
  const taken = [...sim.residents.map((r) => r.profile.name), ...sim.graves.map((g) => g.name)];
  const profile: ResidentProfile = {
    id: `n${Date.now().toString(36)}`,
    name: name.trim() || pickName(Math.random, taken),
    homeId,
    colors: randomPalette(),
  };
  return sim.addNewcomer(profile, VILLAGE_ENTRANCE, NEWCOMER_MONEY, NEWCOMER_FOOD);
}

// ───────────── おまかせモード ─────────────

interface Intervention {
  kind: 'news' | 'rumor' | 'whisper';
  target: string;
  text: string;
}

/** 神様AI。おまかせモードの間、数時間おきに村へ介入する */
export class AutoGod {
  enabled = false;
  private nextAt = 0;
  private acting = false;

  constructor(
    private readonly sim: Simulation,
    private readonly llm: OllamaClient,
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.nextAt = this.sim.clock.minutes + 20;
  }

  tick(): void {
    const { clock } = this.sim;
    if (!this.enabled || this.acting || clock.minutes < this.nextAt || clock.speed === 0) return;
    const hour = clock.hourOfDay;
    if (hour < 7 || hour >= 21 || this.llm.busy) return;
    this.acting = true;
    void this.act().finally(() => {
      this.acting = false;
      this.nextAt = clock.minutes + (3 + Math.random() * 4) * 60;
    });
  }

  private async act() {
    const { sim } = this;
    const roll = Math.random();
    const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
    if (roll < 0.12 && sim.weather.kind !== 'rain' && sim.weather.kind !== 'storm') return preset('rain').run(sim);
    if (roll < 0.22 && sim.clock.hourOfDay < 16 && !this.hasUpcomingGathering()) {
      return preset('festival').run(sim);
    }
    if (this.llm.status === 'ready') {
      try {
        return this.apply(await this.decide());
      } catch (e) {
        console.warn('[autogod]', e);
      }
    }
    const target = sim.residents[Math.floor(Math.random() * sim.residents.length)];
    sim.plantRumor(target, CANNED_RUMORS[Math.floor(Math.random() * CANNED_RUMORS.length)]);
  }

  private hasUpcomingGathering(): boolean {
    return this.sim.gatherings.some((g) => g.to > this.sim.clock.minutes);
  }

  private apply(iv: Intervention) {
    const target = this.sim.residents.find((r) => r.profile.name === iv.target);
    const text = iv.text.trim().slice(0, 80);
    if (!text) return;
    if (iv.kind === 'news' || !target) this.sim.announce(text);
    else if (iv.kind === 'rumor') this.sim.plantRumor(target, text);
    else this.sim.whisper(target, text);
  }

  private async decide(): Promise<Intervention> {
    const { sim } = this;
    const people = sim.residents.map((r) => {
      const rels = Object.entries(r.relations)
        .map(([id, rel]) => `${sim.get(id)?.profile.name}:${rel.affinity}(${affinityLabel(rel.affinity)})`)
        .join(' ');
      const mem = r.memories.slice(-3).map((m) => m.text).join(' / ') || 'なし';
      return `【${r.profile.name}】${hungerLabel(r.satiety)}・所持金${r.money}G・持ち物 ${describeInventory(r.inventory)}・腕前 ${bestSkills(r)}\n  自己像: ${r.selfImage || 'まだない'}\n  好感度: ${rels}\n  最近の記憶: ${mem}`;
    });
    const news = sim.recentNews().slice(-5).map((n) => `- ${n.text}`);
    const names = sim.residents.map((r) => r.profile.name);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `あなたは村を見守る気まぐれな神様です。村の物語が面白くなるよう、小さな介入を1つだけ行ってください。
- news: 村じゅうが知る出来事を起こす（target は「なし」）
- rumor: 特定の住民に噂を吹き込む（本当か嘘かは問わない）
- whisper: 特定の住民にだけ天の声で語りかける
助け合いや取引のきっかけ、関係がこじれる、または仲直りのきっかけになるような介入が好ましい。
text は40文字程度の日本語。出力は指定のJSONのみ。`,
      },
      {
        role: 'user',
        content: [`日時: ${sim.clock.format()}`, '住民:', ...people, '最近の出来事:', ...(news.length ? news : ['- なし'])].join('\n'),
      },
    ];
    const schema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['news', 'rumor', 'whisper'] },
        target: { type: 'string', enum: [...names, 'なし'] },
        text: { type: 'string' },
      },
      required: ['kind', 'target', 'text'],
    };
    return this.llm.chatJSON<Intervention>(messages, schema);
  }
}

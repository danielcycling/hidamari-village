// 本物の AI（Ollama）で村を何日か動かし、起きたことを日ごとにまとめて出す検証スクリプト。
// 使い方: node scripts/verify.mjs 日数 [--hard] [--raid] [--heaven] [--tempt] [--model=名前] [--seed=数]
//   --hard   初日から日照りと不漁（苦しい時期）
//   --raid   4日目の朝に盗賊の知らせ（5日目の夜に来る）
//   --heaven 2日目の朝、ひとりに天の声
//   --tempt  2日目の朝、いちばん食べ物の少ない人に悪魔のささやき
// Ollama は http://localhost:11434 で動いている必要がある。時間は実際の経過で進む（1日およそ10分）。
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const server = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const load = (p) => server.ssrLoadModule(p);
const { generateMap, HOME_IDS, FOUNDER_COUNT } = await load('/src/world/mapgen.ts');
const { Simulation } = await load('/src/world/sim.ts');
const { createFounders } = await load('/src/world/residents.ts');
const { mulberry32 } = await load('/src/core/rng.ts');
const economy = await load('/src/world/economy.ts');
const { STARTING_MONEY, STARTING_FOOD, SKILL_IDS, SKILLS, describeInventory, foodValue } = economy;
const { OllamaClient } = await load('/src/ai/llm.ts');
const { LifePlanner } = await load('/src/ai/lifePlanner.ts');
const { ConversationDirector } = await load('/src/ai/director.ts');
const { AssemblyDirector } = await load('/src/ai/assembly.ts');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
const seed = Number(opt('seed') ?? 11);

const sim = new Simulation(generateMap(20261002), createFounders(mulberry32(seed), HOME_IDS.slice(0, FOUNDER_COUNT)), STARTING_MONEY, STARTING_FOOD, seed);
const llm = new OllamaClient('http://localhost:11434');
await llm.connect(opt('model') ?? null);
console.log('model:', llm.model, 'seed:', seed);
const director = new ConversationDirector(sim, llm);
const planner = new LifePlanner(sim, llm);
new AssemblyDirector(sim, llm);

if (flag('hard')) {
  sim.startCondition('drought', 5);
  sim.startCondition('poor_catch', 5);
}
const once = new Set();
sim.events.on('hourly', ({ day, hour }) => {
  if (flag('raid') && !once.has('raid') && day >= 4 && hour === 6) {
    sim.warnRaid(day + 1);
    once.add('raid');
  }
  if (flag('heaven') && !once.has('heaven') && day >= 2 && hour === 7) {
    sim.whisper(sim.residents[2], '苦しいときは祈りなさい。天はいつもあなたたちを見ている');
    once.add('heaven');
  }
  if (flag('tempt') && !once.has('tempt') && day >= 2 && hour === 7) {
    const byFood = [...sim.residents].sort((a, b) => foodValue(a.inventory) - foodValue(b.inventory));
    const poor = byFood[0];
    const rich = byFood[byFood.length - 1];
    sim.tempt(poor, `${rich.profile.name}は食べ物をたくさん持っている。こっそり少し取っても、誰も気づかないかもしれない`);
    once.add('tempt');
  }
});

// 日ごとのまとめに載せる出来事
const notable = [];
const keep = (e) =>
  ['deal', 'summary', 'crime', 'death', 'assembly', 'prayer', 'god'].includes(e.kind) ||
  (e.kind === 'trade' && /行商人|保存食/.test(e.text)) ||
  (e.kind === 'system' && /日照り|実る|実り|魚|嵐|盗賊|になった|行商人/.test(e.text)) ||
  (e.kind === 'life' && /追い詰め|飢え始め|やってき|村を出|名乗る|やめ|改築|遺品|作った|に入った|を抜けた|教え|祠|お墓|言いふらし|集会|区画/.test(e.text)) ||
  (e.kind === 'plan' && /自己像|望み/.test(e.text)) ||
  (e.kind === 'speech' && !e.conversationId);
sim.events.on('log', (e) => {
  if (keep(e)) notable.push(`${sim.clock.day}日目 ${e.time} [${e.kind}] ${e.text}`);
});
sim.events.on('conversationEnd', (c) => {
  if (!c.purpose) return;
  const how = c.kind === 'ai' ? (c.outcome ? 'AIで話した' : 'AI失敗') : 'あいさつだけ';
  notable.push(`${sim.clock.day}日目 [用件] ${c.a.profile.name}→${c.b.profile.name} ${how}${c.received ? '・受け取れた' : ''}（${c.purpose.slice(0, 30)}）`);
});

sim.clock.speed = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
let reported = 1;
let last = performance.now();
const money0 = sim.totalMoney();
while (reported <= days) {
  await sleep(16);
  const now = performance.now();
  sim.update(Math.min((now - last) / 1000, 0.25));
  last = now;
  planner.tick();
  if (sim.clock.day > reported && sim.clock.hourOfDay >= 6.1) {
    console.log(`\n===== ${reported}日目の終わり（経過 ${((performance.now() - t0) / 60000).toFixed(1)}分） =====`);
    reported = sim.clock.day;
    for (const n of notable.splice(0)) console.log('  * ' + n);
    console.log(`  空: ${sim.describeWeather('now')}`);
    console.log(`  お金: 村の合計 ${sim.totalMoney()}G（外から ${sim.moneyFlow.in}G・外へ ${sim.moneyFlow.out}G）${sim.totalMoney() !== money0 + sim.moneyFlow.in - sim.moneyFlow.out ? '  !! 計算が合わない' : ''}`);
    console.log(`  区画: 金庫${sim.villageTreasury}G ${sim.plots.filter((p) => p.ownerId).map((p) => `${p.placeId}=${sim.get(p.ownerId)?.profile.name}(${p.fee}G)`).join(' ') || '持ち主なし'}`);
    for (const r of sim.residents) {
      const best = SKILL_IDS.filter((s) => r.skills[s] >= 5).map((s) => `${SKILLS[s]}${Math.round(r.skills[s])}`).join('/');
      const hours = Object.entries(r.history.at(-1)?.hours ?? {})
        .filter(([, v]) => v >= 0.3)
        .map(([a, v]) => `${a}${v.toFixed(1)}`)
        .join(' ');
      console.log(`  ${r.profile.name} ${r.money}G 満腹${Math.round(r.satiety)} 体力${Math.round(r.health)} 持ち物:${describeInventory(r.inventory)} 腕前:${best} 計画:${r.plan?.source}`);
      console.log(`      時間:${hours} 家${r.homeLevel ?? 0} 満足${r.satisfaction ?? '-'} 望み:${r.wish ?? '-'} 信仰:${sim.faithOf(r)?.name ?? '-'}`);
    }
  }
}
console.log('\n===== 最終的な気持ち =====');
for (const r of sim.residents) {
  const rels = Object.entries(r.relations).map(([id, rel]) => `${sim.get(id)?.profile.name ?? '故人'}${rel.affinity >= 0 ? '+' : ''}${Math.round(rel.affinity)}`);
  console.log(`  ${r.profile.name}: ${rels.join(' / ')}`);
}
console.log('組織と教え:', JSON.stringify(sim.organizations.map((o) => ({ name: o.name, kind: o.kind, members: o.memberIds.length, treasury: o.treasury }))));
console.log('決まり:', sim.laws.map((l) => l.title).join('、') || 'なし');
console.log('エラー:', planner.lastError, director.lastError);
await server.close();
process.exit(0);

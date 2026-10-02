// LLMなしで村を早回しして、経済と生存のバランスを確かめる
// usage: npm run simulate -- [日数=20] [シード=1] [--log] [--step=0.5]
import { createServer } from 'vite';

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const seed = Number(args.filter((a) => /^\d+$/.test(a))[1] ?? 1);
const showLog = args.includes('--log');
// 1回の更新で進める現実の秒（等速では 0.5秒 = 1分）。ブラウザは1フレームで細かく進むので、小さくしても結果が変わらないか確かめられる
const step = Number(args.find((a) => a.startsWith('--step='))?.split('=')[1] ?? 0.5);

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const load = (p) => server.ssrLoadModule(p);
const { generateMap, HOME_IDS, FOUNDER_COUNT } = await load('/src/world/mapgen.ts');
const { Simulation } = await load('/src/world/sim.ts');
const { createFounders } = await load('/src/world/residents.ts');
const { mulberry32 } = await load('/src/core/rng.ts');
const { STARTING_MONEY, STARTING_FOOD, foodValue, countItem, SKILL_IDS, SKILLS } = await load('/src/world/economy.ts');

const map = generateMap(20261002);
const founders = createFounders(mulberry32(seed), HOME_IDS.slice(0, FOUNDER_COUNT));
const sim = new Simulation(map, founders, STARTING_MONEY, STARTING_FOOD, seed);
const totalMoney = sim.totalMoney();

let trades = 0;
sim.events.on('log', (e) => {
  if (e.kind === 'trade') trades++;
  if (showLog || e.kind === 'death' || e.kind === 'day') {
    if (showLog || e.kind === 'death') console.log(`  ${e.time} [${e.kind}] ${e.text}`);
  }
});

const pad = (s, n) => String(s).padStart(n);
console.log(`seed=${seed} days=${days} residents=${sim.residents.length} totalMoney=${totalMoney}`);
console.log('day  pop  satiety  health  food/人  wheat  money(min-max)  trades  top skills');
for (let d = 1; d <= days; d++) {
  trades = 0;
  // 1分ずつ1日分（等速：1分 = 0.5秒）
  const end = d * 1440 + 6 * 60;
  while (sim.clock.minutes < end && sim.residents.length > 0) sim.update(step);
  const rs = sim.residents;
  if (rs.length === 0) {
    console.log(`${pad(d, 3)}  全滅`);
    break;
  }
  const avg = (f) => (rs.reduce((n, r) => n + f(r), 0) / rs.length).toFixed(0);
  const money = rs.map((r) => r.money);
  const skills = rs
    .map((r) => {
      const best = SKILL_IDS.reduce((a, b) => (r.skills[a] >= r.skills[b] ? a : b));
      return `${r.profile.name}:${SKILLS[best]}${r.skills[best].toFixed(0)}`;
    })
    .join(' ');
  console.log(
    `${pad(d, 3)}  ${pad(rs.length, 3)}  ${pad(avg((r) => r.satiety), 7)}  ${pad(avg((r) => r.health), 6)}  ${pad(
      avg((r) => foodValue(r.inventory)),
      7,
    )}  ${pad(rs.reduce((n, r) => n + countItem(r.inventory, 'wheat'), 0), 5)}  ${pad(
      `${Math.min(...money)}-${Math.max(...money)}`,
      14,
    )}  ${pad(trades, 6)}  ${skills}`,
  );
  if (sim.totalMoney() !== totalMoney) console.log(`  !! お金の総量が変わった: ${totalMoney} → ${sim.totalMoney()}`);
}
console.log(`graves: ${sim.graves.map((g) => `${g.name}(${g.day}日目)`).join(', ') || 'なし'}`);
await server.close();
process.exit(0);

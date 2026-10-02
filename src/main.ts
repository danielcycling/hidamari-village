import './style.css';
import { ConversationDirector } from './ai/director';
import { AutoGod } from './ai/god';
import { LifePlanner } from './ai/lifePlanner';
import { OllamaClient } from './ai/llm';
import { ModelPicker, savedModel } from './ui/modelPicker';
import { Renderer } from './render/renderer';
import { GodPanel } from './ui/godPanel';
import { Panel } from './ui/panel';
import { mulberry32 } from './core/rng';
import { STARTING_FOOD, STARTING_MONEY } from './world/economy';
import { FOUNDER_COUNT, generateMap, HOME_IDS } from './world/mapgen';
import { createFounders } from './world/residents';
import { clearSave, loadSave, restore, serialize, writeSave } from './world/save';
import { Simulation } from './world/sim';

/** 地形は毎回同じ。住民の名前や見た目は村を始めるたびに変わる */
const MAP_SEED = 20261002;

async function main() {
  // キャンバスの文字にドット絵フォントを使うため、読み込みを待つ（失敗しても続行）
  await document.fonts.load('12px "DotGothic16"').catch(() => undefined);

  // 確認用: ?hour=13.5&speed=10&seed=1&model=qwen2.5:7b-instruct で開始時刻・速さ・住民・モデルを指定できる。
  // hour か fresh を付けたときは保存データを読まず、上書きもしない
  const params = new URLSearchParams(location.search);
  const seed = params.has('seed') ? Number(params.get('seed')) : Date.now() % 1_000_000_007;
  const map = generateMap(MAP_SEED);
  const founders = createFounders(mulberry32(seed), HOME_IDS.slice(0, FOUNDER_COUNT));
  const sim = new Simulation(map, founders, STARTING_MONEY, STARTING_FOOD, seed);

  const persist = !params.has('hour') && !params.has('fresh');
  const save = persist ? loadSave() : null;
  if (save) restore(sim, save);
  const hour = Number(params.get('hour'));
  if (params.has('hour') && hour >= 0 && hour < 24) {
    sim.clock.minutes = hour * 60;
    sim.resyncClock();
  }
  const speed = Number(params.get('speed'));
  if (params.has('speed') && speed >= 0) sim.clock.speed = speed;
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, map);
  const llm = new OllamaClient();
  const director = new ConversationDirector(sim, llm);
  const lifePlanner = new LifePlanner(sim, llm);
  const panel = new Panel(sim, renderer, llm, director, lifePlanner);
  const autoGod = new AutoGod(sim, llm);
  if (save?.autoGod) autoGod.setEnabled(true);
  new GodPanel(sim, autoGod);
  const modelPicker = new ModelPicker(sim, llm);
  void director.start(params.get('model') ?? savedModel());

  canvas.addEventListener('click', (e) => panel.select(renderer.hitTest(e.clientX, e.clientY)));

  sim.log(save ? `${sim.clock.format()}から観察を再開した` : 'ひだまり村の観察を始めた', 'system');

  // 自動保存（ブラウザ内に保存。タブを隠したとき・閉じるときにも保存する）
  let saving = persist;
  const saveNow = () => {
    if (saving) writeSave(serialize(sim, autoGod.enabled));
  };
  setInterval(saveNow, 20_000);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow();
  });
  document.getElementById('reset')!.addEventListener('click', () => {
    if (!confirm('村を1日目からやり直します。住民の記憶や関係はすべて消えます。よろしいですか？')) return;
    saving = false;
    clearSave();
    location.href = location.pathname;
  });

  // 見ている間だけ時間が進む：タブが隠れたら止め、戻ったときに経過時間を持ち越さない
  let last = performance.now();
  document.addEventListener('visibilitychange', () => {
    last = performance.now();
  });

  let sinceRefresh = 0;
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (!document.hidden) {
      sim.update(dt);
      lifePlanner.tick();
      autoGod.tick();
    }
    renderer.render(sim, now);
    sinceRefresh += dt;
    if (sinceRefresh > 0.2) {
      panel.refresh();
      modelPicker.refresh();
      sinceRefresh = 0;
    }
    requestAnimationFrame(frame);
  };
  panel.refresh();
  requestAnimationFrame(frame);
}

void main();

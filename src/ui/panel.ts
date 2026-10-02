import type { ConversationDirector } from '../ai/director';
import type { LifePlanner } from '../ai/lifePlanner';
import type { OllamaClient } from '../ai/llm';
import type { Renderer } from '../render/renderer';
import { avatar } from './avatar';
import { Inspector } from './inspector';
import { RelationGraph } from './relationGraph';
import type { LogEntry, Resident, Simulation } from '../world/sim';

const SPEEDS = [
  { label: '⏸', value: 0, title: '一時停止' },
  { label: '1x', value: 1, title: '等速' },
  { label: '3x', value: 3, title: '3倍速' },
  { label: '10x', value: 10, title: '10倍速' },
];
const MAX_LOG = 200;

export class Panel {
  private readonly clockEl = document.getElementById('clock')!;
  private readonly logEl = document.getElementById('log')!;
  private readonly statusEls = new Map<string, HTMLElement>();
  private readonly itemEls = new Map<string, HTMLElement>();
  private readonly aiEl = document.getElementById('ai-status')!;
  private readonly speedEl = document.getElementById('speed')!;
  private readonly conversationEls = new Map<number, HTMLElement>();
  private readonly inspector: Inspector;
  private readonly graph: RelationGraph;
  private activeTab = 'panel-log';
  /** 気持ちや記憶が変わったので、心・相関図を描き直す必要がある */
  private mindDirty = false;
  private mindRenderedAt = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly renderer: Renderer,
    private readonly llm: OllamaClient,
    private readonly director: ConversationDirector,
    private readonly lifePlanner: LifePlanner,
  ) {
    this.buildSpeedControls();
    this.inspector = new Inspector(sim);
    this.graph = new RelationGraph(sim, (id) => this.select(id));
    this.buildTabs();
    for (const r of sim.residents) this.addResidentItem(r);
    for (const e of sim.logHistory) this.appendLog(e);
    sim.events.on('residentAdded', (r) => {
      this.addResidentItem(r);
      this.mindDirty = true;
    });
    sim.events.on('log', (e) => {
      this.appendLog(e);
      if (e.kind === 'god' || e.kind === 'summary') this.mindDirty = true;
    });
    this.inspector.render(null);
  }

  select(id: string | null): void {
    this.renderer.selectedId = id;
    for (const [rid, el] of this.itemEls) el.classList.toggle('selected', rid === id);
    this.inspector.render(id);
    if (id) this.showTab('panel-mind');
  }

  private showTab(panelId: string) {
    this.activeTab = panelId;
    for (const t of document.querySelectorAll<HTMLButtonElement>('.tabs [role=tab]')) {
      const selected = t.getAttribute('aria-controls') === panelId;
      t.setAttribute('aria-selected', String(selected));
      document.getElementById(t.getAttribute('aria-controls')!)!.hidden = !selected;
    }
    if (panelId === 'panel-graph') this.graph.render();
    if (panelId === 'panel-mind') this.inspector.render(this.renderer.selectedId);
  }

  refresh(): void {
    this.clockEl.textContent = this.sim.clock.format();
    for (const [id, li] of this.itemEls) {
      const r = this.sim.get(id);
      const status = this.statusEls.get(id)!;
      if (!r) {
        // 亡くなった人のカードは残して、灰色にする
        li.classList.add('dead');
        status.textContent = '亡くなった';
        continue;
      }
      status.textContent = this.sim.statusOf(r);
      li.querySelector('.resident-name span')!.textContent = `${r.occupation || '仕事なし'}・${r.money}G`;
      li.querySelector<HTMLElement>('.bar.satiety i')!.style.width = `${r.satiety}%`;
      li.querySelector<HTMLElement>('.bar.health i')!.style.width = `${Math.max(0, r.health)}%`;
      li.classList.toggle('hungry', r.satiety < 30);
    }
    this.refreshAiStatus();
    // 心タブは数字が動き続けるので、開いている間は1秒ごとに描き直す
    if (this.activeTab === 'panel-mind' && performance.now() - this.mindRenderedAt > 1000) {
      this.mindRenderedAt = performance.now();
      this.inspector.refresh();
    }
    if (this.mindDirty) {
      this.mindDirty = false;
      if (this.activeTab === 'panel-mind') this.inspector.render(this.renderer.selectedId);
      if (this.activeTab === 'panel-graph') this.graph.render();
    }
    const slowed = this.sim.isSlowedForConversation;
    this.speedEl.classList.toggle('slowed', slowed);
    this.speedEl.title = slowed ? '会話中は等速で進みます' : '';
  }

  private refreshAiStatus() {
    const { status, model } = this.llm;
    const planning = this.lifePlanner.status();
    const state = status === 'ready' && (this.llm.working || planning) ? 'busy' : status;
    const text = this.sim.holdingDawn
      ? `夜明け前：みんなの計画を待っています（${planning ?? ''}）`
      : planning && status === 'ready'
        ? `AI: ${planning}`
        : {
            connecting: 'AIに接続中…',
            ready: `AI: ${model}`,
            busy: `AI: 会話を考え中…`,
            offline: 'AI未接続（ルールで暮らしています）',
          }[state];
    if (this.aiEl.dataset.state === state && this.aiEl.textContent === text) return;
    this.aiEl.dataset.state = state;
    this.aiEl.querySelector('span')!.textContent = text;
    this.aiEl.title =
      state === 'offline'
        ? 'Ollama が起動していないか、モデルがありません。`ollama serve` を実行し、`ollama pull qwen2.5:7b-instruct` でモデルを入れてください。'
        : (this.director.lastError ?? this.lifePlanner.lastError ?? '');
  }

  private buildSpeedControls() {
    const root = document.getElementById('speed')!;
    const buttons = SPEEDS.map((s) => {
      const btn = document.createElement('button');
      btn.textContent = s.label;
      btn.title = s.title;
      btn.addEventListener('click', () => {
        this.sim.clock.speed = s.value;
        buttons.forEach((b) => b.classList.toggle('active', b === btn));
      });
      btn.classList.toggle('active', s.value === this.sim.clock.speed);
      root.append(btn);
      return btn;
    });
  }

  private buildTabs() {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs [role=tab]')) {
      tab.addEventListener('click', () => this.showTab(tab.getAttribute('aria-controls')!));
    }
  }

  private addResidentItem(r: Resident) {
    const { profile } = r;
    const li = document.createElement('li');
    li.className = 'resident';
    li.tabIndex = 0;
    li.append(avatar(profile.colors));

    const body = document.createElement('div');
    body.className = 'resident-body';
    const name = document.createElement('div');
    name.className = 'resident-name';
    name.innerHTML = `<strong></strong><span></span>`;
    name.querySelector('strong')!.textContent = profile.name;
    const status = document.createElement('div');
    status.className = 'resident-status';
    const bars = document.createElement('div');
    bars.className = 'resident-bars';
    bars.innerHTML = `<span class="bar satiety" title="満腹度"><i></i></span><span class="bar health" title="体力"><i></i></span>`;
    body.append(name, status, bars);
    li.append(body);

    const toggle = () => this.select(this.renderer.selectedId === profile.id ? null : profile.id);
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    document.getElementById('residents')!.append(li);
    this.statusEls.set(profile.id, status);
    this.itemEls.set(profile.id, li);
  }

  private appendLog(entry: LogEntry) {
    const li = document.createElement('li');
    li.className = `log-${entry.kind}`;
    const time = document.createElement('time');
    time.textContent = entry.time;
    const text = document.createElement('span');
    text.textContent = entry.text;
    li.append(time, text);
    const speaker = entry.speakerId ? this.sim.get(entry.speakerId) : undefined;
    if (speaker) li.style.setProperty('--speaker', speaker.profile.colors.shirt);

    // 同じ会話のセリフは、話し始めのログの下にまとめる
    const id = entry.conversationId;
    if (id !== undefined && entry.kind !== 'meet' && this.conversationEls.has(id)) {
      this.conversationEls.get(id)!.append(li);
      if (entry.kind === 'summary') this.conversationEls.delete(id);
      return;
    }
    if (id !== undefined && entry.kind === 'meet') {
      const lines = document.createElement('ol');
      lines.className = 'log-lines';
      const wrapper = document.createElement('li');
      wrapper.className = 'log-conversation';
      const header = document.createElement('div');
      header.className = 'log-meet';
      header.append(time, text);
      wrapper.append(header, lines);
      this.conversationEls.set(id, lines);
      this.logEl.prepend(wrapper);
    } else {
      this.logEl.prepend(li);
    }
    while (this.logEl.children.length > MAX_LOG) this.logEl.lastElementChild!.remove();
  }
}

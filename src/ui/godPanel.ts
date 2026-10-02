import { PRESETS, welcomeNewcomer, type AutoGod } from '../ai/god';
import type { Simulation } from '../world/sim';

const TEMPLATE = `
  <label class="god-auto">
    <input type="checkbox" name="auto" />
    <span>
      <strong>おまかせモード</strong>
      <small>神様AIが数時間おきに、勝手に村へ介入します</small>
    </span>
  </label>

  <section class="god-section">
    <h3>出来事を起こす</h3>
    <div class="preset-grid"></div>
    <form class="god-row" data-form="news">
      <input name="text" maxlength="80" placeholder="例：村に野良猫が住みついた" required />
      <button>起こす</button>
    </form>
  </section>

  <section class="god-section">
    <h3>ささやく</h3>
    <form class="god-stack" data-form="whisper">
      <div class="god-row">
        <select name="target" aria-label="相手"></select>
        <select name="mode" aria-label="方法">
          <option value="whisper">天の声で耳打ち</option>
          <option value="rumor">噂を吹き込む</option>
          <option value="tempt">悪魔のささやき</option>
        </select>
      </div>
      <div class="god-row">
        <input name="text" maxlength="80" placeholder="例：明日は嵐が来るかもしれない" required />
        <button>送る</button>
      </div>
    </form>
  </section>

  <section class="god-section">
    <h3>村の決まりと集会</h3>
    <ul class="god-laws" data-laws></ul>
  </section>

  <section class="god-section">
    <h3>新入村民を呼ぶ <small data-vacancy></small></h3>
    <p class="god-note">村の外から、何も持たない人がやってきます（無一文・パン1つ、仕事も性格もなし）。</p>
    <form class="god-row" data-form="newcomer">
      <input name="name" maxlength="12" placeholder="名前（空なら村が決める）" />
      <button>呼ぶ</button>
    </form>
  </section>

  <p class="god-feedback" role="status" aria-live="polite"></p>
`;

export class GodPanel {
  private readonly root = document.getElementById('panel-god')!;
  private readonly feedbackEl: HTMLElement;
  private feedbackTimer = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly autoGod: AutoGod,
  ) {
    this.root.innerHTML = TEMPLATE;
    this.feedbackEl = this.root.querySelector('.god-feedback')!;
    this.buildAuto();
    this.buildPresets();
    this.buildNewsForm();
    this.buildWhisperForm();
    this.buildNewcomerForm();
    const refresh = () => {
      this.fillTargets();
      this.refreshVacancy();
    };
    sim.events.on('residentAdded', refresh);
    sim.events.on('residentDied', refresh);
    this.refreshLaws();
    sim.events.on('log', (e) => {
      if (e.kind === 'assembly' || (e.kind === 'life' && e.text.includes('集会'))) this.refreshLaws();
    });
  }

  /** 今ある村の決まりと、予定されている集会 */
  private refreshLaws() {
    const list = this.root.querySelector('[data-laws]')!;
    const items: string[] = [
      ...this.sim.assemblies
        .filter((a) => a.status !== 'done')
        .map((a) => `📣 ${a.day}日目 ${Math.floor((a.from % 1440) / 60)}時〜 集会「${a.agenda}」（${a.callerName}）`),
      ...this.sim.laws.map((l) => `📜 ${l.title}${l.text && l.text !== l.title ? `：${l.text}` : ''}（${l.enactedDay}日目）`),
    ];
    list.replaceChildren(
      ...(items.length ? items : ['まだ決まりはありません。村人が集会を開けば生まれます。']).map((t) => {
        const li = document.createElement('li');
        li.textContent = t;
        return li;
      }),
    );
  }

  private form(name: string): HTMLFormElement {
    return this.root.querySelector(`form[data-form="${name}"]`)!;
  }

  private feedback(text: string) {
    this.feedbackEl.textContent = text;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = window.setTimeout(() => (this.feedbackEl.textContent = ''), 4000);
  }

  private buildAuto() {
    const box = this.root.querySelector<HTMLInputElement>('input[name=auto]')!;
    box.checked = this.autoGod.enabled;
    box.addEventListener('change', () => {
      this.autoGod.setEnabled(box.checked);
      this.feedback(box.checked ? '神様AIに村をまかせました' : 'おまかせモードを止めました');
    });
  }

  private buildPresets() {
    const grid = this.root.querySelector('.preset-grid')!;
    for (const preset of PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<span aria-hidden="true"></span>`;
      btn.querySelector('span')!.textContent = preset.icon;
      btn.append(preset.label);
      btn.addEventListener('click', () => {
        preset.run(this.sim);
        this.feedback(`「${preset.label}」を起こしました`);
      });
      grid.append(btn);
    }
  }

  private buildNewsForm() {
    const form = this.form('news');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.elements.namedItem('text') as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      this.sim.announce(text);
      input.value = '';
      this.feedback('出来事が村じゅうに知れ渡りました');
    });
  }

  private buildWhisperForm() {
    const form = this.form('whisper');
    this.fillTargets();
    const examples: Record<string, string> = {
      whisper: '例：明日は嵐が来るかもしれない',
      rumor: '例：あの人は食べ物を隠し持っているらしい',
      tempt: '例：あいつは食べ物をたくさん持っている。少しくらい取っても…',
    };
    const mode = form.elements.namedItem('mode') as HTMLSelectElement;
    const input = form.elements.namedItem('text') as HTMLInputElement;
    mode.addEventListener('change', () => (input.placeholder = examples[mode.value] ?? ''));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const get = (n: string) => form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;
      const target = this.sim.get(get('target').value);
      const text = get('text').value.trim();
      if (!target || !text) return;
      const mode = get('mode').value;
      if (mode === 'rumor') this.sim.plantRumor(target, text);
      else if (mode === 'tempt') this.sim.tempt(target, text);
      else this.sim.whisper(target, text);
      get('text').value = '';
      this.feedback(
        mode === 'tempt'
          ? `${target.profile.name}の心に、自分の考えとして浮かびました。2日のあいだ、計画や判断のたびに頭をよぎります`
          : `${target.profile.name}に届きました。次に誰かと話すとき、話題にするかもしれません`,
      );
    });
  }

  private fillTargets() {
    const select = this.form('whisper').elements.namedItem('target') as HTMLSelectElement;
    const current = select.value;
    select.replaceChildren(
      ...this.sim.residents.map((r) => new Option(r.profile.name, r.profile.id, false, r.profile.id === current)),
    );
  }

  private refreshVacancy() {
    const left = this.sim.vacantHomes().length;
    this.root.querySelector('[data-vacancy]')!.textContent = left > 0 ? `空き家 残り${left}軒` : '空き家がありません';
    for (const btn of this.form('newcomer').querySelectorAll('button')) btn.disabled = left === 0;
  }

  private buildNewcomerForm() {
    const form = this.form('newcomer');
    const input = form.elements.namedItem('name') as HTMLInputElement;
    this.refreshVacancy();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name && this.sim.residents.some((r) => r.profile.name === name)) {
        this.feedback(`${name}はもう村にいます。別の名前にしてください`);
        return;
      }
      const resident = welcomeNewcomer(this.sim, name);
      if (!resident) {
        this.feedback('空き家がありません');
        return;
      }
      input.value = '';
      this.feedback(`${resident.profile.name}が村の入り口に到着しました`);
    });
  }
}

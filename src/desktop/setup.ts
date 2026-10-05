import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** デスクトップ版で Ollama につなぐ先 */
const OLLAMA_URL = 'http://127.0.0.1:11434';

/** 取ってこられるモデル（村人の頭）。上がおすすめ */
const MODEL_CHOICES = [
  {
    name: 'qwen2.5:7b-instruct',
    label: 'ふつう（おすすめ）',
    size: '約4.7GB',
    note: 'メモリ16GB以上のパソコン向け。会話が自然で、取り決めも正確です。',
  },
  {
    name: 'qwen2.5:3b',
    label: '軽い',
    size: '約1.9GB',
    note: 'メモリ8GBのパソコン向け。速いぶん、会話は少し単純になります。',
  },
];

interface Status {
  installed: boolean;
  running: boolean;
}

interface Progress {
  stage: string;
  completed: number;
  total: number;
}

/**
 * fetch の代わり：Ollama への問い合わせをアプリ本体（Rust）に頼む。
 * 画面側の通信部品は Windows で応答の受け取りに失敗することがあるため
 */
const desktopFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  const reply = await invoke<{ status: number; body: string }>('ollama_fetch', {
    method: init?.method ?? 'GET',
    path,
    body: typeof init?.body === 'string' ? init.body : null,
  });
  return new Response(reply.body, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
};

export interface DesktopConnection {
  baseUrl: string;
  fetchImpl: typeof fetch;
}

export { isTauri };

/**
 * デスクトップ版の起動時に、村人の頭（Ollama とモデル）を準備する。
 * 準備できたら接続先を、AIなしで始めるなら null を返す
 */
export async function prepareDesktop(): Promise<DesktopConnection | null> {
  const fetchImpl = desktopFetch;
  const ui = new SetupView();
  const unlisten = await listen<Progress>('setup-progress', (e) => ui.progress(e.payload));
  try {
    for (;;) {
      try {
        ui.message('村人の頭（AI）の様子を確かめています…');
        let status = await invoke<Status>('ollama_status');
        if (!status.installed) {
          const go = await ui.ask(
            'AIを入れる準備',
            [
              'ひだまり村の村人は、あなたのパソコンの中で動くAI（Ollama）で考えて話します。',
              'インターネットに会話を送ることはなく、利用料もかかりません。',
              'まず Ollama（無料・約200MB）を入れます。',
            ],
            [
              { id: 'install', label: 'Ollama を入れる', primary: true },
              { id: 'skip', label: 'AIなしで始める' },
            ],
          );
          if (go === 'skip') return null;
          ui.message('Ollama を用意しています…');
          await invoke('install_ollama');
          status = await invoke<Status>('ollama_status');
        }
        if (!status.running) {
          ui.message('Ollama を起こしています…');
          await invoke('start_ollama');
        }
        const models = await listModels(fetchImpl);
        if (models.length === 0) {
          const choice = await ui.ask(
            '村人の頭を選ぶ',
            ['村人が考えるためのAIのモデルをダウンロードします。一度だけで、次からは要りません。'],
            [
              ...MODEL_CHOICES.map((m, i) => ({
                id: m.name,
                label: `${m.label}（${m.size}）`,
                note: m.note,
                primary: i === 0,
              })),
              { id: 'skip', label: 'AIなしで始める' },
            ],
          );
          if (choice === 'skip') return null;
          ui.message('ダウンロードを始めています…');
          await invoke('pull_model', { model: choice });
        }
        return { baseUrl: OLLAMA_URL, fetchImpl };
      } catch (e) {
        const again = await ui.ask(
          'うまくいきませんでした',
          [String(e instanceof Error ? e.message : e), 'インターネットの接続を確かめて、もう一度試してください。'],
          [
            { id: 'retry', label: 'もう一度試す', primary: true },
            { id: 'skip', label: 'AIなしで始める' },
          ],
        );
        if (again === 'skip') return null;
      }
    }
  } finally {
    unlisten();
    ui.close();
  }
}

/** 村人の頭として使えるモデル（埋め込み用・R1系の推論モデルは除く） */
async function listModels(fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(`${OLLAMA_URL}/api/tags`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).filter((n) => !/embed|(^|[-_:/])r1|deepseek-r1/i.test(n));
}

// ───────────── 画面 ─────────────

interface Choice {
  id: string;
  label: string;
  note?: string;
  primary?: boolean;
}

class SetupView {
  private readonly root = document.createElement('div');
  private readonly body = document.createElement('div');

  constructor() {
    this.root.className = 'setup';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'setup-card';
    const title = document.createElement('h2');
    title.textContent = 'ひだまり村へようこそ';
    card.append(title, this.body);
    this.root.append(card);
    document.body.append(this.root);
  }

  message(text: string) {
    const p = document.createElement('p');
    p.className = 'setup-message';
    p.textContent = text;
    this.body.replaceChildren(p);
  }

  progress({ stage, completed, total }: Progress) {
    const p = document.createElement('p');
    p.className = 'setup-message';
    p.textContent = stageLabel(stage);
    const bar = document.createElement('div');
    bar.className = 'setup-bar';
    const fill = document.createElement('i');
    fill.style.width = total > 0 ? `${Math.min(100, (completed / total) * 100)}%` : '100%';
    if (total === 0) bar.classList.add('busy');
    bar.append(fill);
    const size = document.createElement('p');
    size.className = 'setup-size';
    size.textContent = total > 0 ? `${mb(completed)} / ${mb(total)}` : '';
    this.body.replaceChildren(p, bar, size);
  }

  ask(heading: string, lines: string[], choices: Choice[]): Promise<string> {
    return new Promise((resolve) => {
      const h = document.createElement('h3');
      h.textContent = heading;
      const texts = lines.map((l) => {
        const p = document.createElement('p');
        p.textContent = l;
        return p;
      });
      const buttons = document.createElement('div');
      buttons.className = 'setup-choices';
      for (const c of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = c.primary ? 'primary' : '';
        b.textContent = c.label;
        if (c.note) {
          const small = document.createElement('small');
          small.textContent = c.note;
          b.append(small);
        }
        b.addEventListener('click', () => resolve(c.id));
        buttons.append(b);
      }
      this.body.replaceChildren(h, ...texts, buttons);
      buttons.querySelector<HTMLButtonElement>('button.primary')?.focus();
    });
  }

  close() {
    this.root.remove();
  }
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}GB` : `${Math.round(n / 1e6)}MB`);

/** Ollama の進み具合の言葉を、やさしい日本語に */
function stageLabel(stage: string): string {
  if (/^pulling manifest/.test(stage)) return 'ダウンロードの準備をしています…';
  if (/^pulling/.test(stage)) return '村人の頭（AIのモデル）をダウンロードしています…';
  if (/verifying/.test(stage)) return 'ダウンロードしたものを確かめています…';
  if (/writing manifest|success/.test(stage)) return 'もうすぐ終わります…';
  return stage;
}

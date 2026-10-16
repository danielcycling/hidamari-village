import type { DiaryEntry, Simulation } from '../world/sim';

/** その日の一枚は保存データとは別に置く（大きいので、本体の保存を重くしないように） */
const IMAGE_KEY = 'hidamari-village/diary-images';
/** 残しておく絵の数（古いものから消す） */
const MAX_IMAGES = 60;
/** 絵の横幅（縮めて保存する） */
const IMAGE_WIDTH = 480;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

function loadImages(): Record<number, string> {
  try {
    return JSON.parse(localStorage.getItem(IMAGE_KEY) ?? '{}') as Record<number, string>;
  } catch {
    return {};
  }
}

export function clearDiaryImages(): void {
  try {
    localStorage.removeItem(IMAGE_KEY);
  } catch {
    // 保存できない環境では何もしない
  }
}

/**
 * 日記タブ：観察者だけが読む、1日ごとの観察日記。その日の見どころの一枚を添え、書き出しもできる
 */
export class DiaryTab {
  private readonly root = document.getElementById('panel-diary')!;
  private images = loadImages();
  /** 今日いちばんの見どころの重み（これより大きい出来事が起きたら一枚を撮り直す） */
  private best = { day: 0, score: 0 };

  constructor(
    private readonly sim: Simulation,
    private readonly canvas: HTMLCanvasElement,
  ) {
    sim.events.on('diaryWritten', () => this.render());
  }

  /** 見どころの出来事が起きたら、そのときの村の様子を一枚撮る */
  noteMoment(day: number, score: number): void {
    // 日が変わったら数え直す（読み込み直したときは、すでにある一枚をそこそこの見どころとみなす）
    if (this.best.day !== day) this.best = { day, score: this.images[day] ? 3 : 0 };
    if (score <= this.best.score) return;
    this.best = { day, score };
    const shot = this.capture();
    if (!shot) return;
    this.images[day] = shot;
    const days = Object.keys(this.images).map(Number).sort((a, b) => a - b);
    for (const d of days.slice(0, Math.max(0, days.length - MAX_IMAGES))) delete this.images[d];
    this.saveImages();
  }

  private capture(): string | null {
    try {
      const { width, height } = this.canvas;
      if (!width || !height) return null;
      const small = document.createElement('canvas');
      small.width = IMAGE_WIDTH;
      small.height = Math.round((height / width) * IMAGE_WIDTH);
      const ctx = small.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.canvas, 0, 0, small.width, small.height);
      return small.toDataURL('image/jpeg', 0.75);
    } catch {
      return null;
    }
  }

  private saveImages() {
    // 入りきらなければ、古い絵から消して入れ直す
    for (;;) {
      try {
        localStorage.setItem(IMAGE_KEY, JSON.stringify(this.images));
        return;
      } catch {
        const oldest = Object.keys(this.images).map(Number).sort((a, b) => a - b)[0];
        if (oldest === undefined) return;
        delete this.images[oldest];
      }
    }
  }

  render(): void {
    const { diary } = this.sim;
    const head = el('div', 'diary-head');
    head.append(el('h3', '', '観察日記'));
    const actions = el('div', 'diary-actions');
    const md = el('button', '', 'テキストで書き出す');
    md.type = 'button';
    md.title = '日記の文章を Markdown ファイルとして保存します';
    md.addEventListener('click', () => void this.export('md'));
    const html = el('button', '', '絵つきで書き出す');
    html.type = 'button';
    html.title = '日記を、その日の一枚つきの HTML ファイルとして保存します';
    html.addEventListener('click', () => void this.export('html'));
    md.disabled = html.disabled = diary.length === 0;
    actions.append(md, html);
    head.append(actions);

    const list = el('ol', 'diary-list');
    for (const entry of [...diary].reverse()) list.append(this.entry(entry));
    const empty = diary.length === 0 ? el('p', 'mind-empty', '日記は、毎晩その日の村の様子を書き留めます。最初の一日が終わるのを待ちましょう。') : null;
    this.root.replaceChildren(head, ...(empty ? [empty] : []), list);
  }

  private entry(d: DiaryEntry): HTMLElement {
    const li = el('li', 'diary-entry');
    li.append(el('h4', '', `${d.day}日目　${d.title === `${d.day}日目` ? '' : d.title}`));
    const img = this.images[d.day];
    if (img) {
      const pic = el('img', 'diary-image');
      pic.src = img;
      pic.alt = `${d.day}日目の村の様子`;
      li.append(pic);
    }
    for (const para of d.body.split(/\n+/)) li.append(el('p', d.plain ? 'diary-plain' : '', para));
    return li;
  }

  private async export(kind: 'md' | 'html') {
    const name = `ひだまり村観察日記.${kind}`;
    const text = kind === 'md' ? this.markdown() : this.html();
    const { isTauri, invoke } = await import('@tauri-apps/api/core');
    if (isTauri()) {
      try {
        const path = await invoke<string>('save_export', { fileName: name, contents: text });
        alert(`保存しました：${path}`);
      } catch (e) {
        alert(`保存できませんでした：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'md' ? 'text/markdown' : 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private markdown(): string {
    return [
      '# ひだまり村 観察日記',
      '',
      ...this.sim.diary.flatMap((d) => [`## ${d.day}日目　${d.title === `${d.day}日目` ? '' : d.title}`.trim(), '', d.body, '']),
    ].join('\n');
  }

  private html(): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const days = this.sim.diary
      .map((d) => {
        const img = this.images[d.day] ? `<img src="${this.images[d.day]}" alt="${d.day}日目の村の様子">` : '';
        const body = d.body
          .split(/\n+/)
          .map((p) => `<p>${esc(p)}</p>`)
          .join('');
        return `<article><h2>${d.day}日目　${esc(d.title === `${d.day}日目` ? '' : d.title)}</h2>${img}${body}</article>`;
      })
      .join('\n');
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ひだまり村 観察日記</title>
<style>
body{margin:0;padding:24px 16px;background:#1d1a26;color:#f3ecdf;font-family:'Hiragino Sans','Yu Gothic',sans-serif;line-height:1.9}
main{max-width:640px;margin:0 auto}h1{font-size:22px}h2{font-size:17px;color:#ffcf5c;margin-top:40px}
img{width:100%;image-rendering:pixelated;border:2px solid #4a4260}p{margin:.6em 0}
</style></head><body><main><h1>ひだまり村 観察日記</h1>
${days}
</main></body></html>`;
  }
}

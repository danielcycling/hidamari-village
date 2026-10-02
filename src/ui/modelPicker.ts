import type { OllamaClient } from '../ai/llm';
import type { Simulation } from '../world/sim';

const STORAGE_KEY = 'hidamari-village/model';

/** 前回選んだモデル（なければ null） */
export function savedModel(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** ヘッダーの「AIのモデル」選び。手元にあるモデルを並べ、選んだものを次回も使う */
export class ModelPicker {
  private readonly select = document.getElementById('model') as HTMLSelectElement;
  private shown = '';

  constructor(
    private readonly sim: Simulation,
    private readonly llm: OllamaClient,
  ) {
    this.select.addEventListener('change', () => void this.choose(this.select.value));
  }

  /** 手元のモデルが分かったら選択肢を作り直す（毎フレーム呼んでよい） */
  refresh(): void {
    const key = `${this.llm.model}|${this.llm.models.map((m) => m.name).join(',')}`;
    if (key === this.shown) return;
    this.shown = key;
    this.select.hidden = this.llm.models.length === 0;
    this.select.replaceChildren(
      ...this.llm.models.map((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        // R1系の推論モデルは、考える過程を省いても決まった形（JSON）で答えられないので選べない
        opt.textContent = `${m.name}（${m.sizeGB}GB${m.reasoning ? '・推論モデルのため使えない' : ''}）`;
        opt.disabled = m.reasoning;
        opt.selected = m.name === this.llm.model;
        return opt;
      }),
    );
  }

  private async choose(name: string) {
    if (!name || name === this.llm.model) return;
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // 保存できなくても、今回は切り替える
    }
    await this.llm.useModel(name);
    this.sim.log(`AIのモデルを ${name} に切り替えた`, 'system');
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmStatus = 'connecting' | 'ready' | 'offline';

/** 手元にあるモデル */
export interface ModelInfo {
  name: string;
  /** ディスク上の大きさ（GB） */
  sizeGB: number;
  /** 考えてから答える（推論）モデルか */
  reasoning: boolean;
}

/** 会話向きで、手元にあれば優先して使うモデル（上ほど優先） */
const PREFERRED_MODELS = [
  'qwen2.5:7b-instruct',
  'qwen2.5:7b',
  'qwen3:8b',
  'gemma3:12b',
  'qwen2.5:14b',
  'gemma3:4b',
];

/** 推論モデルは考える時間が長く、村人のセリフには向かない */
const isReasoningModel = (name: string) => /(^|[-_:/])r1|deepseek-r1|R1-Distill/i.test(name);
const isEmbeddingModel = (name: string) => /embed/i.test(name);

/** 1回のリクエストを待つ上限（打ち切りは Ollama の負担になるので、よほどのときだけ） */
const REQUEST_TIMEOUT_MS = 300_000;
/** 接続が切れたあと、つなぎ直すまでの間 */
const RECONNECT_DELAY_MS = 5_000;

export class OllamaClient {
  status: LlmStatus = 'connecting';
  model: string | null = null;
  /** 手元にあるモデル（埋め込み用は除く） */
  models: ModelInfo[] = [];
  /** 今のモデルが「考える」機能を持つか（持つなら think: false で考える過程を省く） */
  private thinking = false;
  /**
   * 同時に投げてよいリクエスト数。Ollama 0.32 は1件ずつ処理する（-np 1）ので、
   * 多く投げても順番待ちが伸びるだけ。待ちきれずに打ち切ったリクエストが溜まると Ollama が固まることがあるので、
   * 次の1件を待たせておく程度にとどめる。
   */
  readonly maxParallel = 2;
  /** 応答待ちのリクエスト数 */
  private inFlight = 0;

  /**
   * baseUrl：ブラウザ版は Vite の中継（/ollama）、デスクトップ版は Ollama そのもの。
   * fetchImpl：デスクトップ版はアプリ本体を通して通信する（ブラウザの接続制限を受けないように）
   */
  constructor(
    private baseUrl = '/ollama',
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** つなぐ先を変える（デスクトップ版で、準備ができてから） */
  configure(baseUrl: string, fetchImpl: typeof fetch): void {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  /** 使えるモデルを探して選ぶ。見つからなければ offline */
  async connect(requested?: string | null): Promise<void> {
    this.status = 'connecting';
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models: { name: string; size: number }[] };
      this.models = data.models
        .filter((m) => !isEmbeddingModel(m.name))
        .map((m) => ({ name: m.name, sizeGB: Math.round((m.size / 1e9) * 10) / 10, reasoning: isReasoningModel(m.name) }))
        .sort((a, b) => Number(a.reasoning) - Number(b.reasoning) || a.sizeGB - b.sizeGB);
      const names = this.models.map((m) => m.name);
      const model =
        (requested && names.find((n) => n === requested)) ||
        PREFERRED_MODELS.find((p) => names.includes(p)) ||
        this.models.find((m) => !m.reasoning)?.name ||
        null;
      if (model) await this.useModel(model);
      this.status = this.model ? 'ready' : 'offline';
    } catch {
      this.status = 'offline';
    }
  }

  /** 使うモデルを切り替える（考える機能の有無を調べ、先にメモリへ載せておく） */
  async useModel(name: string): Promise<void> {
    this.model = name;
    this.thinking = false;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });
      const info = (await res.json()) as { capabilities?: string[] };
      this.thinking = info.capabilities?.includes('thinking') ?? false;
    } catch {
      this.thinking = /qwen3|gpt-oss|r1/i.test(name);
    }
    void this.warmUp();
  }

  /** これ以上は同時に投げないほうがいい */
  get busy(): boolean {
    return this.inFlight >= this.maxParallel;
  }

  /** 同時に投げられる数を超えて、待たせているリクエストの数 */
  get queued(): number {
    return Math.max(0, this.inFlight - this.maxParallel);
  }

  /** 何かしら考えている最中か（表示用） */
  get working(): boolean {
    return this.inFlight > 0;
  }

  /** JSONスキーマに沿った出力を1回で受け取る */
  async chatJSON<T>(messages: ChatMessage[], schema: object, signal?: AbortSignal, maxTokens = 900): Promise<T> {
    if (!this.model) throw new Error('model not selected');
    this.inFlight++;
    // 返事が来ないまま枠を占有し続けないよう、時間を切る（混んでいて待たされる分も含む）
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await this.request<T>(messages, schema, signal ? AbortSignal.any([signal, timeout]) : timeout, maxTokens);
    } catch (e) {
      // fetch 自体が失敗した：いったん offline にして、少し待ってつなぎ直す
      if (e instanceof TypeError && this.status === 'ready') {
        this.status = 'offline';
        setTimeout(() => void this.connect(this.model), RECONNECT_DELAY_MS);
      }
      throw e;
    } finally {
      this.inFlight--;
    }
  }

  private async request<T>(messages: ChatMessage[], schema: object, signal: AbortSignal, maxTokens: number): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: schema,
        keep_alive: '30m',
        ...(this.thinking ? { think: false } : {}),
        // Ollama の既定の文脈長（2048）だと長いプロンプトが黙って切られるので広げる
        options: { temperature: 0.9, num_predict: maxTokens, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message: { content: string } };
    return JSON.parse(data.message.content) as T;
  }

  /** 最初の会話で待たされないよう、モデルを先にメモリへ載せておく */
  private async warmUp() {
    await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, keep_alive: '30m' }),
    }).catch(() => undefined);
  }

}

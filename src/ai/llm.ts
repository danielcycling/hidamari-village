export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmStatus = 'connecting' | 'ready' | 'offline';

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

export class OllamaClient {
  status: LlmStatus = 'connecting';
  model: string | null = null;
  /**
   * 同時に投げてよいリクエスト数。Ollama は並列リクエストをまとめて処理するので、
   * 1件ずつより数件まとめたほうが全体では速い（M2で4件同時なら約2倍）。
   */
  readonly maxParallel = 3;
  /** 応答待ちのリクエスト数 */
  private inFlight = 0;

  constructor(private readonly baseUrl = '/ollama') {}

  /** 使えるモデルを探して選ぶ。見つからなければ offline */
  async connect(requested?: string | null): Promise<void> {
    this.status = 'connecting';
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models: { name: string }[] };
      const names = data.models.map((m) => m.name);
      this.model =
        (requested && names.find((n) => n === requested)) ||
        PREFERRED_MODELS.find((p) => names.includes(p)) ||
        names.find((n) => !isReasoningModel(n) && !isEmbeddingModel(n)) ||
        null;
      this.status = this.model ? 'ready' : 'offline';
      if (this.model) void this.warmUp();
    } catch {
      this.status = 'offline';
    }
  }

  /** これ以上は同時に投げないほうがいい */
  get busy(): boolean {
    return this.inFlight >= this.maxParallel;
  }

  /** 何かしら考えている最中か（表示用） */
  get working(): boolean {
    return this.inFlight > 0;
  }

  /** JSONスキーマに沿った出力を1回で受け取る */
  async chatJSON<T>(messages: ChatMessage[], schema: object, signal?: AbortSignal): Promise<T> {
    if (!this.model) throw new Error('model not selected');
    this.inFlight++;
    try {
      return await this.request<T>(messages, schema, signal);
    } catch (e) {
      if (e instanceof TypeError) this.status = 'offline'; // fetch 自体が失敗した
      throw e;
    } finally {
      this.inFlight--;
    }
  }

  private async request<T>(messages: ChatMessage[], schema: object, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: schema,
        keep_alive: '30m',
        ...(this.supportsThinkToggle() ? { think: false } : {}),
        // Ollama の既定の文脈長（2048）だと長いプロンプトが黙って切られるので広げる
        options: { temperature: 0.9, num_predict: 900, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message: { content: string } };
    return JSON.parse(data.message.content) as T;
  }

  /** 最初の会話で待たされないよう、モデルを先にメモリへ載せておく */
  private async warmUp() {
    await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, keep_alive: '30m' }),
    }).catch(() => undefined);
  }

  private supportsThinkToggle(): boolean {
    return /qwen3|gpt-oss/i.test(this.model ?? '');
  }
}

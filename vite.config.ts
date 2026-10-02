import { defineConfig } from 'vite';

// ブラウザから直接 Ollama を叩くと CORS 設定が必要になるため、同一オリジンで中継する
const ollamaProxy = {
  '/ollama': {
    target: 'http://localhost:11434',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/ollama/, ''),
  },
};

export default defineConfig({
  server: { proxy: ollamaProxy },
  preview: { proxy: ollamaProxy },
});

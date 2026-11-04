import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { createAndroidRiskDiagnostics } from './server/lib/android-risk-diagnostics.mjs';
import { createDailyPriceClient } from './server/lib/daily-price-client.mjs';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'android-risk-diagnostics-preview',
    configureServer(server) {
      const service = createAndroidRiskDiagnostics({ projectRoot: process.cwd() });
      const daily = createDailyPriceClient({ projectRoot: process.cwd() });
      server.middlewares.use('/api/bi-price-lookup', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ message: '请使用POST查询。' })); return; }
        try {
          let text = '';
          for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) throw new Error('查询内容过大'); }
          const body = JSON.parse(text), ppvs = body.ppv ?? body.ppvs;
          if (!Array.isArray(ppvs) || !ppvs.length || ppvs.length > 1000 || ppvs.some(p => typeof p !== 'string' || p.length > 500)) throw new Error('PPV列表无效');
          res.end(JSON.stringify(await daily.lookup(ppvs)));
        } catch (error) { res.statusCode = 502; res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Daily Price查询失败' })); }
      });
      server.middlewares.use('/api/risk-price-diagnostics', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ message: '请使用POST查询。' })); return; }
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 32768) throw new Error('查询内容过大'); }
          res.end(JSON.stringify(await service.lookup(JSON.parse(body))));
        } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ message: error instanceof Error ? error.message : '诊断查询失败' })); }
      });
    },
  }],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 8001,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.PRICE_MONITOR_PROXY_TARGET || 'http://127.0.0.1:8788',
        changeOrigin: false,
      },
    },
  },
});

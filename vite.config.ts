import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4100' },
    // Runtime databases, backups and native test tools must not be watched or served.
    watch: { ignored: ['**/.local/**', '**/backups/**', '**/test-results/**'] },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/backups/**'] },
  },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4100' } },
  build: { rollupOptions: { output: { manualChunks: { charts: ['echarts'], ui: ['antd', '@ant-design/icons'] } } } },
});

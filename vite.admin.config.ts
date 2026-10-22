// The owner's admin console (admin.html), built in its own pass after the app so it shares no chunks
// with it: the app's start-up download stays exactly the same, and the service worker never sees it.
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    emptyOutDir: false,
    rolldownOptions: {
      input: { admin: 'admin.html' },
      output: { entryFileNames: 'assets/admin-[hash].js', chunkFileNames: 'assets/admin-[name]-[hash].js', assetFileNames: 'assets/admin-[name]-[hash][extname]' },
    },
  },
});

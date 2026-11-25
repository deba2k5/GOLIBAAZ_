import { type Plugin, defineConfig } from 'vite';
import { attachRelay } from './server/relay.mjs';

/** Runs the versus relay on the same port as the dev / preview server, at /ws. */
function relay(): Plugin {
  return {
    name: 'golibaaz-relay',
    configureServer(server) {
      if (server.httpServer) attachRelay(server.httpServer);
    },
    configurePreviewServer(server) {
      attachRelay(server.httpServer);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [relay()],
  server: { port: 5173, strictPort: false },
  build: { chunkSizeWarningLimit: 2500 },
});

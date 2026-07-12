import { defineConfig } from "vite";

// クライアント開発サーバー設定。API/WebSocketはNode.jsサーバー(3777)へ中継する
export default defineConfig({
  root: "client",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3777",
      "/ws": {
        target: "ws://localhost:3777",
        ws: true,
      },
    },
  },
});

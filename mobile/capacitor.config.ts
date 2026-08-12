import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.tokenstats.mobile",
  appName: "Token Stats",
  webDir: "dist",
  server: {
    // 开发时可用 androidScheme；生产读本地 dist
    androidScheme: "https",
  },
};

export default config;

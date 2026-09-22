import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Для Docker/Railway: самодостаточный сервер в .next/standalone
  output: "standalone",
};

export default nextConfig;

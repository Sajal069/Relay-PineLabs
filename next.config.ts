import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  agentRules: false,
  logging: { incomingRequests: { ignore: [/^\/api\/provider$/] } },
};

export default config;

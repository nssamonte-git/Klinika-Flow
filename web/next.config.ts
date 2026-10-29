import type { NextConfig } from "next";
const config: NextConfig = {
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  agentRules: false,
  webpack(config, { dev }) {
    // Avoid the Node 25.3 V8 fast-API crash in Webpack's filesystem-cache serializer.
    if (dev) config.cache = false;
    return config;
  },
  serverExternalPackages: ["node:sqlite"],
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
      { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` }
    ] }, { source: "/api/encounters/:id/documents/:documentId", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }, { key: "Content-Security-Policy", value: "sandbox; default-src 'none'; frame-ancestors 'self'" }] }];
  }
};
export default config;

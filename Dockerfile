#Procurement system — single-service production image (design D1/D8/D-S6)
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# postgres-client for pg_dump daily backups (D-S6); chromium deps for headless-shell (C1)
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client ca-certificates fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libpango-1.0-0 libcairo2 fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# native/postinstall scripts required: better-sqlite3 (build), puppeteer (browser download)
RUN npm config set install-scripts true || true \
 && npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

# C1: chrome-headless-shell only (measured 279–330MB PSS — never full chrome)
ENV PUPPETEER_SKIP_DOWNLOAD=false
RUN npx puppeteer browsers install chrome-headless-shell || true

# dashboard Chart.js vendor copy (zero-build SPA, D-S4)
RUN mkdir -p dashboard/vendor && cp node_modules/chart.js/dist/chart.umd.js dashboard/vendor/chart.umd.js || true

EXPOSE 8080
ENV PORT=8080
# DATABASE_URL is the single bootstrap anchor (DECISIONS.md D-S1) — set via platform env
HEALTHCHECK --interval=60s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.text().then(t=>process.exit(t==='{\"status\":\"ok\"}'?0:1))).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

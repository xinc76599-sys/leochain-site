# 在仓库根目录构建：docker build -f server/Dockerfile -t leoquant-server .
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY server/src server/src
COPY quant/core.js quant/core.js
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data LIVE_TRADING=false
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server/src/index.js"]

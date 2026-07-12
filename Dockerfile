FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8090 \
    PULSEBOARD_DATA_DIR=/data \
    HOST_PROC=/host/proc \
    HOST_SYS=/host/sys

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY src ./src

RUN mkdir -p /data
EXPOSE 8090
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8090/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]

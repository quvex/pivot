# Pivot, hosted for many visitors (see lib/hosted.mjs). The server keeps no visitor data; the daily
# pull lives in /tmp and is fetched again after a restart.
FROM node:20-slim
ENV NODE_ENV=production PIVOT_HOSTED=1 PIVOT_DATA_DIR=/tmp/pivot TZ=America/New_York PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib lib
COPY public public
COPY server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]

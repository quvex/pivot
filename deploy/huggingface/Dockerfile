# Pivot on a Hugging Face Space (free CPU). The Space holds only this file and its README: the
# app is cloned from GitHub at build time, at the commit the deploy workflow writes below.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG REPO=https://github.com/quvex/pivot
ARG COMMIT=main
RUN git clone "$REPO" /app && cd /app && git checkout "$COMMIT"
WORKDIR /app
RUN npm ci --omit=dev && npm cache clean --force
# Spaces run as user 1000 and wipe the disk on restart: keep data in /tmp
ENV NODE_ENV=production PIVOT_HOSTED=1 PIVOT_DATA_DIR=/tmp/pivot TZ=America/New_York PORT=7860
EXPOSE 7860
CMD ["node", "server.mjs"]

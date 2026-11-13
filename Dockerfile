# The wiki as one container: the Next.js server with git for the page history. Data (pages,
# database, stored files) lives on a mounted volume at /data, so a rebuild never touches it.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && rm -rf .next/cache

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git tini ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory '*'
WORKDIR /app
ENV NODE_ENV=production WIKI_DATA_DIR=/data PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/package.json /app/next.config.mjs ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/.next .next
COPY --from=build /app/public public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-p", "3000"]

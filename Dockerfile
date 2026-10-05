# Generic container for any host (Railway, Fly.io, Cloud Run, a VPS). Configure with environment
# variables only; see .env.example. Never bake secrets into the image.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-4100}/healthz" >/dev/null || exit 1
CMD ["node", "server/index.js"]

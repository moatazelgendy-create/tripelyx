# syntax=docker/dockerfile:1.7
# Generic container for any host (Railway, Fly.io, Cloud Run, a VPS). Configure with environment
# variables only; see .env.example. Never bake secrets into the image.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
# Amazon RDS certificate authorities, so the app can verify the database's TLS certificate.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-4100}/healthz" >/dev/null || exit 1
CMD ["node", "server/index.js"]

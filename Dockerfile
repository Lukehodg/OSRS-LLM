# Container image for Fly.io, a VPS, or any Docker host.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
# Simple health check hits the built-in /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

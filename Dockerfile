FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so this layer is cached across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

USER node
EXPOSE 3000

CMD ["node", "server/index.js"]

FROM node:lts-trixie-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

RUN npm prune --omit=dev

CMD ["node", "dist/index.js"]

# Stage 1: Build client
FROM node:20-alpine AS builder

WORKDIR /app

# Install server deps
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# Install client deps
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install

# Copy source
COPY . .

# Build client
RUN cd client && npx vite build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install clawhub globally
RUN npm i -g clawhub

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --omit=dev && npm install tsx

# Copy server source + built client + data defaults
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/vite.config.* ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/data ./data

# Create upload directory
RUN mkdir -p uploads

EXPOSE 3001

ENV NODE_ENV=production

CMD ["npx", "tsx", "server/index.ts"]

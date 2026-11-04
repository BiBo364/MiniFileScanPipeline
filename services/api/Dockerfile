FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/api/package.json services/api/package.json
COPY services/worker/package.json services/worker/package.json
RUN npm ci

COPY packages packages
COPY services services
COPY db db
RUN npm run build
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

EXPOSE 3000
CMD ["npm", "start", "--workspace", "@mini-scan/api"]

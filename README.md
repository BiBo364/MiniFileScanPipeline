# Mini File Scan Pipeline

Portfolio project: an HTTP API that accepts file uploads and a worker that scans them asynchronously via RabbitMQ.

This repo is built in stages. Stage 1 provides the monorepo skeleton, typed config, Postgres + RabbitMQ via Docker Compose, and `GET /health`.

## Stage 1 — run locally

```bash
cp .env.example .env
docker compose up -d
npm install
npm run build
npm start
```

In another terminal:

```bash
curl http://localhost:3000/health
```

A full architecture README lands in Stage 6.

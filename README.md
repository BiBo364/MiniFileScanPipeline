# Mini File Scan Pipeline

A small event-driven system that mimics how a malware-scanning platform processes
file uploads asynchronously. Users upload a file through an HTTP API, a job is queued
in RabbitMQ, and a separate worker scans the file and stores the verdict. Clients
poll the API for the result.

## Highlights
- Two services (API and worker) communicating through RabbitMQ
- Idempotent processing: duplicate messages or duplicate uploads are handled once
- Retry with backoff and a dead-letter queue for jobs that keep failing
- Graceful shutdown and structured JSON logging
- Unit and integration tests with Jest, run in CI with GitHub Actions
- Runs with a single command: `docker compose up`

## Tech stack
Node.js, TypeScript, Fastify, RabbitMQ, PostgreSQL, Jest, Docker Compose, GitHub Actions

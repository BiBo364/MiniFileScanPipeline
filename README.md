# Mini File Scan Pipeline

Mini File Scan Pipeline is a small portfolio project that demonstrates asynchronous file processing. An HTTP API stores an uploaded file and creates a scan job. A separate worker reads the job from RabbitMQ, checks the file, and saves a result in PostgreSQL.

## Architecture

```mermaid
flowchart LR
  Client[Client] -->|POST /scans| API[Fastify API]
  API -->|write file| Files[(Shared upload volume)]
  API -->|insert scan and outbox event in one transaction| DB[(PostgreSQL)]
  DB -->|pending scan event| Outbox[Outbox dispatcher]
  Outbox -->|publisher-confirmed scan job| MQ[(RabbitMQ)]
  MQ -->|scan.jobs| Worker[Scan worker]
  Worker -->|read file| Files
  Worker -->|save status and result| DB
  Worker -->|delayed retries / exhausted jobs| MQ
  Client -->|GET /scans/:id| API
```

PostgreSQL stores scan state, result details, and pending outbox events. The file itself stays on a shared local Docker volume, so both API and worker use the same path. RabbitMQ carries only the scan ID, expected SHA-256, and stored file path.

## Build stages

1. **Project skeleton and health:** created the npm workspaces, shared typed configuration, Docker Compose infrastructure for PostgreSQL and RabbitMQ, and `GET /health` dependency checks.
2. **Database and HTTP API:** added SQL migrations, `POST /scans` multipart uploads with SHA-256 hashing and safe stored paths, and `GET /scans/:id` polling.
3. **Scan worker:** added a RabbitMQ consumer that verifies the stored file hash, checks the built-in EICAR signature and configurable blocklist, flags dangerous extensions and oversize files, and saves `Clean` or `Malicious` results.
4. **Reliability:** added a unique SHA-256 index, duplicate-upload reuse, transactional job claims, manual acknowledgements, delayed retries, a dead-letter queue, and graceful worker shutdown.
5. **Tests and CI:** added Jest/ts-jest unit tests and a Docker Compose integration test for upload through completed result, including duplicate upload/message behavior. GitHub Actions runs lint, build, coverage, and integration checks.
6. **Documentation and full local stack:** documented the architecture and design decisions and added API/worker containers so one Compose command starts the complete project.
7. **Transactional outbox:** writes the scan and its publish event in one database transaction, then dispatches pending events with RabbitMQ publisher confirms. The API retries after broker reconnects, and the Compose worker restarts if its broker connection closes.

## Run the stack

Requirements: Docker with the Docker Compose plugin.

Start PostgreSQL, RabbitMQ, the API, and the worker with one command:

```bash
docker compose up
```

The API listens at `http://localhost:3000`. RabbitMQ management is available at `http://localhost:15672` with the local development credentials `miniscan` / `miniscan`.

The Compose defaults are for local development only. To customize ports, database settings, scanner rules, or retry behavior, copy `.env.example` to `.env` and edit the values. If you change PostgreSQL or RabbitMQ credentials, update the corresponding `COMPOSE_DATABASE_URL` or `COMPOSE_RABBITMQ_URL` as well.

Compose builds service images on the first run. Add `--build` to force a rebuild after changing code.

Stop the containers with `docker compose down`. Named volumes preserve the database and uploaded files. To also delete that local data, run `docker compose down -v`.

## Try the API

Upload a file (the API accepts files up to 10 MB):

```bash
curl -X POST http://localhost:3000/scans \
  -F "file=@./sample.txt"
```

The API returns `202 Accepted` with a `scanId`. Poll the result:

```bash
curl http://localhost:3000/scans/<scanId>
```

Possible statuses are `Queued`, `Scanning`, `Clean`, `Malicious`, and `Failed`. Check API, worker, and dependency health with:

```bash
curl http://localhost:3000/health
docker compose logs -f api worker
```

## Design decisions

- **Content-based deduplication:** PostgreSQL enforces a unique SHA-256. A repeated upload returns the existing scan ID and does not publish another job.
- **Transactional claim:** the worker locks a scan row and changes `Queued` to `Scanning` in one transaction. A duplicate delivery cannot claim a job already in progress or in a terminal state.
- **Acknowledgements:** the worker acknowledges a completed message only after it saves the result. Failed processing is sent through exponential-delay retry queues; after the configured attempt limit it moves to the dead-letter queue and is marked `Failed`.
- **Transactional outbox:** the scan row and intent to publish are committed together. A dispatcher publishes pending events and marks them complete only after RabbitMQ confirms receipt.
- **Filename safety:** client filenames are sanitized for display. Files are stored under generated scan IDs, so client paths never determine storage paths.
- **Scanner scope:** this is a pipeline simulation, not a full antivirus engine. It checks known SHA-256 signatures, filename extensions, file size, and stored-file integrity.
- **Delivery trade-off:** a crash after RabbitMQ confirms a publish but before PostgreSQL marks the outbox row complete can cause a duplicate message. The worker's transactional status claim makes that duplicate harmless.
- **Storage trade-off:** a shared Docker volume keeps local setup simple. A multi-host production deployment would use durable object storage or a shared file service.

## Configuration

Configuration is read from environment variables and validated at startup. `.env.example` lists the available settings. The main scanner and retry settings are:

- `SCAN_BLOCKLIST_SHA256`: comma-separated additional SHA-256 signatures; the EICAR test signature is built in.
- `DANGEROUS_FILE_EXTENSIONS`: comma-separated extensions to flag.
- `SCAN_MAX_FILE_BYTES`: worker-side size limit.
- `SCAN_MAX_ATTEMPTS`: total processing attempts before dead-lettering.
- `SCAN_RETRY_BASE_DELAY_MS`: base delay; each later retry doubles it.
- `OUTBOX_POLL_INTERVAL_MS`: delay between checks when no unpublished event is available.

## What I would improve next

- Replace signature and extension checks with a real malware scanning engine in an isolated environment.
- Move uploads to object storage and add retention/deletion policies.
- Add authentication, rate limiting, metrics, and multi-worker load tests.
- Add retention for published outbox rows and alerts for events that remain pending too long.

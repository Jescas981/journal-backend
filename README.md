# Journal backend

Independent Node.js 24 API for tasks, journals, Google OAuth/Calendar and Firestore/Cloud Storage. SQLite remains available for local testing.

## Setup

```sh
npm ci
npm run dev
```

The existing private .env is preserved. For a new installation, start from .env.cloud.example and configure your own values. Do not replace existing credentials or the Calendar encryption key. API entry point: src/index.ts. Cloud adapters: src/infrastructure/firestore/. This project's own types and calculations: src/domain/. No sibling folder or shared package is required.

```sh
npm run build
npm test
npm run test:cloud
npm run test:api
npm run lint
npm run format
```

APP_ORIGIN is the public frontend origin. The frontend/gateway forwards /api and /auth while preserving that host, cookies and Origin. Local server settings and credentials live in .env; deployed settings live in deploy/ and Secret Manager. Migration snapshots and data are excluded from Git and container builds.

## Docker and Cloud Run

Run from this folder:

```sh
docker build -t journal-backend:local .
```

The production image defaults to Firestore and listens on PORT (8080 by default). For a disposable SQLite startup check:

```sh
docker run --rm -p 8081:8080 \
  -e DATA_BACKEND=sqlite -e APP_ORIGIN=http://localhost:8081 \
  journal-backend:local
```

See [deploy/README.md](deploy/README.md) for Cloud Run settings. All build and deployment commands use this folder as their context. Existing deployment configuration is preserved; reorganizing these files does not redeploy the service.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layers, dependency injection, repository contracts and conventions for .d.ts files. HTTP controllers, application services and persistence implementations have separate responsibilities.

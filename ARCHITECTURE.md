# Backend architecture

The backend is a layered modular monolith with explicit dependency injection and repository ports. It runs as one Node.js process. No dependency injection framework or decorators are required.

## Responsibilities

- `src/domain/`: task and scheduling rules, score calculations, input policies and domain types. No HTTP, database SDKs or infrastructure imports.
- `src/application/services/`: use cases grouped by tasks, goals, templates, entries, images and reports. Dependencies arrive as function arguments; services depend on repository interfaces.
- `src/application/ports/journal-repository.d.ts`: persistence contracts owned by the application, with smaller interfaces per feature. Neither SQLite nor Firestore defines the API's contract.
- `src/http/controllers/`: maps each endpoint's methods, query parameters, request bodies and responses to services.
- `src/http/router.ts` and `body.ts`: route lookup, origin validation, payload limits and HTTP error handling.
- `src/infrastructure/sqlite/` and `src/infrastructure/firestore/`: concrete persistence and Google integration implementations. Transactions, SQL and SDK calls stay here.
- `src/bootstrap/`: the composition root. Registers providers, selects the configured provider and constructs the concrete dependencies.
- `src/index.ts`: environment loading, server startup and shutdown.

The dependency direction is HTTP → application → domain. Infrastructure implements the application contracts and can use domain rules. Only bootstrap knows how to construct a concrete provider. A test enforces these import boundaries, including type imports.

## Dependency injection

`createServices(repository)` supplies each service with the interface it needs. `createRouter(services)` receives those services; it does not construct a database. `createPersistence(name, config, registry)` looks up a registered provider rather than branching over database implementations. The default registry contains SQLite and Firestore; tests inject substitutes without accessing Google.

Adding a provider means implementing the repository contract and registering its factory in bootstrap. Route handlers and application services do not change. Validation conditions remain ordinary conditions because they express rules rather than dependency selection.

## Types

Named interfaces and type aliases live in `.d.ts` modules. Files containing only contracts use names such as `contracts.d.ts`; types accompanying an implementation use names such as `models.types.d.ts`. Runtime code uses `import type`. Declaration modules have no runtime implementation and must never be imported as values. Classes that execute code, such as errors, remain in `.ts` files.

TypeScript verifies the contracts, including declaration files. The architecture test also prevents named type declarations from being introduced back into implementation files.

## Compatibility and remaining boundaries

API paths, persisted documents, SQLite schema, Google credentials and Calendar synchronization semantics are retained. `task-api.ts` is a small compatibility factory; `tasks.ts` preserves the existing SQLite test entry point. Production startup constructs its dependencies through bootstrap.

Unsupported writes to report endpoints now return 405. Previously the generic write branch could fall through to task creation. Supported frontend operations keep their existing status codes.

The SQLite transactional task/template implementation remains in its adapter, while the Firestore task workflow operates on domain record snapshots. These paths retain historical differences and are protected by the existing parity tests. OAuth and Calendar still have provider-specific implementations. This is a layered refactor, not a claim that every legacy integration has been rewritten into pure domain services.

Firestore retains its existing 20,000-character journal limit and SQLite its 100,000-character limit. Projection records keep historical fields; more restrictive DTO mapping can be added separately without coupling the application to either SDK.

## Verification

From this project folder:

```sh
npm run build
npm test
npm run test:cloud
npm run test:api
npm run lint
```

Tests cover dependency boundaries, provider injection, service validation, HTTP contracts, authentication, Calendar synchronization and transaction behavior. They use memory, temporary SQLite files or fake cloud dependencies. No deployment or production data migration is performed by this refactor.

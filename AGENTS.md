# Repository Guidelines

## Project Structure & Module Organization

Eir collects Omron measurements over BLE → ESP32-C3 → MQTT → Go → PostgreSQL, with a mobile-friendly React interface.

- `cmd/eir/`: service entry point.
- `internal/`: HTTP API, MQTT messaging, Omron parsing, firmware validation, and database storage. Schema and migrations live in `internal/store/`; OpenAPI lives in `internal/server/openapi.json`.
- `web/src/`: React/TypeScript UI and styles; `web/tests/`: domain tests.
- `firmware/main/`: ESP-IDF C++ firmware and embedded debug page; `firmware/tests/`: native tests.
- `scripts/`: integration tests, backup/restore, OTA, and observation tools.
- `docs/`: deployment, protocol, lifecycle rules, and acceptance evidence.

## Build, Test, and Development Commands

- `make test`: run Go tests and Python `unittest` tests.
- `make build`: install frontend dependencies, build TypeScript/Vite assets, and compile `bin/eir`.
- `cd web && npm test`: run Node's built-in test runner.
- `cd web && npm run dev`: start Vite; `/api` proxies to localhost:8080, overridable with `EIR_DEV_API`.
- `docker compose up -d --build --wait`: run Eir and PostgreSQL after configuring `.env` from `.env.example`.
- `make integration`: run isolated legacy-protocol integration tests.
- `./scripts/lifecycle_integration.sh`: test discovery, binding, reset, and stale-message handling.
- After sourcing ESP-IDF 6.1, run `idf.py -C firmware build`.

## Coding Style & Naming Conventions

Use `gofmt` for Go and check with `go vet ./...`. Follow existing two-space indentation in TypeScript and C++; Python uses four spaces. Use PascalCase React components, camelCase TypeScript helpers, and snake_case JSON fields. Keep changes focused; no repository-wide formatter or frontend linter is configured. Preserve upstream MIT notices.

## Testing Guidelines

Name tests `*_test.go`, `test_*.py`, `*.test.mjs`, or `*_test.cpp`. Compile native firmware tests with `c++ -std=c++17`. No coverage threshold is configured; cover changed behavior, especially deduplication, attribution, generation checks, and interrupted operations. Run `go test -race ./...` for concurrency changes. Verify mobile UI changes at 390px. Distinguish simulated results from physical hardware acceptance in `docs/acceptance.md`.

## Commit & Pull Request Guidelines

This checkout has no Git history or established commit convention. Use concise imperative subjects. PRs should explain behavior, migration effects, validation, and hardware limitations; link relevant issues and include screenshots for UI changes.

## Configuration & Data Safety

Keep credentials, health exports, backups, and raw diagnostic data out of commits. Destructive tests must use isolated `eir-test-*` projects and test MQTT. Preserve live data, device associations, and observation logs. Verify chip/MAC before flashing; prefer OTA for existing Eir devices. Update protocol documentation and OpenAPI alongside interface changes.

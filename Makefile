.PHONY: test build web up down logs backup integration image-multi

test:
	go test ./...
	python3 -m unittest discover -s scripts -p 'test_*.py'

web:
	cd web && npm ci && npm run build

build: web
	go build -o bin/eir ./cmd/eir

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

backup:
	./scripts/backup.sh

integration:
	./scripts/integration.sh

# Example: make image-multi IMAGE=registry.example/eir:0.1.0
image-multi:
	@test -n "$(IMAGE)" || (echo 'Set IMAGE to a registry tag' >&2; exit 1)
	docker buildx build --platform linux/amd64,linux/arm64 -t "$(IMAGE)" --push .

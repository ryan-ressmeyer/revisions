.PHONY: build test lint e2e

EXE := $(shell go env GOEXE)
GOFILES := cmd internal web/embed.go
NPM_DEPS := web/node_modules/.package-lock.json

build: $(NPM_DEPS)
	cd web && npm run build
	go build -o bin/revisions$(EXE) ./cmd/revisions

test: $(NPM_DEPS)
	go test ./cmd/... ./internal/... ./web
	cd web && npm test

lint: $(NPM_DEPS)
	@test -z "$$(gofmt -l $(GOFILES))" || { echo "gofmt needed:"; gofmt -l $(GOFILES); exit 1; }
	go vet ./cmd/... ./internal/... ./web
	cd web && npm run lint

e2e: build
	cd web && npm run e2e

$(NPM_DEPS): web/package-lock.json
	cd web && npm ci

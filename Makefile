# Local environment: Postgres (docker) + API/worker (:3001) + Next.js dev server (:3000).
# `make up` runs everything in the background; `make down` stops it.

DEV_DIR := .dev
PID     := $(DEV_DIR)/dev.pid
LOG     := $(DEV_DIR)/dev.log

.PHONY: up down logs

up:
	@test -f .env || cp .env.example .env
	@test -d node_modules || pnpm install
	docker compose up -d --wait
	@docker compose exec -T postgres psql -U postgres -tc "select 1 from pg_database where datname = 'automations_test'" | grep -q 1 \
		|| docker compose exec -T postgres psql -U postgres -c "create database automations_test" >/dev/null
	@mkdir -p $(DEV_DIR)
	@if [ -f $(PID) ] && kill -0 $$(cat $(PID)) 2>/dev/null; then echo "already running (pid $$(cat $(PID)))"; else \
		nohup perl -e 'setpgrp(0, 0); exec @ARGV' pnpm dev > $(LOG) 2>&1 & echo $$! > $(PID); \
		echo "starting… logs: make logs"; \
		for i in $$(seq 1 60); do curl -sf http://localhost:3000/api/health >/dev/null && break; sleep 1; done; \
		curl -sf http://localhost:3000/api/health >/dev/null && echo "up: http://localhost:3000" || { echo "failed to start, see $(LOG)"; exit 1; }; \
	fi

down:
	@if [ -f $(PID) ]; then kill -TERM -- -$$(cat $(PID)) 2>/dev/null || true; rm -f $(PID); echo "app stopped"; fi
	docker compose down

logs:
	@tail -f $(LOG)

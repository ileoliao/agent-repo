# Thin wrappers around Harbor CLI (Node). Prefer: harbor extension …
EXT ?=
.PHONY: help new dev publish validate
help:
	@echo "Prefer: harbor extension new|dev|publish|validate"
	@echo "make new EXT=<name>       -> harbor extension new"
	@echo "make dev EXT=<name>       -> harbor extension dev"
	@echo "make publish EXT=<name>   -> harbor extension publish (dry-run without PAT)"
	@echo "make validate             -> harbor extension validate"
	@echo "Operator-only sim loop: scripts/fuse-dx.sh (not for community DX)"
need-ext:
	@[ -n "$(EXT)" ] || { echo "Missing EXT. Example: make $(MAKECMDGOALS) EXT=hello-world"; exit 2; }
new: need-ext
	node cli/harbor.mjs extension new "$(EXT)"
dev: need-ext
	node cli/harbor.mjs extension dev "$(EXT)"
publish: need-ext
	node cli/harbor.mjs extension publish "$(EXT)"
validate:
	node cli/harbor.mjs extension validate

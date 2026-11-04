# Thin wrappers around the Harbor CLI (Node). Prefer: node cli/harbor.mjs extension ...
EXT ?=
.PHONY: help new dev publish validate
help:
	@echo "make new EXT=<name> | dev EXT=<name> | validate [EXT=<name>] | publish EXT=<name>"
need-ext:
	@[ -n "$(EXT)" ] || { echo "Missing EXT. Example: make $(MAKECMDGOALS) EXT=hello-world"; exit 2; }
new: need-ext
	node cli/harbor.mjs extension new "$(EXT)"
dev: need-ext
	node cli/harbor.mjs extension dev "$(EXT)"
publish: need-ext
	node cli/harbor.mjs extension publish "$(EXT)"
validate:
	node cli/harbor.mjs extension validate $(EXT)

# Harbor Extensions dev shortcuts. Start here: docs/extension-developer.md
# Typical: make new EXT=my-ext && make try EXT=my-ext
EXT ?=
P ?=
.PHONY: help new validate try publish verify unpublish fuse-publish fuse-verify fuse-dx
help:
	@echo "make new EXT=<name>        scaffold extensions/<name>"
	@echo "make validate              check all extensions"
	@echo "make try EXT=<name>        validate + publish to local sim + verify HTTP 200"
	@echo "make unpublish EXT=<name>  remove it from the local sim again"
	@echo "Docs: docs/extension-developer.md"
need-ext:
	@[ -n "$(EXT)$(P)" ] || { echo "Missing EXT. Example: make $(MAKECMDGOALS) EXT=hello-world"; exit 2; }
new: need-ext
	scripts/new-extension.sh "$(EXT)"
validate:
	scripts/fuse-dx.sh validate
try publish verify unpublish: need-ext
try:
	EXT="$(or $(EXT),$(notdir $(P)))" scripts/fuse-dx.sh dx
publish fuse-publish:
	EXT="$(or $(EXT),$(notdir $(P)))" scripts/fuse-dx.sh publish
verify fuse-verify:
	EXT="$(or $(EXT),$(notdir $(P)))" scripts/fuse-dx.sh verify
unpublish:
	EXT="$(or $(EXT),$(notdir $(P)))" scripts/fuse-dx.sh unpublish
fuse-dx: try

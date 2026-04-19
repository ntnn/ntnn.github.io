GO ?= go
TOOLS_DIR := hack/tools

HUGO_VER := 0.160.1
HUGO := $(TOOLS_DIR)/hugo-$(HUGO_VER)

.PHONY: server
server: $(HUGO)
	$(HUGO) server --buildDrafts

.PHONY: build
build: $(HUGO)
	HUGO_ENVIRONMENT=production $(HUGO) build --minify

$(HUGO):
	mkdir -p $(TOOLS_DIR)
	$(GO) tool github.com/ntnn/mindl download -out $@ \
		-url 'https://github.com/gohugoio/hugo/releases/download/v{{.Version}}/hugo_{{.Version}}_{{.OS}}-{{.Arch}}.tar.gz' \
		-inarchive hugo \
		-version $(HUGO_VER)

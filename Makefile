# DStudio — native desktop app for ds4 (server + agent + design).
#
#   make            macOS: builds DStudio.app (double-click, no Terminal)
#                   Linux: builds ./dstudio (the same app, WebKitGTK window)
#   make run        compiles and starts (opens the window on the interface)
#   make check      full verification: fast tests + real model/web E2E tests
#   make check-fast local unit/UI/HTTP checks without starting a language model
#   make check-real starts the real model and runs live Search/DeepResearch/remote tests
#   make dist-macos builds, smoke-tests and zips the versioned Apple Silicon app
#   make windows    Windows portable zip (run from Windows with PowerShell + toolchains)
#   make install-desktop
#                   Linux: installs the launcher + icon in ~/.local/share
#   make clean      removes the binary and the generated artifacts
#
# Architecture: dstudio.c is the HTTP server (compiled with -DDS4_WITH_WEBVIEW, its
# main becomes ds4_serve_main); app.cc is the entry point that forks the server
# and opens the native webview window (WKWebView on macOS, WebKitGTK on Linux,
# via webview.h). index.html is embedded in the binary in base64 (page_data.h);
# the logo is embedded too (logo_data.h) for the Linux window icon.

CC      ?= cc
WARN_CFLAGS ?= -Wall -Wextra
WARN_CXXFLAGS ?= -Wall
ifeq ($(STRICT_WARNINGS),1)
  WARN_CFLAGS += -Wpedantic -Werror
  WARN_CXXFLAGS += -Wextra -Wpedantic -Werror
endif
CFLAGS  ?= -O2 $(WARN_CFLAGS) -std=c11
PORT    ?= 5500
DS4_DIR ?= ../ds4
VERSION ?= 1.1.0
BUILD_NUMBER ?= 110

BIN      := dstudio
SRC      := src/dstudio.c
# Per-domain sub-files #included into dstudio.c (one translation unit, all
# static — same pattern as the GSA/RSA .cfrag includes). Listed as build
# prerequisites so editing a domain file triggers a rebuild.
SUBSRC   := $(wildcard src/dstudio_*.c) extension/design/design_system_catalog.h extension/remote/dstudio_wire_string.h extension/remote/dstudio_json_tokens.h
EXT_SUBSRC := $(wildcard extension/gsa/*.cfrag extension/rsa/*.cfrag)
APP      := src/app.cc
HDR      := src/webview.h
PAGE     := web/index.html
LOADING  := web/loading.html
ANNOTATOR := web/design-annotator.js
GEN      := src/page_data.h
LOADING_GEN := src/loading_data.h
ANNOTATOR_GEN := src/design_annotator_data.h
SEARCH_RUNTIME := extension/search/runtime.js
SEARCH_SYNC := scripts/sync-search-extension.mjs
LOGO     := assets/logo.png
LOGO_HDR := src/logo_data.h
ICNS     := build/ds4.icns
PLIST    := assets/Info.plist
TEST_BUILD := tests/.build
TEST_UNIT  := $(TEST_BUILD)/lan_unit
TEST_REMOTE_UTF8 := $(TEST_BUILD)/remote_utf8_unit
TEST_COWORK_BRIDGE := $(TEST_BUILD)/ds4_cowork_bridge
TEST_SERVER := $(TEST_BUILD)/dstudio-server-test
TEST_TASK_GRAPH := $(TEST_BUILD)/task_graph_unit
LINUX_APP_ID := dev.ds4.DStudio
DESKTOP  := $(LINUX_APP_ID).desktop
XDG_DATA_HOME ?= $(HOME)/.local/share
DESKTOP_INSTALL_DIR ?= $(XDG_DATA_HOME)/applications
ICON_INSTALL_DIR ?= $(XDG_DATA_HOME)/icons/hicolor/1024x1024/apps

# Webview backend per platform.
UNAME := $(shell uname)
ifeq ($(UNAME),Darwin)
  MACOSX_DEPLOYMENT_TARGET ?= 13.0
  CFLAGS       += -mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
  APPCXX       := clang++
  APP_CXXFLAGS := -x objective-c++ -fno-objc-arc -std=c++11 -O2 $(WARN_CXXFLAGS) \
                  -mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
  APP_LDFLAGS  := -framework Cocoa -framework WebKit \
                  -mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET) \
                  -Wl,-sectcreate,__TEXT,__info_plist,$(PLIST)
  APP_DEPS     := $(HDR)                 # macOS icon comes from the .icns
  BIN_DEPS     := $(ICNS) $(PLIST)       # .icns built by sips/iconutil (macOS-only)
else
  APPCXX       := $(CXX)
  APP_CXXFLAGS := -x c++ -std=c++11 -O2 $(WARN_CXXFLAGS) $(shell pkg-config --cflags gtk+-3.0 webkit2gtk-4.1)
  APP_LDFLAGS  := $(shell pkg-config --libs gtk+-3.0 webkit2gtk-4.1)
  APP_DEPS     := $(HDR) $(LOGO_HDR)     # Linux icon comes from the embedded logo
  BIN_DEPS     :=                        # no .icns on Linux (logo is baked into app.o)
endif

.PHONY: all run check check-fast check-real test-task-graph-unit test-task-graph-http test-task-graph-bench-validate test-task-graph-real test-task-graph-reliability-real test-task-graph-cli-competitors-real test-lan-unit test-remote-utf8 test-cowork test-cowork-unit test-cowork-browser test-cowork-http test-cowork-bench-validate test-design-build-freshness test-design-self test-design-controls test-design-disclosure test-design-interrupt test-design-resume test-design-runtime test-design-bench-validate test-design-release test-image-pipeline test-image-runtime test-ideogram-vae-mps test-hunyuan-sdpa-mps test-frontend-unit test-ui-browser test-ui-live-vision test-ui-plan test-ui-gsa test-ui-rsa test-rsa-collectors test-table-ascii test-markdown-math test-video-open-weight test-http-lan test-gsa-bench-validate test-real-cowork test-real-cowork-long test-real-design test-real-design-long test-real-ascii-diagrams test-real-math-explanations test-real-pdf-rag test-real-search-research test-real-roadmap-quality test-real-remote test-macos-bundle dist-macos clean app windows install-desktop uninstall-desktop

# One `make` gives the right artifact per platform, both branded with the same
# logo: the double-clickable bundle on macOS, the windowed binary on Linux.
ifeq ($(UNAME),Darwin)
all: app
else
all: $(BIN)
ifeq ($(UNAME),Linux)
all: $(DESKTOP)
endif
endif

# macOS bundle: DStudio.app launches with a double click from the Finder, WITHOUT a Terminal.
# The binary in the bundle is copied with -X (no resource fork: codesign rejects
# the "detritus"); the bundle icon comes from the .icns in Resources.
APPNAME := DStudio
APPDIR  := $(APPNAME).app
APP_SUPPORT := $(APPDIR)/Contents/Resources/DStudio
MAC_ARCH := $(shell uname -m)
DIST_DIR := dist
MAC_ZIP := $(DIST_DIR)/$(APPNAME)-$(VERSION)-macOS-$(MAC_ARCH).zip
MAC_SHA := $(MAC_ZIP).sha256
app: $(BIN)
ifeq ($(UNAME),Darwin)
	@rm -rf $(APPDIR)
	@mkdir -p $(APPDIR)/Contents/MacOS $(APP_SUPPORT)/extension/gsa/tools
	@cp -X $(BIN) $(APPDIR)/Contents/MacOS/$(APPNAME)
	@cp $(ICNS) $(APPDIR)/Contents/Resources/ds4.icns
	@cp $(PLIST) $(APPDIR)/Contents/Info.plist
	@cp -R extension/design extension/design-systems extension/cowork extension/remote extension/craft extension/search extension/task-graph $(APP_SUPPORT)/extension/
	@mkdir -p $(APP_SUPPORT)/extension/gsa
	@cp -R extension/gsa/templates $(APP_SUPPORT)/extension/gsa/
	@cp extension/gsa/tools/catalog.json extension/gsa/tools/README.md $(APP_SUPPORT)/extension/gsa/tools/
	@cp -R patch scripts $(APP_SUPPORT)/
	@cp LICENSE THIRD_PARTY_NOTICES.md $(APP_SUPPORT)/
	@find $(APP_SUPPORT) -type f \( -name .DS_Store -o -name '*.pyc' -o -name '*.pyo' \) -delete
	@find $(APP_SUPPORT) -type d -name __pycache__ -empty -delete
	@/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable $(APPNAME)' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string $(APPNAME)' $(APPDIR)/Contents/Info.plist
	@/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile ds4' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string ds4' $(APPDIR)/Contents/Info.plist
	@/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString $(VERSION)' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c 'Add :CFBundleShortVersionString string $(VERSION)' $(APPDIR)/Contents/Info.plist
	@/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion $(BUILD_NUMBER)' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string $(BUILD_NUMBER)' $(APPDIR)/Contents/Info.plist
	@/usr/libexec/PlistBuddy -c 'Set :LSMinimumSystemVersion $(MACOSX_DEPLOYMENT_TARGET)' $(APPDIR)/Contents/Info.plist
	@xattr -cr $(APPDIR)
	@codesign --force --deep -s - $(APPDIR) >/dev/null 2>&1 && echo "$(APPDIR): ad-hoc signature ok" || echo "$(APPDIR): signature skipped"
	@echo "$(APPDIR) ready: double click to start (no Terminal)."
else
	@echo "make app is for macOS only"
endif

test-macos-bundle: app
ifeq ($(UNAME),Darwin)
	@./scripts/smoke-macos-bundle.sh $(APPDIR)
else
	@echo "test-macos-bundle is for macOS only"
endif

dist-macos: test-macos-bundle
ifeq ($(UNAME),Darwin)
	@$(MAKE) --no-print-directory check-engine-upstream ENGINE_UPSTREAM_APP="$(APPDIR)/Contents/MacOS/DStudio" ENGINE_UPSTREAM_PLATFORM=macos
	@mkdir -p $(DIST_DIR)
	@rm -f $(MAC_ZIP) $(MAC_SHA)
	@ditto -c -k --sequesterRsrc --keepParent $(APPDIR) $(MAC_ZIP)
	@cd $(DIST_DIR) && shasum -a 256 $$(basename $(MAC_ZIP)) > $$(basename $(MAC_SHA))
	@echo "$(MAC_ZIP)"
	@echo "$(MAC_SHA)"
else
	@echo "dist-macos is for macOS only"
endif

# Binary icon: logo.png resized into a multi-resolution .icns.
# Applied to the binary resource fork (xattr), NOT to the data fork → the linker
# ad-hoc signature stays valid and the binary runs on arm64.
$(ICNS): $(LOGO)
	@rm -rf build/ds4.iconset && mkdir -p build/ds4.iconset
	@for s in 16 32 128 256 512; do \
	  sips -z $$s $$s $(LOGO) --out build/ds4.iconset/icon_$${s}x$${s}.png >/dev/null 2>&1; \
	  d=$$((s*2)); sips -z $$d $$d $(LOGO) --out build/ds4.iconset/icon_$${s}x$${s}@2x.png >/dev/null 2>&1; \
	done
	@iconutil -c icns build/ds4.iconset -o $(ICNS) && rm -rf build/ds4.iconset
	@echo "$(ICNS): icon generated from $(LOGO) (resized)"

# Embeds index.html in the binary in base64 (generated header).
# tr -d '\n' → pure base64 stream; od/awk emits a numeric char array instead
# of one huge string literal, so strict GCC/Clang builds stay warning-free.
$(PAGE): $(SEARCH_RUNTIME) $(SEARCH_SYNC)
	@node $(SEARCH_SYNC)

$(GEN): $(PAGE)
	@{ \
	  echo '/* GENERATED by Makefile — do not edit. base64 of index.html */'; \
	  echo 'static const char PAGE_B64[] = {'; \
	  base64 < $(PAGE) | tr -d '\n' | od -An -v -tu1 | awk '{ for (i = 1; i <= NF; i++) printf "%s,", $$i }'; \
	  echo '0};'; \
	} > $(GEN)
	@echo "$(GEN): $$(wc -c < $(GEN) | tr -d ' ') bytes"

$(LOADING_GEN): $(LOADING)
	@{ \
	  echo '/* GENERATED by Makefile — do not edit. base64 of loading.html */'; \
	  echo 'static const char LOADING_B64[] = {'; \
	  base64 < $(LOADING) | tr -d '\n' | od -An -v -tu1 | awk '{ for (i = 1; i <= NF; i++) printf "%s,", $$i }'; \
	  echo '0};'; \
	} > $(LOADING_GEN)
	@echo "$(LOADING_GEN): $$(wc -c < $(LOADING_GEN) | tr -d ' ') bytes"

$(ANNOTATOR_GEN): $(ANNOTATOR)
	@{ \
	  echo '/* GENERATED by Makefile — do not edit. base64 of design-annotator.js */'; \
	  echo 'static const char DESIGN_ANNOTATOR_B64[] = {'; \
	  base64 < $(ANNOTATOR) | tr -d '\n' | od -An -v -tu1 | awk '{ for (i = 1; i <= NF; i++) printf "%s,", $$i }'; \
	  echo '0};'; \
	} > $(ANNOTATOR_GEN)
	@echo "$(ANNOTATOR_GEN): $$(wc -c < $(ANNOTATOR_GEN) | tr -d ' ') bytes"

# Embeds assets/logo.png in the binary as raw bytes (generated header), used as
# the GTK window icon on Linux — no asset file at runtime. macOS ignores it (it
# gets its icon from the .icns), so this is only a prerequisite of the Linux build.
$(LOGO_HDR): $(LOGO)
	@{ \
	  echo '/* GENERATED by Makefile — do not edit. bytes of assets/logo.png */'; \
	  echo 'static const unsigned char LOGO_PNG[] = {'; \
	  od -An -v -tu1 < $(LOGO) | awk '{ for (i = 1; i <= NF; i++) printf "%s,", $$i }'; \
	  echo ''; \
	  echo '};'; \
	  echo 'static const unsigned int LOGO_PNG_LEN = sizeof(LOGO_PNG);'; \
	} > $(LOGO_HDR)
	@echo "$(LOGO_HDR): embedded $$(wc -c < $(LOGO) | tr -d ' ') bytes of $(LOGO)"

# HTTP server (dstudio.c) as an object: its main becomes ds4_serve_main.
build/dstudio.o: $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p build
	$(CC) $(CFLAGS) -DDS4_WITH_WEBVIEW -c $(SRC) -o $@

# Entry point + native webview window. On Linux $(APP_DEPS) pulls in logo_data.h.
build/app.o: $(APP) $(APP_DEPS)
	@mkdir -p build
	$(APPCXX) $(APP_CXXFLAGS) -c $(APP) -o $@

$(BIN): build/dstudio.o build/app.o $(BIN_DEPS)
	$(APPCXX) build/dstudio.o build/app.o $(APP_LDFLAGS) -o $@
ifeq ($(UNAME),Darwin)
	@# custom icon in the resource fork; does not touch data fork or signature (see above)
	@cp $(ICNS) .icontmp.icns 2>/dev/null && sips -i .icontmp.icns >/dev/null 2>&1 \
	  && DeRez -only icns .icontmp.icns > .icontmp.rsrc 2>/dev/null \
	  && Rez -append .icontmp.rsrc -o $@ 2>/dev/null \
	  && SetFile -a C $@ 2>/dev/null \
	  && echo "icon applied to $@" \
	  || echo "icon not applied (macOS tools missing?)"; \
	  rm -f .icontmp.icns .icontmp.rsrc
endif

$(DESKTOP): $(BIN) $(LOGO) Makefile
ifeq ($(UNAME),Linux)
	@abs_bin="$$(pwd)/$(BIN)"; \
	abs_icon="$$(pwd)/$(LOGO)"; \
	{ \
	  echo "[Desktop Entry]"; \
	  echo "Type=Application"; \
	  echo "Name=DStudio"; \
	  echo "Comment=Local DS4 desktop studio"; \
	  echo "Exec=$$abs_bin"; \
	  echo "Icon=$$abs_icon"; \
	  echo "Terminal=false"; \
	  echo "Categories=Development;"; \
	  echo "StartupNotify=true"; \
	  echo "StartupWMClass=$(LINUX_APP_ID)"; \
	} > $@
	@chmod 0755 $@
	@echo "$@: desktop launcher generated"
else
	@echo "desktop launcher generation is for Linux only"
endif

install-desktop: $(BIN)
ifeq ($(UNAME),Linux)
	@mkdir -p "$(DESKTOP_INSTALL_DIR)" "$(ICON_INSTALL_DIR)"
	@install -m 0644 "$(LOGO)" "$(ICON_INSTALL_DIR)/$(LINUX_APP_ID).png"
	@abs_bin="$$(pwd)/$(BIN)"; \
	{ \
	  echo "[Desktop Entry]"; \
	  echo "Type=Application"; \
	  echo "Name=DStudio"; \
	  echo "Comment=Local DS4 desktop studio"; \
	  echo "Exec=$$abs_bin"; \
	  echo "Icon=$(LINUX_APP_ID)"; \
	  echo "Terminal=false"; \
	  echo "Categories=Development;"; \
	  echo "StartupNotify=true"; \
	  echo "StartupWMClass=$(LINUX_APP_ID)"; \
	} > "$(DESKTOP_INSTALL_DIR)/$(DESKTOP)"
	@chmod 0644 "$(DESKTOP_INSTALL_DIR)/$(DESKTOP)"
	@command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(DESKTOP_INSTALL_DIR)" >/dev/null 2>&1 || true
	@command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$(XDG_DATA_HOME)/icons/hicolor" >/dev/null 2>&1 || true
	@echo "Installed $(DESKTOP_INSTALL_DIR)/$(DESKTOP)"
else
	@echo "make install-desktop is for Linux only"
endif

uninstall-desktop:
ifeq ($(UNAME),Linux)
	@rm -f "$(DESKTOP_INSTALL_DIR)/$(DESKTOP)" "$(ICON_INSTALL_DIR)/$(LINUX_APP_ID).png"
	@command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(DESKTOP_INSTALL_DIR)" >/dev/null 2>&1 || true
	@command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$(XDG_DATA_HOME)/icons/hicolor" >/dev/null 2>&1 || true
	@echo "Removed Linux desktop launcher/icon"
else
	@echo "make uninstall-desktop is for Linux only"
endif

run: $(BIN)
	./$(BIN) $(PORT) $(DS4_DIR)

# Local checks execute production functions, subprocesses, HTTP and browser flows.
$(TEST_UNIT): tests/unit/lan_unit.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/lan_unit.c -o $@

$(TEST_SERVER): $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $(SRC) -o $@

test-lan-unit: $(TEST_UNIT)
	@$(TEST_UNIT)

.PHONY: test-design-start test-quality-baseline test-launch-preflight test-launch-control test-ui-launch test-agent-spawn
$(TEST_BUILD)/launch_preflight_unit: tests/unit/launch_preflight_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/launch_preflight_unit.c -o $@

test-launch-preflight: $(TEST_BUILD)/launch_preflight_unit
	@$(TEST_BUILD)/launch_preflight_unit

$(TEST_BUILD)/agent_spawn_unit: tests/unit/agent_spawn_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/agent_spawn_unit.c -o $@

test-agent-spawn: $(TEST_BUILD)/agent_spawn_unit
	@$(TEST_BUILD)/agent_spawn_unit

test-design-start: $(TEST_SERVER) test-launch-preflight
	@node tests/unit/design_catalog_test.mjs
	@node tests/unit/loading_launch_test.mjs
	@node tests/integration/design_start_http_test.mjs $(TEST_SERVER)

test-launch-control: $(TEST_SERVER)
	@node tests/integration/launch_control_http_test.mjs $(TEST_SERVER)

test-ui-launch:
	@node tests/browser/ui_launch_control_playwright_test.mjs
	@DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_launch_control_playwright_test.mjs

test-quality-baseline:
	@node tests/unit/quality_baseline_test.mjs
	@node tests/unit/artifact_run_test.mjs

.PHONY: test-common-quality-oracle
test-common-quality-oracle:
	@python3 -B tests/unit/common_model_quality_test.py
	@python3 -B tests/unit/common_quality_interval_oracle_test.py
	@node tests/integration/http_deadline_test.mjs
	@node tests/integration/common_quality_runner_test.mjs
	@node tests/integration/common_quality_regrade_test.mjs
	@node tests/unit/common_quality_summary_test.mjs

.PHONY: test-qwen-quality-chart
test-qwen-quality-chart:
	@python3 tests/unit/qwen_quality_chart_test.py

check-fast: test-qwen-quality-chart

.PHONY: test-q36-retained-diagnostic-inputs
test-q36-retained-diagnostic-inputs:
	@node tests/integration/q36_retained_diagnostic_inputs_test.mjs

ifeq ($(UNAME),Darwin)
check-fast: test-common-quality-oracle test-q36-retained-diagnostic-inputs
endif

.PHONY: test-engine-startup
test-engine-startup: $(TEST_SERVER)
	@node tests/integration/engine_startup_test.mjs $(TEST_SERVER)

check-fast: test-design-start test-quality-baseline test-launch-control test-ui-launch
ifneq ($(OS),Windows_NT)
check-fast: test-engine-startup
endif
ifeq ($(UNAME),Darwin)
check-fast: test-agent-spawn
endif

.PHONY: test-steering test-goal test-steering-patch test-steering-runtime
.PHONY: test-unified-patch test-agent-build test-agent-patch-migration test-agent-native-build test-runtime-patch-migration
.PHONY: test-backend-link test-qwen38-agent test-metal-workspace test-qwen38-tool-oracle
test-backend-link:
	@node tests/integration/backend_link_test.mjs

$(TEST_BUILD)/unified-patch-unit: tests/unit/unified_patch_unit.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/unified_patch_unit.c -o $@

test-unified-patch: $(TEST_BUILD)/unified-patch-unit
	@$(TEST_BUILD)/unified-patch-unit

$(TEST_BUILD)/agent-build-probe: tests/support/agent_build_probe.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/support/agent_build_probe.c -o $@

test-agent-build: $(TEST_BUILD)/agent-build-probe
	@node tests/integration/agent_build_test.mjs $(TEST_BUILD)/agent-build-probe

test-agent-patch-migration:
	@node tests/integration/agent_patch_migration_test.mjs

$(TEST_BUILD)/remote-turn-error-unit: tests/unit/remote_turn_error_unit.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $< -o $@

.PHONY: test-remote-turn-error test-remote-structured-tools
test-remote-turn-error: $(TEST_BUILD)/remote-turn-error-unit
	@$<

# Supply already-built isolated binaries; no implicit user-engine rebuild.
test-remote-structured-tools: $(TEST_BUILD)/remote-turn-error-unit
	@test -n "$(REMOTE_TOOL_AGENT)" || (echo 'Set REMOTE_TOOL_AGENT to a built native Agent binary' && exit 1)
	@node tests/integration/remote_structured_tools_test.mjs "$(REMOTE_TOOL_AGENT)"

check-fast: test-remote-turn-error

test-runtime-patch-migration:
	@node tests/integration/runtime_patch_migration_test.mjs

# macOS: source-only snapshots and real compiler/tool execution, no weights.
AGENT_MAIN_TREE ?= ds4
AGENT_LAGUNA_TREE ?= ds4-laguna-s21
AGENT_QWEN38_TREE ?=
AGENT_QWEN35_TREE ?=
test-agent-native-build: $(TEST_BUILD)/agent-build-probe $(TEST_BUILD)/remote-turn-error-unit
	@test -z "$(AGENT_QWEN35_TREE)" -o -n "$(AGENT_QWEN38_TREE)" || (echo 'AGENT_QWEN35_TREE also requires AGENT_QWEN38_TREE' && exit 1)
	@node tests/integration/agent_native_build_test.mjs "$(AGENT_MAIN_TREE)" "$(AGENT_LAGUNA_TREE)" $(if $(AGENT_QWEN38_TREE),"$(AGENT_QWEN38_TREE)") $(if $(AGENT_QWEN35_TREE),"$(AGENT_QWEN35_TREE)")

# Requires the already built Qwen candidate with the matching native Agent;
# b4c3550 and 0bb323a have identical Agent source. No automatic download.
QWEN38_AGENT_TREE ?= ds4-qwen38
QWEN35_AGENT_TREE ?= ds4-qwen35
QWEN38_AGENT_FLAGS ?= --sanitize

# Explicit diagnostic: currently exposes the reviewed q36 monitor's slow-log
# critical section. Not a passing release gate or a language-model test.
.PHONY: test-q36-monitor-control
test-q36-monitor-control:
	@node tests/integration/q36_monitor_control_test.mjs "$(Q36_SOURCE)" "$(Q36_MONITOR_OBJECTS)" $(Q36_MONITOR_FLAGS)

# Executes the patched native compaction function with controlled session
# failures/cancellation; no model loads or mutations of supplied checkouts.
.PHONY: test-agent-compaction
test-agent-compaction:
	@node tests/integration/agent_compaction_test.mjs "$(AGENT_LAGUNA_TREE)" --family laguna
	@node tests/integration/agent_compaction_test.mjs "$(QWEN35_AGENT_TREE)" --family qwen35

# Reads the real GGUF vocabularies only; does not load weight tensors or run a
# language model. Missing model files are failures, not skipped green checks.
COMPACTION_LAGUNA_MODEL ?= ds4/gguf/laguna-s-2.1-Q4_K_M.gguf
COMPACTION_QWEN35_MODEL ?= ds4/gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
.PHONY: test-agent-continuation test-agent-continuation-oracle test-agent-continuation-live
test-agent-continuation-oracle:
	@node --test tests/unit/agent_continuation_oracle_test.mjs
	@node --test tests/unit/agent_continuation_control_test.mjs

.PHONY: test-agent-idle test-agent-runtime-notice
test-agent-idle:
	@node tests/integration/agent_idle_test.mjs "$(AGENT_IDLE_ENGINE)" $(AGENT_IDLE_FLAGS)

test-agent-runtime-notice:
	@node tests/unit/agent_runtime_notice_test.mjs $(AGENT_NOTICE_RECEIPT)

test-agent-continuation: test-agent-continuation-oracle
	@node tests/integration/agent_compaction_test.mjs "$(AGENT_LAGUNA_TREE)" --family laguna --tokenizer-model "$(COMPACTION_LAGUNA_MODEL)"
	@node tests/integration/agent_compaction_test.mjs "$(QWEN35_AGENT_TREE)" --family qwen35 --tokenizer-model "$(COMPACTION_QWEN35_MODEL)"

# Explicit single-engine live invocation. No weight download or app restart;
# run each family sequentially with its own passing native build receipt.
test-agent-continuation-live: $(TEST_BUILD)/agent-build-probe test-agent-continuation-oracle
	@node tests/live/agent_continuation_live.mjs "$(CONTINUATION_BUILD_RECEIPT)" "$(CONTINUATION_FAMILY)" "$(CONTINUATION_MODEL)"

test-qwen38-agent:
	@node tests/integration/qwen38_agent_test.mjs "$(QWEN38_AGENT_TREE)" $(QWEN38_AGENT_FLAGS)

.PHONY: test-qwen35-agent
test-qwen35-agent:
	@node tests/integration/qwen35_agent_test.mjs "$(QWEN35_AGENT_TREE)" $(QWEN35_AGENT_FLAGS)

.PHONY: test-qwen-session-reset
test-qwen-session-reset:
	@node tests/integration/agent_reset_test.mjs "$(QWEN35_AGENT_TREE)" --sanitize
	@node tests/integration/agent_reset_test.mjs "$(QWEN38_AGENT_TREE)" --qwen38 --sanitize

test-qwen38-tool-oracle:
	@node tests/unit/qwen38_tool_oracle_test.mjs

# Existing native objects only; no engine mutation, build or weights download.
METAL_WORKSPACE_TREES ?= ds4 ds4-laguna-s21 ds4-qwen38 ds4-qwen35
test-metal-workspace: $(TEST_BUILD)/agent-build-probe
	@node tests/integration/metal_workspace_test.mjs $(TEST_BUILD)/agent-build-probe $(METAL_WORKSPACE_TREES)

check-fast: test-unified-patch test-agent-build

$(TEST_BUILD)/steering-transport-test: tests/integration/steering_transport_test.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN) extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/integration/steering_transport_test.c extension/remote/dstudio_remote_llm.c -o $@

test-steering: $(TEST_BUILD)/steering-transport-test
	@$(TEST_BUILD)/steering-transport-test

$(TEST_BUILD)/goal-unit: tests/unit/goal_unit.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/goal_unit.c -o $@

test-goal: $(TEST_BUILD)/goal-unit
	@$(TEST_BUILD)/goal-unit

STEERING_TREES ?= ds4 ds4-laguna-s21
STEERING_BINARIES ?= ds4/ds4-agent-jsonl ds4/ds4-cowork ds4/ds4-design ds4-laguna-s21/ds4-agent-jsonl ds4-laguna-s21/ds4-cowork
$(TEST_BUILD)/steering-patch-test: tests/integration/steering_patch_test.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/integration/steering_patch_test.c -o $@

test-steering-patch: $(TEST_BUILD)/steering-patch-test
	@$(TEST_BUILD)/steering-patch-test $(STEERING_TREES)

# Requires already built/patched runtimes; no downloads, model load or app restart.
test-steering-runtime:
	node tests/integration/runtime_steering_test.mjs $(STEERING_BINARIES)

$(TEST_BUILD)/engine_setup_unit: tests/unit/engine_setup_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/engine_setup_unit.c -o $@

.PHONY: test-engine-setup-unit
test-engine-setup-unit: $(TEST_BUILD)/engine_setup_unit $(TEST_BUILD)/qwen35_runtime_unit
	@$(TEST_BUILD)/engine_setup_unit
	@$(TEST_BUILD)/qwen35_runtime_unit
	@node tests/unit/agent_session_capability_test.mjs

$(TEST_BUILD)/qwen35_runtime_unit: tests/unit/qwen35_runtime_unit.c tests/fixtures/qwen35-runtime-probe.sh $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/qwen35_runtime_unit.c -o $@

check-fast: test-engine-setup-unit

# Release admission is read-only and checks explicit, independently prepared
# source checkouts. Ordinary app builds never fetch sources or run this gate.
.PHONY: check-engine-upstream test-engine-upstream test-engine-pins
ENGINE_UPSTREAM_FLAGS ?=
ENGINE_UPSTREAM_APP ?= ./dstudio
ENGINE_UPSTREAM_PLATFORM ?= all
check-engine-upstream:
	@node scripts/check-engine-upstream.mjs $(ENGINE_UPSTREAM_FLAGS) --application "$(ENGINE_UPSTREAM_APP)" --platform "$(ENGINE_UPSTREAM_PLATFORM)"

test-engine-upstream:
	@node tests/integration/engine_upstream_test.mjs

test-engine-pins: $(TEST_SERVER)
	@node tests/integration/engine_pins_test.mjs "$(TEST_SERVER)"

check-fast: test-engine-upstream test-engine-pins

.PHONY: test-qwen35-download
test-qwen35-download:
	@python3 tests/integration/qwen35_download_test.py

.PHONY: test-qwen27-download test-qwen27-download-host test-ui-qwen27-download test-qwen27-download-settings-live
test-qwen27-download:
	@python3 tests/integration/qwen27_download_test.py

$(TEST_BUILD)/model-download-unit: tests/unit/model_download_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/model_download_unit.c -o $@

test-qwen27-download-host: $(TEST_SERVER) $(TEST_BUILD)/model-download-unit
	@$(TEST_BUILD)/model-download-unit
	@node tests/integration/qwen27_download_host_test.mjs "$(TEST_SERVER)"

test-ui-qwen27-download: $(TEST_SERVER)
	@node tests/browser/ui_qwen27_download_playwright_test.mjs "$(TEST_SERVER)"

test-qwen27-download-settings-live: $(TEST_SERVER)
	@test -n "$(QWEN27_INSTALL_ROOT)" || { echo 'Set QWEN27_INSTALL_ROOT to an existing pinned installation with both real components'; exit 2; }
	@node tests/live/qwen27_download_settings_live_test.mjs "$(TEST_SERVER)" "$(QWEN27_INSTALL_ROOT)"

check-fast: test-qwen27-download test-qwen27-download-host

.PHONY: test-q36-install
test-q36-install:
	@python3 tests/integration/q36_install_test.py

.PHONY: test-q36-cache-usage
test-q36-cache-usage:
	@node tests/integration/q36_cache_usage_patch_test.mjs "$(Q36_SOURCE)"

check-fast: test-q36-install

.PHONY: test-qwen35-catalog
test-qwen35-catalog:
	@node tests/integration/qwen35_catalog_patch_test.mjs "$(or $(QWEN35_DIR),ds4-qwen35)"

.PHONY: test-qwen38-inspect
test-qwen38-inspect:
	@node tests/integration/qwen38_inspect_patch_test.mjs "$(or $(QWEN38_DIR),ds4-qwen38)"

# Explicit real Metal operators; optional verified projector, never LLM weights.
.PHONY: test-q36-metal-runtime
test-q36-metal-runtime:
	@node tests/integration/q36_metal_runtime_test.mjs "$(Q36_SOURCE)" $(if $(QWEN27_PROJECTOR),"$(QWEN27_PROJECTOR)") $(if $(filter 1,$(Q36_NEXT_REVIEW)),--next)

.PHONY: test-q36-attention-work
test-q36-attention-work:
	@node tests/integration/q36_attention_work_test.mjs "$(Q36_SOURCE)"

# Explicit candidate gate; does not promote the managed installer or load weights.
.PHONY: test-q36-f16-attention
test-q36-f16-attention:
	@node tests/integration/q36_f16_attention_patch_test.mjs "$(Q36_SOURCE)"
	@node tests/integration/q36_attention_work_test.mjs "$(Q36_SOURCE)" --segmented

.PHONY: test-q36-dense-quant test-q36-catalog
test-q36-dense-quant:
	@node tests/integration/q36_dense_quant_test.mjs "$(Q36_SOURCE)"

test-q36-catalog:
	@node tests/integration/q36_catalog_test.mjs "$(Q36_SOURCE)"

# Execute the native renderer against the original templates in existing GGUFs.
# Metadata only; Jinja2 is required, no inference or weight download.
.PHONY: test-q36-chat-template
test-q36-chat-template:
	@python3 tests/integration/q36_chat_template_test.py "$(Q36_SOURCE)" "$(QWEN27_MODEL)" $(if $(QWEN36_MODEL),"$(QWEN36_MODEL)")

.PHONY: test-q36-owner
test-q36-owner:
	@node tests/integration/q36_owner_test.mjs "$(Q36_SOURCE)" --server

.PHONY: test-q36-owner-live
test-q36-owner-live:
	@node tests/live/q36_owner_live_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)"

$(TEST_BUILD)/q36_host_unit: tests/unit/q36_host_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/q36_host_unit.c -o $@

$(TEST_BUILD)/q36_host_engine: tests/support/q36_host_engine.c
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $< -o $@

.PHONY: test-q36-host
test-q36-host: $(TEST_SERVER) $(TEST_BUILD)/q36_host_unit $(TEST_BUILD)/q36_host_engine
	@$(TEST_BUILD)/q36_host_unit
	@node tests/integration/q36_host_test.mjs $(TEST_SERVER) $(TEST_BUILD)/q36_host_engine

.PHONY: test-q36-agent-host
test-q36-agent-host: $(TEST_SERVER)
	@node tests/integration/q36_agent_host_test.mjs $(TEST_SERVER) "$(if $(Q36_AGENT_SOURCE),$(Q36_AGENT_SOURCE),ds4)"

.PHONY: test-q36-attachments-browser
test-q36-attachments-browser: $(TEST_SERVER)
	@node tests/integration/q36_agent_host_test.mjs $(TEST_SERVER) "$(if $(Q36_AGENT_SOURCE),$(Q36_AGENT_SOURCE),ds4)" --browser

.PHONY: test-q36-host-live
test-q36-host-live: $(TEST_SERVER)
	@node tests/live/q36_host_live_test.mjs $(TEST_SERVER) "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)"

.PHONY: test-q36-host-tools-live
test-q36-host-tools-live: $(TEST_SERVER)
	@node tests/live/q36_host_live_test.mjs $(TEST_SERVER) "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)" --tools

.PHONY: test-q36-upgrade-live
test-q36-upgrade-live: $(TEST_SERVER)
	@node tests/live/q36_upgrade_live_test.mjs $(TEST_SERVER) "$(Q36_LEGACY_SOURCE)" "$(QWEN27_MODEL)" "$(Q36_MAIN_SOURCE)"

.PHONY: test-q36-host-tools-browser-live
test-q36-host-tools-browser-live: $(TEST_SERVER)
	@node tests/live/q36_host_live_test.mjs $(TEST_SERVER) "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)" --tools --browser=webkit

# Diagnostic replay only: the pinned server records exact requests and phases.
$(TEST_BUILD)/q36-host-trace: tests/support/q36_host_trace.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $< -o $@

.PHONY: test-q36-host-tools-trace
test-q36-host-tools-trace: $(TEST_BUILD)/q36-host-trace
	@node tests/live/q36_host_live_test.mjs $(TEST_BUILD)/q36-host-trace "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)" --tools --trace-native

# Explicit diagnostic only: same native prompt/logits before and after readback
# instrumentation, eight greedy steps; never a replacement for tool acceptance.
.PHONY: test-q36-sync-profile-live
test-q36-sync-profile-live:
	@node tests/live/q36_sync_profile_live_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(Q36_NATIVE_TRACE)"

# Same actual model/host gate plus a real headless WebKit Chat workflow.
.PHONY: test-q36-host-browser-live
test-q36-host-browser-live: $(TEST_SERVER)
	@node tests/live/q36_host_live_test.mjs $(TEST_SERVER) "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)" --browser=webkit

# Explicit full-weight CPU/Metal replay, never part of the model-free gates.
.PHONY: test-q36-request-parity-live
test-q36-request-parity-live:
	@node tests/live/q36_request_parity_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)"

.PHONY: test-q36-vision-session-live
test-q36-vision-session-live:
	@node tests/live/q36_vision_session_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)"

.PHONY: test-q36-text-prepare-live
test-q36-text-prepare-live:
	@node tests/live/q36_text_prepare_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" $(if $(Q36_DIRECT_BASELINE),--direct-baseline)

.PHONY: test-q36-text-schedule-live
test-q36-text-schedule-live:
	@node tests/live/q36_text_prepare_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" --scheduled

.PHONY: test-q36-session-batch-live
test-q36-session-batch-live:
	@node tests/live/q36_session_batch_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)"

.PHONY: test-q36-recurrent-batch
test-q36-recurrent-batch:
	@node tests/integration/q36_recurrent_batch_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-text-prepare
test-q36-text-prepare:
	@node tests/integration/q36_text_prepare_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-vision-prepare
test-q36-vision-prepare:
	@node tests/integration/q36_text_prepare_test.mjs "$(Q36_SOURCE)" vision

.PHONY: test-q36-payload-prepare
test-q36-payload-prepare:
	@node tests/integration/q36_payload_prepare_test.mjs "$(Q36_SOURCE)" $(if $(Q36_DIRECT_BASELINE),--direct-baseline)

.PHONY: test-q36-payload-schedule test-q36-cache-owner
test-q36-payload-schedule:
	@node tests/integration/q36_payload_schedule_test.mjs "$(Q36_SOURCE)"

# Native ownership regression: independent decode during blocked disk I/O.
test-q36-cache-owner:
	@node tests/integration/q36_cache_owner_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-vision-answer-oracle
test-q36-vision-answer-oracle:
	@node tests/unit/q36_vision_answer_oracle_test.mjs

check-fast: test-q36-vision-answer-oracle

.PHONY: test-q36-cancel-admission
test-q36-cancel-admission:
	@node tests/integration/q36_cancel_admission_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-http-vision
test-q36-http-vision:
	@node tests/integration/q36_http_vision_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-http-control
.PHONY: test-q36-http-text-prepare
test-q36-http-text-prepare:
	@node tests/integration/q36_http_text_prepare_test.mjs "$(Q36_SOURCE)" $(if $(Q36_DIRECT_BASELINE),--direct-baseline)

.PHONY: test-q36-http-text-batched
test-q36-http-text-batched:
	@node tests/integration/q36_http_text_prepare_test.mjs "$(Q36_SOURCE)" --batched

test-q36-http-control:
	@node tests/integration/q36_http_control_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-tool-replay-identity
test-q36-tool-replay-identity:
	@node tests/integration/q36_tool_replay_identity_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-tool-map
test-q36-tool-map:
	@node tests/integration/q36_tool_map_test.mjs "$(Q36_SOURCE)" --v2

.PHONY: test-q36-tool-schema
test-q36-tool-schema:
	@node tests/integration/q36_tool_schema_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-http-vision-live
test-q36-http-vision-live:
	@node tests/live/q36_http_vision_live_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)" $(if $(filter 1,$(Q36_DISK_CACHE)),--disk-cache) $(if $(filter 1,$(Q36_NEXT_REVIEW)),--next) $(if $(Q36_NATIVE_RECEIPT),--native-receipt "$(Q36_NATIVE_RECEIPT)")

# Read-only CLI admission and deliberately invalid receipts; no inference.
.PHONY: test-q36-http-review
test-q36-http-review:
	@node tests/integration/q36_http_review_test.mjs "$(Q36_SOURCE)" "$(Q36_NATIVE_RECEIPT)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)"

.PHONY: test-q36-http-install
test-q36-http-install:
	@node tests/integration/q36_http_install_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)" "$(QWEN27_PROJECTOR)"

.PHONY: test-q36-batched-cache-live
test-q36-batched-cache-live:
	@node tests/live/q36_batched_cache_live_test.mjs "$(Q36_SOURCE)" "$(QWEN27_MODEL)"

.PHONY: test-qwen38-prepare-patch test-qwen38-prepare-live
test-qwen38-prepare-patch:
	@node tests/integration/qwen38_prepare_patch_test.mjs "$(QWEN38_AGENT_TREE)"

# Explicit real Metal run; supply existing weights and an already-built,
# patched candidate. No downloads or changes to the user's installation.
test-qwen38-prepare-live:
	@node tests/live/qwen38_prepare_test.mjs "$(QWEN38_AGENT_TREE)" "$(QWEN38_MODEL)" "$(QWEN38_PLE)" $(if $(QWEN38_WEIGHT_RECEIPTS),--weight-receipts "$(QWEN38_WEIGHT_RECEIPTS)")

check-fast: test-qwen35-download

.PHONY: test-glm53-m2max-patch
test-glm53-m2max-patch:
	@node tests/integration/glm53_m2max_patch_test.mjs

.PHONY: test-main-decode-metrics
test-main-decode-metrics:
	@node tests/unit/main_decode_metrics_test.mjs
	@node tests/unit/ds41_benchmark_test.mjs

.PHONY: test-qwen38-snapshot-patch
test-qwen38-snapshot-patch:
	@node tests/integration/qwen38_snapshot_patch_test.mjs "$(QWEN38_AGENT_TREE)"

.PHONY: test-q27-metal-delta
test-q27-metal-delta:
	@node tests/integration/q27_metal_delta_test.mjs "$(Q27_SOURCE)"

.PHONY: test-server-metrics-patch test-native-patch-roundtrip
test-server-metrics-patch:
	@node tests/integration/server_metrics_patch_test.mjs "$(or $(METRICS_MAIN_DIR),ds4)" "$(or $(LAGUNA_DIR),ds4-laguna-s21)"

test-native-patch-roundtrip:
	@node tests/integration/native_patch_roundtrip_test.mjs "$(or $(NATIVE_PATCH_DIR),ds4)"

.PHONY: test-search-evidence
test-search-evidence:
	@node tests/unit/search_evidence_test.mjs
	@node tests/unit/research_evidence_windows_test.mjs
	@node tests/unit/research_budget_test.mjs
	@node tests/unit/research_answer_selection_test.mjs
	@node tests/unit/research_answer_review_test.mjs
	@node tests/unit/research_reply_delivery_test.mjs
	@node tests/unit/research_http_cancel_test.mjs
	@node tests/unit/search_quality_grader_test.mjs

.PHONY: test-search-publication test-remote-agent-workspace
test-search-publication:
	@node tests/unit/search_publication_test.mjs
	@node tests/unit/research_pipeline_publication_test.mjs
	@python3 tests/unit/search_chart_test.py
	@python3 tests/unit/research_pipeline_chart_test.py
	@python3 tests/unit/research_answer_review_chart_test.py

.PHONY: test-product-comparison-publication
test-product-comparison-publication:
	@node tests/unit/product_design_grader_test.mjs
	@node tests/browser/product_radio_layout_test.mjs
	@node tests/browser/product_design_regenerated_test.mjs
	@node tests/unit/product_artifact_server_test.mjs
	@node tests/unit/product_publication_test.mjs
	@python3 tests/unit/product_chart_test.py

test-remote-agent-workspace: $(TEST_SERVER)
	@$(TEST_SERVER) --build-jsonl $(DS4_DIR)
	@node tests/integration/remote_agent_workspace_test.mjs $(DS4_DIR)/ds4-agent-jsonl

$(TEST_BUILD)/web_visual_patch_unit: tests/unit/web_visual_patch_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/web_visual_patch_unit.c -o $@

.PHONY: test-web-visual-unit test-web-visual-browser
test-web-visual-unit: $(TEST_BUILD)/web_visual_patch_unit
	@$(TEST_BUILD)/web_visual_patch_unit

# Real isolated Chrome + compiled browser helper; does not load weights.
test-web-visual-browser: $(TEST_BUILD)/web_visual_patch_unit
	@node tests/integration/web_visual_browser_test.mjs $(TEST_BUILD)/web_visual_patch_unit

check-fast: test-search-evidence
check-fast: test-web-visual-unit

check-fast: test-main-decode-metrics

check-fast: test-glm53-m2max-patch

.PHONY: test-agent-pld test-pld test-pld-build
test-pld: test-agent-pld test-pld-build
test-pld-build: $(TEST_SERVER)
	@node tests/integration/server_pld_build_test.mjs $(TEST_SERVER)
	@node tests/unit/pld_benchmark_test.mjs

.PHONY: test-pld-real
test-pld-real:
	RUN_HEAVY=1 node extension/prompt-lookup/bench/run-real.mjs
test-agent-pld:
	@mkdir -p $(TEST_BUILD)
	$(CC) -std=c11 -O1 -g -Wall -Wextra -Werror -pthread -Itests/fixtures/pld tests/unit/agent_pld_test.c -o $(TEST_BUILD)/agent_pld_test
	@$(TEST_BUILD)/agent_pld_test

check-fast: test-pld

$(TEST_TASK_GRAPH): tests/unit/task_graph_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/task_graph_unit.c -o $@

test-task-graph-unit: $(TEST_TASK_GRAPH)
	@$(TEST_TASK_GRAPH)

test-task-graph-http: $(TEST_SERVER)
	@bash tests/integration/task_graph_http_test.sh $(TEST_SERVER)

test-task-graph-bench-validate:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Task Graph benchmark validation requires node" && exit 1)
	@node extension/task-graph/bench/validate.mjs

test-task-graph-real: $(TEST_SERVER)
	@RUN_HEAVY=1 node extension/task-graph/bench/run-heavy.mjs $(TEST_SERVER)

test-task-graph-reliability-real: $(TEST_SERVER) $(TEST_TASK_GRAPH)
	@RUN_HEAVY=1 node extension/task-graph/bench/run-reliability.mjs $(TEST_SERVER)

test-task-graph-cli-competitors-real: $(TEST_SERVER)
	@command -v pi >/dev/null 2>&1 || (echo "pi missing: install @earendil-works/pi-coding-agent" && exit 1)
	@command -v opencode >/dev/null 2>&1 || (echo "opencode missing" && exit 1)
	@RUN_HEAVY=1 node extension/task-graph/bench/run-cli-competitors.mjs $(TEST_SERVER)

$(TEST_REMOTE_UTF8): tests/unit/remote_utf8_unit.c extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h extension/remote/dstudio_wire_string.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/unit/remote_utf8_unit.c extension/remote/dstudio_remote_llm.c -o $@

test-remote-utf8: $(TEST_REMOTE_UTF8)
	@$(TEST_REMOTE_UTF8)

.PHONY: test-model-rpc-stream test-model-rpc-interrupt test-model-rpc-lifecycle
$(TEST_BUILD)/model-rpc-stream-probe: tests/support/model_rpc_stream_probe.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN) extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/support/model_rpc_stream_probe.c extension/remote/dstudio_remote_llm.c -o $@

test-model-rpc-stream: $(TEST_BUILD)/model-rpc-stream-probe
	@node tests/integration/model_rpc_stream_test.mjs $(TEST_BUILD)/model-rpc-stream-probe
	@node tests/integration/model_rpc_stream_test.mjs $(TEST_BUILD)/model-rpc-stream-probe --owner-relay
	@node tests/integration/model_rpc_stream_test.mjs $(TEST_BUILD)/model-rpc-stream-probe --owner-relay --https

$(TEST_BUILD)/model-rpc-interrupt-test: tests/integration/model_rpc_interrupt_test.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN) extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/integration/model_rpc_interrupt_test.c extension/remote/dstudio_remote_llm.c -o $@

test-model-rpc-interrupt: $(TEST_BUILD)/model-rpc-interrupt-test
	@$(TEST_BUILD)/model-rpc-interrupt-test

$(TEST_BUILD)/model-rpc-lifecycle-test: tests/integration/model_rpc_lifecycle_test.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $< -o $@

test-model-rpc-lifecycle: $(TEST_BUILD)/model-rpc-lifecycle-test
	@node tests/integration/model_rpc_lifecycle_test.mjs $(TEST_BUILD)/model-rpc-lifecycle-test

check-fast: test-model-rpc-stream test-model-rpc-interrupt test-model-rpc-lifecycle

.PHONY: test-model-rpc-input
$(TEST_BUILD)/model-rpc-input-test: tests/integration/model_rpc_input_test.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN) extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $< extension/remote/dstudio_remote_llm.c -o $@

test-model-rpc-input: $(TEST_BUILD)/model-rpc-input-test
	@node tests/integration/model_rpc_input_test.mjs $(TEST_BUILD)/model-rpc-input-test

check-fast: test-model-rpc-input

$(TEST_COWORK_BRIDGE): tests/integration/ds4_cowork_bridge_test.c extension/cowork/ds4_cowork.c extension/cowork/ds4_cowork.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) -Iextension/cowork tests/integration/ds4_cowork_bridge_test.c extension/cowork/ds4_cowork.c -o $@

test-cowork-unit: $(TEST_COWORK_BRIDGE)
	@command -v python3 >/dev/null 2>&1 || (echo "python3 missing: Cowork Office runtime requires Python 3" && exit 1)
	@python3 -m unittest -v tests/unit/ds4_cowork_office_test.py
	@python3 -m unittest -v tests/unit/document_table_test.py
	@node tests/unit/cowork_spreadsheet_oracle_test.mjs
	@$(TEST_COWORK_BRIDGE) "$$(pwd)/extension/cowork/office_tool.py"

test-cowork-browser:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Cowork browser test requires node" && exit 1)
	@node tests/browser/document_table_ui_test.mjs

test-cowork-http: $(TEST_SERVER)
	@bash tests/integration/ds4_cowork_http_test.sh $(TEST_SERVER)

test-cowork: test-cowork-unit test-cowork-browser test-cowork-http

test-cowork-bench-validate:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Cowork benchmark validation requires node" && exit 1)
	@node extension/cowork/bench/validate.mjs

test-design-build-freshness: $(TEST_BUILD)/agent-build-probe
	@node tests/integration/design_build_test.mjs $(TEST_BUILD)/agent-build-probe

.PHONY: test-design-archive-build test-design-tool-recovery test-design-comparison-report
test-design-comparison-report:
	node tests/unit/design_comparison_report_test.mjs

test-design-archive-build: $(TEST_SERVER)
	@DSTUDIO_BUILD_HOST="$(abspath $(TEST_SERVER))" bash tests/integration/design_archive_build_test.sh

test-design-tool-recovery: test-design-self
	@node tests/integration/design_tool_recovery_test.mjs

test-design-self: test-design-build-freshness $(TEST_SERVER)
	@DSTUDIO_BUILD_HOST="$(abspath $(TEST_SERVER))" extension/design/build-design.sh build
	@./ds4/ds4-design --self-test

test-design-controls:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design control probe requires node" && exit 1)
	@node tests/unit/design_control_probe_test.mjs

.PHONY: test-design-originals
test-design-originals: $(TEST_SERVER)
	@node tests/browser/design_originals_test.mjs $(TEST_SERVER)

.PHONY: test-design-project-cases test-design-project-auditor test-design-generation-process test-design-project-resources
test-design-project-cases:
	@node tests/unit/design_project_cases_test.mjs
	@node tests/integration/design_project_audit_admission_test.mjs

test-design-runtime: test-design-project-cases

test-design-project-auditor:
	@node tests/browser/design_project_audit_test.mjs

test-design-runtime: test-design-project-auditor

test-design-project-resources:
	@node tests/browser/design_project_resource_test.mjs

test-design-runtime: test-design-project-resources

test-design-generation-process:
	@node tests/integration/design_generation_process_test.mjs

test-design-runtime: test-design-generation-process

.PHONY: test-q36-agent-tty
Q36_AGENT_TTY_FLAGS ?=
test-q36-agent-tty:
	@Q36_SOURCE="$(Q36_SOURCE)" python3 tests/integration/q36_agent_tty_test.py $(Q36_AGENT_TTY_FLAGS)

.PHONY: test-q36-search-extract
test-q36-search-extract:
	@node tests/browser/q36_search_extract_test.mjs "$(Q36_SOURCE)"

.PHONY: test-q36-metal-diagnostics
test-q36-metal-diagnostics:
	@node tests/integration/q36_metal_diagnostics_test.mjs "$(Q36_SOURCE)"

test-design-disclosure:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Lumen disclosure contract test requires node" && exit 1)
	@node tests/unit/lumen_disclosure_contract_test.mjs

test-design-interrupt: test-design-self
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design interrupt test requires node" && exit 1)
	@node tests/integration/design_interrupt_test.mjs
	@node tests/integration/design_chrome_termination_test.mjs
	@node tests/integration/design_image_interrupt_test.mjs
	@node tests/integration/design_video_interrupt_test.mjs

test-design-resume:
	@node tests/unit/design_resume_checkpoint_test.mjs

test-design-runtime: test-design-self test-design-tool-recovery test-design-comparison-report test-design-originals test-design-controls test-design-disclosure test-design-interrupt test-design-resume
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design runtime test requires node" && exit 1)

test-design-bench-validate:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design benchmark validation requires node" && exit 1)
	@node extension/design/bench/validate.mjs

test-design-release:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design release gate requires node" && exit 1)
	@node tests/unit/design_pages_release_gate_test.mjs

test-image-pipeline:
	@python3 tests/integration/image_pipeline_interrupt_test.py
	@python3 tests/integration/image_presets_pipeline_test.py

.PHONY: test-image-preset-publication
test-image-preset-publication:
	@python3 tests/unit/image_preset_publication_test.py

test-image-runtime:
	@if [ -x "$(HOME)/.dstudio/ideogram4/venv/bin/python" ] && \
	    [ -f "$(HOME)/.dstudio/hunyuan-image/models/HunyuanImage-3-Instruct-NF4-v2/config.json" ]; then \
	  "$(HOME)/.dstudio/ideogram4/venv/bin/python" tests/integration/image_runtime_behavior_test.py && \
	  "$(HOME)/.dstudio/hunyuan-image/venv/bin/python" tests/integration/hunyuan_patch_reproducibility_test.py; \
	else \
	  echo "local Ideogram/Hunyuan runtimes missing: image runtime tests NOT RUN"; exit 1; \
	fi

test-ideogram-vae-mps:
	@if [ -x "$(HOME)/.dstudio/ideogram4/venv/bin/python" ]; then \
	  "$(HOME)/.dstudio/ideogram4/venv/bin/python" tests/live/ideogram_vae_mps_probe.py; \
	else \
	  echo "local Ideogram runtime missing: cannot run the real MPS VAE probe"; exit 1; \
	fi

test-hunyuan-sdpa-mps:
	@if [ -x "$(HOME)/.dstudio/hunyuan-image/venv/bin/python" ]; then \
	  "$(HOME)/.dstudio/hunyuan-image/venv/bin/python" tests/live/hunyuan_sdpa_mps_probe.py; \
	else \
	  echo "local Hunyuan runtime missing: cannot run the real MPS SDPA probe"; exit 1; \
	fi

.PHONY: test-chat-lifecycle test-follow-scroll test-ui-qwen-learn test-qwen27-model-ui
test-qwen27-model-ui:
	@node tests/unit/qwen27_model_test.mjs

.PHONY: test-ds41-model-ui
test-ds41-model-ui:
	@node tests/unit/ds41_model_test.mjs

test-chat-lifecycle:
	@node tests/unit/chat_model_readiness_test.mjs
	@node tests/unit/chat_request_binding_test.mjs
	@node tests/unit/chat_checkout_readiness_test.mjs

test-follow-scroll:
	@node tests/unit/follow_scroll_test.mjs

test-frontend-unit: test-chat-lifecycle test-follow-scroll test-ds41-model-ui
	@node tests/unit/frontend_behavior_test.mjs

# Production Learn/Tutor browser interactions; engine responses are simulated.
# Repeat with DSTUDIO_TEST_BROWSER=webkit for the macOS webview engine family.
test-ui-qwen-learn:
	@DSTUDIO_TEST_MODEL=qwen38 DSTUDIO_TEST_STALE_CHECKOUT=1 node tests/browser/ui_roadmap_playwright_test.mjs
	@DSTUDIO_TEST_MODEL=qwen35 DSTUDIO_TEST_STALE_CHECKOUT=1 node tests/browser/ui_roadmap_playwright_test.mjs
	@DSTUDIO_TEST_MODEL=qwen27 DSTUDIO_TEST_STALE_CHECKOUT=1 node tests/browser/ui_roadmap_playwright_test.mjs

# Explicit live gates. Setup really downloads/builds in a new empty directory;
# inference really loads installed weights, one model at a time.
.PHONY: test-setup-live test-inference-live test-engine-acceptance test-qwen-chat-live benchmark-qwen-decode
test-setup-live: $(TEST_SERVER)
	@node tests/live/engine_acceptance.mjs --setup

.PHONY: test-first-launch-e2e
test-first-launch-e2e: app
	@node tests/live/first_launch_e2e.mjs

test-inference-live: $(TEST_SERVER)
	@node tests/live/engine_acceptance.mjs --infer --engines "$(or $(ENGINES),main,laguna)"

test-engine-acceptance: $(TEST_SERVER)
	@node tests/live/engine_acceptance.mjs --setup --infer --engines "$(or $(ENGINES),main,laguna,qwen,qwen35)"

test-qwen-chat-live: $(TEST_SERVER)
	@node tests/live/engine_acceptance.mjs --infer --engines qwen --via-app

benchmark-qwen-decode:
	@node tests/live/qwen_decode_benchmark.mjs

# Explicit Metal regression: existing vision encoder only, no LLM/server launch.
VISION_DS4_DIR ?= ds4
.PHONY: test-vision-streaming-live
test-vision-streaming-live:
	@node tests/live/vision_stream_mapping_test.mjs "$(VISION_DS4_DIR)" $(if $(VISION_ENCODER),"$(VISION_ENCODER)")

# Explicit, sequential real-GPU regression; one transformer layer, not full LLM.
SSD_TEST_DS4_DIR ?= ds4
.PHONY: test-ssd-prefill-batch-live
test-ssd-prefill-batch-live:
	@node tests/live/ssd_prefill_batch_test.mjs "$(SSD_TEST_DS4_DIR)"

# Real PDF extraction/rendering and browser checks; no model or embeddings.
.PHONY: test-pdf-evidence
test-pdf-evidence: $(TEST_SERVER)
	@node tests/integration/pdf_evidence_test.mjs $(TEST_SERVER)

.PHONY: test-pdf-complete
test-pdf-complete: $(TEST_SERVER)
	@node tests/integration/pdf_complete_read_test.mjs $(TEST_SERVER)

test-ui-browser:
	@if command -v node >/dev/null 2>&1; then node tests/browser/ui_model_picker_playwright_test.mjs && node tests/browser/ui_loading_playwright_test.mjs && node tests/browser/ui_agent_design_playwright_test.mjs && node tests/browser/ui_gear_popover_test.mjs && node tests/browser/ui_think_max_context_test.mjs && node tests/browser/ui_attachment_preview_playwright_test.mjs && node tests/browser/ui_roadmap_playwright_test.mjs && node tests/browser/ui_settings_redesign_playwright_test.mjs && node tests/browser/ui_video_generation_playwright_test.mjs; else echo "node missing: NOT RUN UI browser tests"; exit 1; fi

test-ui-live-vision:
	@if command -v node >/dev/null 2>&1; then node tests/live/ui_live_vision_playwright_test.mjs; else echo "node missing: NOT RUN live Vision UI test"; exit 1; fi

test-ui-plan:
	@if command -v node >/dev/null 2>&1; then node tests/browser/ui_plan_mode_playwright_test.mjs && node tests/browser/ui_plan_mode_matrix_test.mjs; else echo "node missing: NOT RUN Plan mode UI tests"; exit 1; fi

test-ui-gsa:
	@if command -v node >/dev/null 2>&1; then node tests/browser/ui_gsa_playwright_test.mjs; else echo "node missing: NOT RUN GSA UI tests"; exit 1; fi

test-ui-rsa:
	@if command -v node >/dev/null 2>&1; then node tests/browser/ui_rsa_playwright_test.mjs; else echo "node missing: NOT RUN RSA UI tests"; exit 1; fi

test-rsa-collectors:
	@if command -v node >/dev/null 2>&1; then node tests/integration/rsa_collectors_matrix_test.mjs; else echo "node missing: NOT RUN RSA collector tests"; exit 1; fi

test-table-ascii:
	@if command -v python3 >/dev/null 2>&1; then python3 tests/unit/table_ascii_art_test.py; else echo "python3 missing: NOT RUN table ASCII tests"; exit 1; fi

test-markdown-math:
	@if command -v node >/dev/null 2>&1; then node tests/unit/markdown_math_test.mjs; else echo "node missing: NOT RUN Markdown math tests"; exit 1; fi

test-video-checkout:
	@if command -v python3 >/dev/null 2>&1; then python3 tests/integration/h3_checkout_test.py; else echo "python3 missing: NOT RUN H3 checkout regression test"; exit 1; fi

.PHONY: test-video-checkout test-video-open-weight
test-video-open-weight: test-video-checkout
	@tests/live/h3_sdpa_query_chunk_equivalence_test.sh

test-http-lan: $(TEST_SERVER)
	@tests/integration/http_lan_test.sh $(TEST_SERVER)

test-gsa-bench-validate:
	@if command -v node >/dev/null 2>&1; then node extension/gsa/bench/validate.mjs; else echo "node missing: NOT RUN GSA benchmark validation"; exit 1; fi

check-fast: $(BIN) test-task-graph-unit test-task-graph-http test-task-graph-bench-validate test-lan-unit test-remote-utf8 test-cowork test-cowork-bench-validate test-design-runtime test-design-bench-validate test-design-release test-image-pipeline test-frontend-unit test-ui-browser test-ui-plan test-ui-gsa test-ui-rsa test-rsa-collectors test-table-ascii test-markdown-math test-video-checkout test-http-lan test-gsa-bench-validate

test-real-search-research: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Search/DeepResearch tests require node" && exit 1)
	@node tests/live/real_search_research_test.mjs $(TEST_SERVER)

test-real-roadmap-quality: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Roadmap quality tests require node" && exit 1)
	@node tests/live/real_roadmap_quality_test.mjs $(TEST_SERVER)

test-real-cowork: $(TEST_SERVER) test-cowork-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Cowork quality tests require node" && exit 1)
	@DSTUDIO_COWORK_PROFILE=standard node tests/live/real_cowork_quality_test.mjs $(TEST_SERVER)

test-real-cowork-long: $(TEST_SERVER) test-cowork-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: long Cowork quality tests require node" && exit 1)
	@DSTUDIO_COWORK_PROFILE=long node tests/live/real_cowork_quality_test.mjs $(TEST_SERVER)

test-real-design: $(TEST_SERVER) test-design-runtime test-design-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Design quality tests require node" && exit 1)
	@DSTUDIO_DESIGN_PROFILE=standard node tests/live/real_design_quality_test.mjs $(TEST_SERVER)

test-real-design-long: $(TEST_SERVER) test-design-runtime test-design-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: long Design quality tests require node" && exit 1)
	@DSTUDIO_DESIGN_PROFILE=long node tests/live/real_design_quality_test.mjs $(TEST_SERVER)

test-real-ascii-diagrams: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real ASCII diagram tests require node" && exit 1)
	@node tests/live/real_ascii_diagram_test.mjs $(TEST_SERVER)

test-real-math-explanations: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real math explanation tests require node" && exit 1)
	@node tests/live/real_math_explanation_stress_test.mjs $(TEST_SERVER)

test-real-pdf-rag: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real PDF RAG tests require node" && exit 1)
	@node tests/live/real_pdf_rag_test.mjs $(TEST_SERVER)

test-real-remote: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real remote tests require node" && exit 1)
	@node tests/live/real_remote_test.mjs $(TEST_SERVER)

check-real: $(TEST_SERVER) test-real-ascii-diagrams test-real-search-research test-real-remote

check: check-fast check-real

windows:
	pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1

clean:
	rm -f $(BIN) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN) $(LOGO_HDR) $(ICNS) $(DESKTOP) build/dstudio.o build/app.o
	rm -rf $(TEST_BUILD)
	@rm -rf ds4.iconset .icontmp.icns .icontmp.rsrc

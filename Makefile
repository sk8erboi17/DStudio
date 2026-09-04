# DStudio — native desktop app for ds4 (server + agent + design).
#
#   make            macOS: builds DStudio.app (double-click, no Terminal)
#                   Linux: builds ./dstudio (the same app, WebKitGTK window)
#   make run        compiles and starts (opens the window on the interface)
#   make check      full verification: fast tests + real model/web E2E tests
#   make check-fast sanity: page/text/unit/UI/LAN tests without starting the model
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
SUBSRC   := $(wildcard src/dstudio_*.c)
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
ICNS     := ds4.icns
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

.PHONY: all run check check-fast check-real test-task-graph-unit test-task-graph-http test-task-graph-bench-validate test-task-graph-real test-lan-unit test-remote-utf8 test-cowork test-cowork-unit test-cowork-contract test-cowork-http test-cowork-bench-validate test-design-build-freshness test-design-self test-design-controls test-design-disclosure test-design-interrupt test-design-resume test-design-native-vision test-design-bench-validate test-design-release test-image-pipeline test-image-inference test-ideogram-vae-mps test-hunyuan-sdpa-mps test-ui-contract test-ui-browser test-ui-live-vision test-ui-plan test-ui-gsa test-ui-rsa test-rsa-collectors test-table-ascii test-markdown-math test-video-open-weight test-http-lan test-gsa-bench-validate test-real-cowork test-real-cowork-long test-real-design test-real-design-long test-real-ascii-diagrams test-real-math-explanations test-real-pdf-rag test-real-search-research test-real-roadmap-quality test-real-remote test-macos-bundle dist-macos clean app windows install-desktop uninstall-desktop

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
	@cp -R extension/design extension/cowork extension/remote extension/craft extension/search extension/task-graph $(APP_SUPPORT)/extension/
	@mkdir -p $(APP_SUPPORT)/extension/gsa
	@cp -R extension/gsa/templates $(APP_SUPPORT)/extension/gsa/
	@cp extension/gsa/tools/catalog.json extension/gsa/tools/README.md $(APP_SUPPORT)/extension/gsa/tools/
	@cp -R patch scripts third_party $(APP_SUPPORT)/
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
	@rm -rf ds4.iconset && mkdir -p ds4.iconset
	@for s in 16 32 128 256 512; do \
	  sips -z $$s $$s $(LOGO) --out ds4.iconset/icon_$${s}x$${s}.png >/dev/null 2>&1; \
	  d=$$((s*2)); sips -z $$d $$d $(LOGO) --out ds4.iconset/icon_$${s}x$${s}@2x.png >/dev/null 2>&1; \
	done
	@iconutil -c icns ds4.iconset -o $(ICNS) && rm -rf ds4.iconset
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
dstudio.o: $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	$(CC) $(CFLAGS) -DDS4_WITH_WEBVIEW -c $(SRC) -o dstudio.o

# Entry point + native webview window. On Linux $(APP_DEPS) pulls in logo_data.h.
app.o: $(APP) $(APP_DEPS)
	$(APPCXX) $(APP_CXXFLAGS) -c $(APP) -o app.o

$(BIN): dstudio.o app.o $(BIN_DEPS)
	$(APPCXX) dstudio.o app.o $(APP_LDFLAGS) -o $@
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

# Lightweight check without dependencies: the page must stay text (not binary)
# and, if node is present, the pure modules (sse/holdback/markdown) must pass the tests.
$(TEST_UNIT): tests/lan_unit.c $(SRC) $(SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/lan_unit.c -o $@

$(TEST_SERVER): $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $(SRC) -o $@

test-lan-unit: $(TEST_UNIT)
	@$(TEST_UNIT)

$(TEST_TASK_GRAPH): tests/task_graph_unit.c $(SRC) $(SUBSRC) $(EXT_SUBSRC) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/task_graph_unit.c -o $@

test-task-graph-unit: $(TEST_TASK_GRAPH)
	@$(TEST_TASK_GRAPH)

test-task-graph-http: $(TEST_SERVER)
	@bash tests/task_graph_http_test.sh $(TEST_SERVER)

test-task-graph-bench-validate:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Task Graph benchmark validation requires node" && exit 1)
	@node extension/task-graph/bench/validate.mjs

test-task-graph-real: $(TEST_SERVER)
	@RUN_HEAVY=1 node extension/task-graph/bench/run-heavy.mjs $(TEST_SERVER)

$(TEST_REMOTE_UTF8): tests/remote_utf8_unit.c extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/remote_utf8_unit.c extension/remote/dstudio_remote_llm.c -o $@

test-remote-utf8: $(TEST_REMOTE_UTF8)
	@$(TEST_REMOTE_UTF8)

$(TEST_COWORK_BRIDGE): tests/ds4_cowork_bridge_test.c extension/cowork/ds4_cowork.c extension/cowork/ds4_cowork.h
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) -Iextension/cowork tests/ds4_cowork_bridge_test.c extension/cowork/ds4_cowork.c -o $@

test-cowork-unit: $(TEST_COWORK_BRIDGE)
	@command -v python3 >/dev/null 2>&1 || (echo "python3 missing: Cowork Office runtime requires Python 3" && exit 1)
	@python3 -m unittest -v tests/ds4_cowork_office_test.py
	@$(TEST_COWORK_BRIDGE) "$$(pwd)/extension/cowork/office_tool.py"

test-cowork-contract:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Cowork contract test requires node" && exit 1)
	@node tests/ds4_cowork_contract_test.mjs

test-cowork-http: $(TEST_SERVER)
	@bash tests/ds4_cowork_http_test.sh $(TEST_SERVER)

test-cowork: test-cowork-unit test-cowork-contract test-cowork-http

test-cowork-bench-validate:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Cowork benchmark validation requires node" && exit 1)
	@node extension/cowork/bench/validate.mjs

test-design-build-freshness:
	@bash tests/design_build_freshness_test.sh

test-design-self: test-design-build-freshness
	@extension/design/build-design.sh build
	@./ds4/ds4-design --self-test

test-design-controls:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design control probe requires node" && exit 1)
	@node tests/design_control_probe_test.mjs

test-design-disclosure:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Lumen disclosure contract test requires node" && exit 1)
	@node tests/lumen_disclosure_contract_test.mjs

test-design-interrupt: test-design-self
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design interrupt test requires node" && exit 1)
	@node tests/design_interrupt_test.mjs
	@node tests/design_chrome_termination_test.mjs
	@node tests/design_image_interrupt_test.mjs
	@node tests/design_video_interrupt_test.mjs

test-design-resume:
	@node tests/design_resume_checkpoint_test.mjs

test-design-native-vision: test-design-self test-design-controls test-design-disclosure test-design-interrupt test-design-resume
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design native-vision contract test requires node" && exit 1)
	@node tests/ds4_design_native_vision_test.mjs

test-design-bench-validate:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design benchmark validation requires node" && exit 1)
	@node extension/design/bench/validate.mjs

test-design-release:
	@command -v node >/dev/null 2>&1 || (echo "node missing: Design release gate requires node" && exit 1)
	@node tests/design_release_native_contract_test.mjs
	@node tests/design_pages_release_gate_test.mjs

test-image-pipeline:
	@python3 tests/image_pipeline_interrupt_test.py

test-image-inference:
	@if [ -x "$(HOME)/.dstudio/ideogram4/venv/bin/python" ] && \
	    [ -f "$(HOME)/.dstudio/hunyuan-image/models/HunyuanImage-3-Instruct-NF4-v2/config.json" ]; then \
	  "$(HOME)/.dstudio/ideogram4/venv/bin/python" tests/image_inference_conformance_test.py && \
	  "$(HOME)/.dstudio/hunyuan-image/venv/bin/python" tests/hunyuan_native_source_conformance_test.py; \
	else \
	  echo "local Ideogram/Hunyuan runtimes missing: skipping image inference conformance"; \
	fi

test-ideogram-vae-mps:
	@if [ -x "$(HOME)/.dstudio/ideogram4/venv/bin/python" ]; then \
	  "$(HOME)/.dstudio/ideogram4/venv/bin/python" tests/ideogram_vae_mps_probe.py; \
	else \
	  echo "local Ideogram runtime missing: cannot run the real MPS VAE probe"; exit 1; \
	fi

test-hunyuan-sdpa-mps:
	@if [ -x "$(HOME)/.dstudio/hunyuan-image/venv/bin/python" ]; then \
	  "$(HOME)/.dstudio/hunyuan-image/venv/bin/python" tests/hunyuan_sdpa_mps_probe.py; \
	else \
	  echo "local Hunyuan runtime missing: cannot run the real MPS SDPA probe"; exit 1; \
	fi

test-ui-contract:
	@if command -v node >/dev/null 2>&1; then node tests/ui_contract_test.mjs; else echo "node missing: skipping UI contract tests"; fi

test-ui-browser:
	@if command -v node >/dev/null 2>&1; then node tests/ui_loading_playwright_test.mjs && node tests/ui_agent_design_playwright_test.mjs && node tests/ui_gear_popover_test.mjs && node tests/ui_think_max_context_test.mjs && node tests/ui_attachment_preview_playwright_test.mjs && node tests/ui_roadmap_playwright_test.mjs && node tests/ui_settings_redesign_playwright_test.mjs && node tests/ui_video_generation_playwright_test.mjs; else echo "node missing: skipping UI browser tests"; fi

test-ui-live-vision:
	@if command -v node >/dev/null 2>&1; then node tests/ui_live_vision_playwright_test.mjs; else echo "node missing: skipping live Vision UI test"; fi

test-ui-plan:
	@if command -v node >/dev/null 2>&1; then node tests/ui_plan_mode_playwright_test.mjs && node tests/ui_plan_mode_matrix_test.mjs; else echo "node missing: skipping Plan mode UI tests"; fi

test-ui-gsa:
	@if command -v node >/dev/null 2>&1; then node tests/ui_gsa_playwright_test.mjs; else echo "node missing: skipping GSA UI tests"; fi

test-ui-rsa:
	@if command -v node >/dev/null 2>&1; then node tests/ui_rsa_playwright_test.mjs; else echo "node missing: skipping RSA UI tests"; fi

test-rsa-collectors:
	@if command -v node >/dev/null 2>&1; then node tests/rsa_collectors_matrix_test.mjs; else echo "node missing: skipping RSA collector tests"; fi

test-table-ascii:
	@if command -v python3 >/dev/null 2>&1; then python3 tests/table_ascii_art_test.py; else echo "python3 missing: skipping table ASCII tests"; fi

test-markdown-math:
	@if command -v node >/dev/null 2>&1; then node tests/markdown_math_test.mjs; else echo "node missing: skipping Markdown math tests"; fi

test-video-open-weight:
	@if command -v node >/dev/null 2>&1; then node tests/video_open_weight_contract_test.mjs; else echo "node missing: skipping open-weight video contract test"; fi
	@if command -v python3 >/dev/null 2>&1; then python3 tests/h3_checkout_test.py; else echo "python3 missing: skipping H3 checkout regression test"; fi
	@tests/h3_sdpa_query_chunk_equivalence_test.sh

test-http-lan: $(TEST_SERVER)
	@tests/http_lan_test.sh $(TEST_SERVER)

test-gsa-bench-validate:
	@if command -v node >/dev/null 2>&1; then node extension/gsa/bench/validate.mjs; else echo "node missing: skipping GSA benchmark validation"; fi

check-fast: $(BIN) test-task-graph-unit test-task-graph-http test-task-graph-bench-validate test-lan-unit test-remote-utf8 test-cowork test-cowork-bench-validate test-design-native-vision test-design-bench-validate test-design-release test-image-pipeline test-image-inference test-ui-contract test-ui-browser test-ui-plan test-ui-gsa test-ui-rsa test-rsa-collectors test-table-ascii test-markdown-math test-video-open-weight test-http-lan test-gsa-bench-validate
	@file $(PAGE) | grep -q text && echo "$(PAGE): text OK" || (echo "$(PAGE) is not text!" && exit 1)
	@file $(LOADING) | grep -q text && echo "$(LOADING): text OK" || (echo "$(LOADING) is not text!" && exit 1)
	@command -v node >/dev/null 2>&1 && { \
	  awk '/<script type="module">/{f=1;next} /<\/script>/{f=0} f' $(PAGE) > /tmp/ds4ui-js.mjs; \
	  node --check /tmp/ds4ui-js.mjs && echo "JS: syntax OK"; \
	  awk '/<script>/{f=1;next} /<\/script>/{f=0} f' $(LOADING) > /tmp/ds4loading-js.js; \
	  node --check /tmp/ds4loading-js.js && echo "Loading JS: syntax OK"; \
	} || echo "node missing: skipping the JS check"

test-real-search-research: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Search/DeepResearch tests require node" && exit 1)
	@node tests/real_search_research_test.mjs $(TEST_SERVER)

test-real-roadmap-quality: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Roadmap quality tests require node" && exit 1)
	@node tests/real_roadmap_quality_test.mjs $(TEST_SERVER)

test-real-cowork: $(TEST_SERVER) test-cowork-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Cowork quality tests require node" && exit 1)
	@DSTUDIO_COWORK_PROFILE=standard node tests/real_cowork_quality_test.mjs $(TEST_SERVER)

test-real-cowork-long: $(TEST_SERVER) test-cowork-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: long Cowork quality tests require node" && exit 1)
	@DSTUDIO_COWORK_PROFILE=long node tests/real_cowork_quality_test.mjs $(TEST_SERVER)

test-real-design: $(TEST_SERVER) test-design-native-vision test-design-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: real Design quality tests require node" && exit 1)
	@DSTUDIO_DESIGN_PROFILE=standard node tests/real_design_quality_test.mjs $(TEST_SERVER)

test-real-design-long: $(TEST_SERVER) test-design-native-vision test-design-bench-validate
	@command -v node >/dev/null 2>&1 || (echo "node missing: long Design quality tests require node" && exit 1)
	@DSTUDIO_DESIGN_PROFILE=long node tests/real_design_quality_test.mjs $(TEST_SERVER)

test-real-ascii-diagrams: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real ASCII diagram tests require node" && exit 1)
	@node tests/real_ascii_diagram_test.mjs $(TEST_SERVER)

test-real-math-explanations: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real math explanation tests require node" && exit 1)
	@node tests/real_math_explanation_stress_test.mjs $(TEST_SERVER)

test-real-pdf-rag: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real PDF RAG tests require node" && exit 1)
	@node tests/real_pdf_rag_test.mjs $(TEST_SERVER)

test-real-remote: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real remote tests require node" && exit 1)
	@node tests/real_remote_test.mjs $(TEST_SERVER)

check-real: $(TEST_SERVER) test-real-ascii-diagrams test-real-search-research test-real-remote

check: check-fast check-real

windows:
	pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1

clean:
	rm -f $(BIN) $(GEN) $(LOADING_GEN) $(ANNOTATOR_GEN) $(LOGO_HDR) $(ICNS) $(DESKTOP) dstudio.o app.o
	rm -rf $(TEST_BUILD)
	@rm -rf ds4.iconset .icontmp.icns .icontmp.rsrc

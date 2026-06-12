# DStudio — native desktop app for ds4 (server + agent + design).
#
#   make            macOS: builds DStudio.app (double-click, no Terminal)
#                   Linux: builds ./dstudio (the same app, WebKitGTK window)
#   make run        compiles and starts (opens the window on the interface)
#   make check      full verification: fast tests + real model/web E2E tests
#   make check-fast sanity: page/text/unit/UI/LAN tests without starting the model
#   make check-real starts the real model and runs live Search/DeepResearch/remote tests
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

BIN      := dstudio
SRC      := src/dstudio.c
APP      := src/app.cc
HDR      := src/webview.h
PAGE     := web/index.html
LOADING  := web/loading.html
GEN      := src/page_data.h
LOADING_GEN := src/loading_data.h
LOGO     := assets/logo.png
LOGO_HDR := src/logo_data.h
ICNS     := ds4.icns
PLIST    := assets/Info.plist
TEST_BUILD := tests/.build
TEST_UNIT  := $(TEST_BUILD)/lan_unit
TEST_SERVER := $(TEST_BUILD)/dstudio-server-test
LINUX_APP_ID := dev.ds4.DStudio
DESKTOP  := $(LINUX_APP_ID).desktop
XDG_DATA_HOME ?= $(HOME)/.local/share
DESKTOP_INSTALL_DIR ?= $(XDG_DATA_HOME)/applications
ICON_INSTALL_DIR ?= $(XDG_DATA_HOME)/icons/hicolor/1024x1024/apps

# Webview backend per platform.
UNAME := $(shell uname)
ifeq ($(UNAME),Darwin)
  APPCXX       := clang++
  APP_CXXFLAGS := -x objective-c++ -fno-objc-arc -std=c++11 -O2 $(WARN_CXXFLAGS)
  APP_LDFLAGS  := -framework Cocoa -framework WebKit \
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

.PHONY: all run check check-fast check-real test-lan-unit test-ui-contract test-ui-browser test-http-lan test-real-search-research test-real-remote clean app windows install-desktop uninstall-desktop

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
app: $(BIN)
ifeq ($(UNAME),Darwin)
	@rm -rf $(APPDIR)
	@mkdir -p $(APPDIR)/Contents/MacOS $(APPDIR)/Contents/Resources
	@cp -X $(BIN) $(APPDIR)/Contents/MacOS/$(APPNAME)
	@cp $(ICNS) $(APPDIR)/Contents/Resources/ds4.icns
	@cp $(PLIST) $(APPDIR)/Contents/Info.plist
	@/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string $(APPNAME)' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || true
	@/usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string ds4' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || true
	@/usr/libexec/PlistBuddy -c 'Add :CFBundleShortVersionString string 1.0' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || true
	@/usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 1' $(APPDIR)/Contents/Info.plist >/dev/null 2>&1 || true
	@codesign --force -s - $(APPDIR) >/dev/null 2>&1 && echo "$(APPDIR): ad-hoc signature ok" || echo "$(APPDIR): signature skipped"
	@echo "$(APPDIR) ready: double click to start (no Terminal)."
else
	@echo "make app is for macOS only"
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
dstudio.o: $(SRC) $(GEN) $(LOADING_GEN)
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
$(TEST_UNIT): tests/lan_unit.c $(SRC) $(GEN) $(LOADING_GEN)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) tests/lan_unit.c -o $@

$(TEST_SERVER): $(SRC) $(PAGE) $(LOADING)
	@mkdir -p $(TEST_BUILD)
	$(CC) $(CFLAGS) $(SRC) -o $@

test-lan-unit: $(TEST_UNIT)
	@$(TEST_UNIT)

test-ui-contract:
	@if command -v node >/dev/null 2>&1; then node tests/ui_contract_test.mjs; else echo "node missing: skipping UI contract tests"; fi

test-ui-browser:
	@if command -v node >/dev/null 2>&1; then node tests/ui_agent_design_playwright_test.mjs; else echo "node missing: skipping UI browser tests"; fi

test-http-lan: $(TEST_SERVER)
	@tests/http_lan_test.sh $(TEST_SERVER)

check-fast: $(BIN) test-lan-unit test-ui-contract test-ui-browser test-http-lan
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

test-real-remote: $(TEST_SERVER)
	@command -v node >/dev/null 2>&1 || (echo "node missing: real remote tests require node" && exit 1)
	@node tests/real_remote_test.mjs $(TEST_SERVER)

check-real: $(TEST_SERVER) test-real-search-research test-real-remote

check: check-fast check-real

windows:
	pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1

clean:
	rm -f $(BIN) $(GEN) $(LOADING_GEN) $(LOGO_HDR) $(ICNS) $(DESKTOP) dstudio.o app.o
	rm -rf $(TEST_BUILD)
	@rm -rf ds4.iconset .icontmp.icns .icontmp.rsrc

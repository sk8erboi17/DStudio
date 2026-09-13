# Supplemental Makefile: compiles the DStudio frontend against the selected
# upstream flags, core and linker. build-design.sh supplies a private snapshot
# with the versioned media-memory patch; its objects never enter the original
# engine checkout. Direct low-level invocations remain useful for backend tests.
#
# Usage (from the ds4 dir):
#   make -f <path>/design.mk DESIGN_SRC=<path>/ds4_design.c REMOTE_DIR=<path>/../remote ds4-design

include Makefile

REMOTE_DIR ?= ../DStudio/extension/remote

ifneq ($(findstring -DDS4_NO_GPU,$(CFLAGS)),)
DESIGN_CORE_OBJS ?= $(CPU_CORE_OBJS)
DESIGN_LINK ?= $(CC) $(CFLAGS)
DESIGN_LDLIBS ?= $(LDLIBS)
else
DESIGN_CORE_OBJS ?= $(CORE_OBJS)
ifeq ($(UNAME_S),Darwin)
DESIGN_LINK ?= $(CC) $(CFLAGS)
DESIGN_LDLIBS ?= $(METAL_LDLIBS)
else
DESIGN_LINK ?= $(DS4_LINK)
DESIGN_LDLIBS ?= $(DS4_LINK_LIBS)
endif
endif
ifeq ($(strip $(DESIGN_LINK)),)
$(error The selected upstream backend has no Design linker)
endif

# Compile the actual upstream public type: Laguna has no native vision API.
# This is a capability probe, not a source-text/version-name guess.
DESIGN_HAS_NATIVE_VISION := $(shell printf '\043include "ds4.h"\nds4_vision_span probe;\n' | $(CC) $(CFLAGS) -I. -x c -fsyntax-only - >/dev/null 2>&1 && echo 1 || echo 0)

.PHONY: dstudio-design-force
dstudio-design-force:

# Export resolved flags instead of interpolating them into shell quoting.
# The wrapper hashes this output without publishing local paths/environment.
export DSTUDIO_DESIGN_CONFIG = $(UNAME_S)|$(CC)|$(CFLAGS)|$(OBJCFLAGS)|$(CPPFLAGS)|$(LDFLAGS)|$(LDLIBS)|$(METAL_LDLIBS)|$(DESIGN_CORE_OBJS)|$(DESIGN_LINK)|$(DESIGN_LDLIBS)|$(NVCC)|$(NVCCFLAGS)|$(NVCC_ARCH_FLAGS)|$(CUDA_ARCH)|$(CUDA_HOME)|$(HIPCC)|$(ROCM_ARCH)|$(ROCM_CFLAGS)|$(ROCM_HOST_CFLAGS)|$(ROCM_LDLIBS)|$(ROCM_MMQ_FLAGS)|$(VULKAN_SDK)
export DSTUDIO_DESIGN_TOOLS = $(firstword $(CC)) $(firstword $(DESIGN_LINK)) ld
.PHONY: dstudio-design-config
dstudio-design-config:
	@printf '%s\n' "$$DSTUDIO_DESIGN_CONFIG"
	@$(CC) --version
	@for tool in $$DSTUDIO_DESIGN_TOOLS; do \
		resolved=$$(command -v "$$tool") && test -f "$$resolved" && \
		if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$$resolved"; \
		else sha256sum "$$resolved"; fi || printf 'dstudio-tool-unverified:%s\n' "$$tool"; \
	done
ifeq ($(UNAME_S),Darwin)
	@xcrun --show-sdk-path
	@xcrun --show-sdk-version
	@for tool in clang ld; do resolved=$$(xcrun --find "$$tool") && \
		shasum -a 256 "$$resolved" || printf 'dstudio-tool-unverified:%s\n' "$$tool"; done
else
ifeq ($(findstring -DDS4_NO_GPU,$(CFLAGS)),)
	@$(DESIGN_LINK) --version
endif
endif

# -I.: the source lives outside the ds4 repo, so #include "ds4.h" must be
# resolved from the cwd (the ds4 dir), not from the source's dir. External
# paths stay out of Make prerequisites because the standard macOS support path
# contains a space; the wrapper performs the freshness check before invoking us.
ds4_design.o: ds4.h ds4_ssd.h ds4_web.h ds4_kvstore.h dstudio-design-force
	$(CC) $(CFLAGS) -DDSTUDIO_HAS_NATIVE_VISION=$(DESIGN_HAS_NATIVE_VISION) -I. -I"$(REMOTE_DIR)" -c -o $@ "$(DESIGN_SRC)"

dstudio_remote_llm.o: dstudio-design-force
	$(CC) $(CFLAGS) -I"$(REMOTE_DIR)" -c -o $@ "$(REMOTE_DIR)/dstudio_remote_llm.c"

# ds4_web.o adds the web tools (Chrome via CDP); ds4_kvstore.o adds session
# persistence (KV on disk). Both use the main Makefile; the selected backend
# owns the complete core-object list and link libraries, including CUDA/ROCm.
ds4-design: ds4_design.o dstudio_remote_llm.o ds4_web.o ds4_kvstore.o $(DESIGN_CORE_OBJS)
	$(DESIGN_LINK) -o $@ $^ $(DESIGN_LDLIBS)

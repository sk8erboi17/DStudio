include Makefile
JSONL_CFLAGS ?= $(CFLAGS)
ifneq ($(findstring -DDS4_NO_GPU,$(JSONL_CFLAGS)),)
JSONL_CORE_OBJS ?= $(CPU_CORE_OBJS)
JSONL_LINK ?= $(CC) $(JSONL_CFLAGS)
JSONL_LDLIBS ?= $(LDLIBS)
else
JSONL_CORE_OBJS ?= $(CORE_OBJS)
ifeq ($(UNAME_S),Darwin)
JSONL_LINK ?= $(CC) $(JSONL_CFLAGS)
JSONL_LDLIBS ?= $(METAL_LDLIBS)
else
# CUDA/ROCm links require their selected upstream toolchain and libraries.
# A successful C compilation alone does not produce a usable GPU executable.
JSONL_LINK ?= $(DS4_LINK)
JSONL_LDLIBS ?= $(DS4_LINK_LIBS)
endif
endif
ifeq ($(strip $(JSONL_LINK)),)
$(error The selected upstream backend has no JSONL linker)
endif
# Newer ds4 revisions moved shared --gpu-vram parsing into a separate object;
# older supported revisions do not ship that source. Select it only when it
# exists, and use the CPU-flavoured object for DS4_NO_GPU builds.
JSONL_GPU_ARGS_OBJ ?= $(if $(wildcard ds4_gpu_args.c),$(if $(findstring -DDS4_NO_GPU,$(JSONL_CFLAGS)),ds4_gpu_args_cpu.o,ds4_gpu_args.o),)
JSONL_PROMPT_PREFIX_OBJ ?= $(if $(wildcard ds4_prompt_prefix.c),ds4_prompt_prefix.o,)
DSTUDIO_REMOTE_DIR ?= ../DStudio/extension/remote
DSTUDIO_COWORK_DIR ?= ../DStudio/extension/cowork
DSTUDIO_PLD_DIR ?= $(DSTUDIO_REMOTE_DIR)/../../patch/ds4-agent-jsonl
# Agent/Cowork builds use a private, checkout-relative directory. No upstream
# source or working derived executable is replaced before both links succeed.
JSONL_OUT ?= .
JSONL_AGENT_SRC ?= ds4_agent_ds4ui.c
JSONL_WEB_SRC ?= ds4_web_ds4ui.c
JSONL_SERVER_SRC ?= ds4_server_pld.c
# Only the known modern Metal ABI builds the additive verifier. Other engines
# retain their normal core and link an explicit unavailable implementation.
ifeq ($(UNAME_S),Darwin)
ifeq ($(findstring -DDS4_NO_GPU,$(JSONL_CFLAGS)),)
JSONL_PLD_NATIVE := $(shell grep -q '^void ds4_session_gpu_warmup' ds4.c && grep -q 'dspark_exact_sampling' ds4.h && echo 1)
endif
endif
ifeq ($(JSONL_PLD_NATIVE),1)
JSONL_PLD_FLAGS := -DDSTUDIO_PLD_NATIVE
JSONL_PLD_CORE_OBJS = $(filter-out ds4.o,$(JSONL_CORE_OBJS))
else
JSONL_PLD_CORE_OBJS = $(JSONL_CORE_OBJS)
endif
.PHONY: dstudio-jsonl-force
dstudio-jsonl-force:

# External DStudio paths can live under macOS "Application Support". Keep them
# out of Make's prerequisite parser (which splits on spaces), rebuild these two
# small objects whenever this supplemental target runs, and quote them at the
# shell boundary.
$(JSONL_OUT)/ds4_agent_jsonl.o: $(JSONL_AGENT_SRC) dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I. -I"$(DSTUDIO_REMOTE_DIR)" -I"$(DSTUDIO_COWORK_DIR)" -I"$(DSTUDIO_PLD_DIR)" -c -o $@ "$(JSONL_AGENT_SRC)"
$(JSONL_OUT)/ds4_pld_core.o: ds4.c ds4.h dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) $(JSONL_PLD_FLAGS) -I. -I"$(DSTUDIO_PLD_DIR)" -c -o $@ "$(DSTUDIO_PLD_DIR)/pld_core.c"
$(JSONL_OUT)/ds4_web_ds4ui.o: $(JSONL_WEB_SRC) dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I. -c -o $@ "$(JSONL_WEB_SRC)"
$(JSONL_OUT)/dstudio_remote_llm.o: dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_REMOTE_DIR)" -c -o $@ "$(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c"
$(JSONL_OUT)/ds4_cowork.o: dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_COWORK_DIR)" -c -o $@ "$(DSTUDIO_COWORK_DIR)/ds4_cowork.c"
$(JSONL_OUT)/ds4-agent-jsonl: $(JSONL_OUT)/ds4_agent_jsonl.o $(JSONL_OUT)/ds4_cowork.o $(JSONL_OUT)/dstudio_remote_llm.o $(JSONL_OUT)/ds4_pld_core.o ds4_help.o $(JSONL_PROMPT_PREFIX_OBJ) $(JSONL_OUT)/ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_PLD_CORE_OBJS)
	$(JSONL_LINK) -o $@ $^ $(JSONL_LDLIBS)
$(JSONL_OUT)/ds4-cowork: $(JSONL_OUT)/ds4-agent-jsonl
	cp -f "$<" "$@"

# Chat uses a patched temporary translation unit too. The upstream server
# source/object/binary remain available for native baseline comparisons.
$(JSONL_OUT)/ds4_server_pld.o: $(JSONL_SERVER_SRC) dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I. -I"$(DSTUDIO_PLD_DIR)" -c -o $@ "$(JSONL_SERVER_SRC)"
$(JSONL_OUT)/ds4-server-pld: $(JSONL_OUT)/ds4_server_pld.o $(JSONL_OUT)/ds4_pld_core.o ds4_help.o $(JSONL_PROMPT_PREFIX_OBJ) ds4_kvstore.o rax.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_PLD_CORE_OBJS)
	$(JSONL_LINK) -o $@ $^ $(JSONL_LDLIBS)

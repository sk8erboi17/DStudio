include Makefile
JSONL_CFLAGS ?= $(CFLAGS)
JSONL_CORE_OBJS ?= $(CORE_OBJS)
JSONL_LDLIBS ?= $(METAL_LDLIBS)
# Newer ds4 revisions moved shared --gpu-vram parsing into a separate object;
# older supported revisions do not ship that source. Select it only when it
# exists, and use the CPU-flavoured object for DS4_NO_GPU builds.
JSONL_GPU_ARGS_OBJ ?= $(if $(wildcard ds4_gpu_args.c),$(if $(findstring -DDS4_NO_GPU,$(JSONL_CFLAGS)),ds4_gpu_args_cpu.o,ds4_gpu_args.o),)
JSONL_PROMPT_PREFIX_OBJ ?= $(if $(wildcard ds4_prompt_prefix.c),ds4_prompt_prefix.o,)
DSTUDIO_REMOTE_DIR ?= ../DStudio/extension/remote
DSTUDIO_COWORK_DIR ?= ../DStudio/extension/cowork
DSTUDIO_PLD_DIR ?= $(DSTUDIO_REMOTE_DIR)/../../patch/ds4-agent-jsonl
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
ds4_agent_jsonl.o: ds4_agent.c dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I. -I"$(DSTUDIO_REMOTE_DIR)" -I"$(DSTUDIO_COWORK_DIR)" -I"$(DSTUDIO_PLD_DIR)" -c -o $@ ds4_agent.c
ds4_pld_core.o: ds4.c ds4.h dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) $(JSONL_PLD_FLAGS) -I. -I"$(DSTUDIO_PLD_DIR)" -c -o $@ "$(DSTUDIO_PLD_DIR)/pld_core.c"
ds4_web_ds4ui.o: ds4_web_ds4ui.c
	$(CC) $(JSONL_CFLAGS) -c -o $@ ds4_web_ds4ui.c
dstudio_remote_llm.o: dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_REMOTE_DIR)" -c -o $@ "$(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c"
ds4_cowork.o: dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_COWORK_DIR)" -c -o $@ "$(DSTUDIO_COWORK_DIR)/ds4_cowork.c"
ds4-agent-jsonl: ds4_agent_jsonl.o ds4_cowork.o dstudio_remote_llm.o ds4_pld_core.o ds4_help.o $(JSONL_PROMPT_PREFIX_OBJ) ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_PLD_CORE_OBJS)
	$(CC) $(JSONL_CFLAGS) -o $@ ds4_agent_jsonl.o ds4_cowork.o dstudio_remote_llm.o ds4_pld_core.o ds4_help.o $(JSONL_PROMPT_PREFIX_OBJ) ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_PLD_CORE_OBJS) $(JSONL_LDLIBS)
ds4-cowork: ds4-agent-jsonl
	cp -f ds4-agent-jsonl ds4-cowork

# Chat uses a patched temporary translation unit too. The upstream server
# source/object/binary remain available for native baseline comparisons.
ds4_server_pld.o: ds4_server_pld.c dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I. -I"$(DSTUDIO_PLD_DIR)" -c -o $@ ds4_server_pld.c
ds4-server-pld: ds4_server_pld.o ds4_pld_core.o ds4_help.o $(JSONL_PROMPT_PREFIX_OBJ) ds4_kvstore.o rax.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_PLD_CORE_OBJS)
	$(CC) $(JSONL_CFLAGS) -o $@ $^ $(JSONL_LDLIBS)

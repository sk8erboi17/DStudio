include Makefile
JSONL_CFLAGS ?= $(CFLAGS)
JSONL_CORE_OBJS ?= $(CORE_OBJS)
JSONL_LDLIBS ?= $(METAL_LDLIBS)
# Newer ds4 revisions moved shared --gpu-vram parsing into a separate object;
# older supported revisions do not ship that source. Select it only when it
# exists, and use the CPU-flavoured object for DS4_NO_GPU builds.
JSONL_GPU_ARGS_OBJ ?= $(if $(wildcard ds4_gpu_args.c),$(if $(findstring -DDS4_NO_GPU,$(JSONL_CFLAGS)),ds4_gpu_args_cpu.o,ds4_gpu_args.o),)
DSTUDIO_REMOTE_DIR ?= ../DStudio/extension/remote
DSTUDIO_COWORK_DIR ?= ../DStudio/extension/cowork
.PHONY: dstudio-jsonl-force
dstudio-jsonl-force:

# External DStudio paths can live under macOS "Application Support". Keep them
# out of Make's prerequisite parser (which splits on spaces), rebuild these two
# small objects whenever this supplemental target runs, and quote them at the
# shell boundary.
ds4_agent_jsonl.o: ds4_agent.c dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_REMOTE_DIR)" -I"$(DSTUDIO_COWORK_DIR)" -c -o $@ ds4_agent.c
ds4_web_ds4ui.o: ds4_web_ds4ui.c
	$(CC) $(JSONL_CFLAGS) -c -o $@ ds4_web_ds4ui.c
dstudio_remote_llm.o: dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_REMOTE_DIR)" -c -o $@ "$(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c"
ds4_cowork.o: dstudio-jsonl-force
	$(CC) $(JSONL_CFLAGS) -I"$(DSTUDIO_COWORK_DIR)" -c -o $@ "$(DSTUDIO_COWORK_DIR)/ds4_cowork.c"
ds4-agent-jsonl: ds4_agent_jsonl.o ds4_cowork.o dstudio_remote_llm.o ds4_help.o ds4_prompt_prefix.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_CORE_OBJS)
	$(CC) $(JSONL_CFLAGS) -o $@ ds4_agent_jsonl.o ds4_cowork.o dstudio_remote_llm.o ds4_help.o ds4_prompt_prefix.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_GPU_ARGS_OBJ) $(JSONL_CORE_OBJS) $(JSONL_LDLIBS)
ds4-cowork: ds4-agent-jsonl
	cp -f ds4-agent-jsonl ds4-cowork

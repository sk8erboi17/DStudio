include Makefile
JSONL_CFLAGS ?= $(CFLAGS)
JSONL_CORE_OBJS ?= $(CORE_OBJS)
JSONL_LDLIBS ?= $(METAL_LDLIBS)
DSTUDIO_REMOTE_DIR ?= ../DStudio/extension/remote
# Every supported checkout exposes the GPU argument translation unit and the
# memory-pressure hooks used by the optional Qwen document pipeline.
JSONL_MEMORY_PRESSURE_CFLAG := -DDS4UI_HAVE_MEMORY_PRESSURE_API
ds4_agent_jsonl.o: ds4_agent.c
	$(CC) $(JSONL_CFLAGS) $(JSONL_MEMORY_PRESSURE_CFLAG) -I$(DSTUDIO_REMOTE_DIR) -c -o $@ ds4_agent.c
ds4_web_ds4ui.o: ds4_web_ds4ui.c
	$(CC) $(JSONL_CFLAGS) -c -o $@ ds4_web_ds4ui.c
dstudio_remote_llm.o: $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.h
	$(CC) $(JSONL_CFLAGS) -I$(DSTUDIO_REMOTE_DIR) -c -o $@ $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c
ds4-agent-jsonl: ds4_agent_jsonl.o dstudio_remote_llm.o ds4_help.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o ds4_gpu_args.o $(JSONL_CORE_OBJS)
	$(CC) $(JSONL_CFLAGS) -o $@ ds4_agent_jsonl.o dstudio_remote_llm.o ds4_help.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o ds4_gpu_args.o $(JSONL_CORE_OBJS) $(JSONL_LDLIBS)

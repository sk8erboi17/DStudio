include Makefile
JSONL_CFLAGS ?= $(CFLAGS)
JSONL_CORE_OBJS ?= $(CORE_OBJS)
JSONL_LDLIBS ?= $(METAL_LDLIBS)
DSTUDIO_REMOTE_DIR ?= ../DStudio/extension/remote
ds4_agent_jsonl.o: ds4_agent.c
	$(CC) $(JSONL_CFLAGS) -I$(DSTUDIO_REMOTE_DIR) -c -o $@ ds4_agent.c
ds4_web_ds4ui.o: ds4_web_ds4ui.c
	$(CC) $(JSONL_CFLAGS) -c -o $@ ds4_web_ds4ui.c
dstudio_remote_llm.o: $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.h
	$(CC) $(JSONL_CFLAGS) -I$(DSTUDIO_REMOTE_DIR) -c -o $@ $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c
ds4-agent-jsonl: ds4_agent_jsonl.o dstudio_remote_llm.o ds4_help.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_CORE_OBJS)
	$(CC) $(JSONL_CFLAGS) -o $@ ds4_agent_jsonl.o dstudio_remote_llm.o ds4_help.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_CORE_OBJS) $(JSONL_LDLIBS)

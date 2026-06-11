# Supplemental Makefile: builds ds4-design in the ds4 repo from the external
# source DESIGN_SRC (this repo, extension/design/ds4_design.c). Unlike
# jsonl.mk it needs NO patch: the source is a self-contained file that only
# includes ds4.h. It reuses CFLAGS/CORE_OBJS/METAL_LDLIBS and the objects
# already compiled by the main Makefile; the outputs (ds4_design.o,
# ds4-design) stay untracked in the ds4 repo, like ds4-agent-jsonl.
#
# Usage (from the ds4 dir):
#   make -f <path>/design.mk DESIGN_SRC=<path>/ds4_design.c REMOTE_DIR=<path>/../remote ds4-design

include Makefile

REMOTE_DIR ?= ../DStudio/extension/remote

# -I.: the source lives outside the ds4 repo, so #include "ds4.h" must be
# resolved from the cwd (the ds4 dir), not from the source's dir.
ds4_design.o: $(DESIGN_SRC) ds4.h ds4_ssd.h ds4_web.h ds4_kvstore.h $(REMOTE_DIR)/dstudio_remote_llm.h
	$(CC) $(CFLAGS) -I. -I$(REMOTE_DIR) -c -o $@ $(DESIGN_SRC)

dstudio_remote_llm.o: $(REMOTE_DIR)/dstudio_remote_llm.c $(REMOTE_DIR)/dstudio_remote_llm.h
	$(CC) $(CFLAGS) -I$(REMOTE_DIR) -c -o $@ $(REMOTE_DIR)/dstudio_remote_llm.c

# ds4_web.o adds the web tools (Chrome via CDP); ds4_kvstore.o adds session
# persistence (KV on disk). No extra library needed, -lm -pthread already in
# METAL_LDLIBS. Both are compiled by the main Makefile.
ds4-design: ds4_design.o dstudio_remote_llm.o ds4_web.o ds4_kvstore.o $(CORE_OBJS)
	$(CC) $(CFLAGS) -o $@ ds4_design.o dstudio_remote_llm.o ds4_web.o ds4_kvstore.o $(CORE_OBJS) $(METAL_LDLIBS)

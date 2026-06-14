CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Iinclude

all: build/stack_parser_review

build/stack_parser_review: src/main.c src/protocol.c include/protocol.h
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ src/main.c src/protocol.c

clean:
	rm -rf build

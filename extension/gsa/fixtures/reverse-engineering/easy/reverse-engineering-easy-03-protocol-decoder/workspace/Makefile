CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Iinclude

all: build/protocol_decoder

build/protocol_decoder: src/main.c src/record_parser.c src/update_verifier.c include/record.h
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ src/main.c src/record_parser.c src/update_verifier.c

clean:
	rm -rf build

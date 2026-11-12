#!/bin/sh
# Record how a ds4-family checkout's executables were built (PLAN.MD P0.2):
# DS4_DIR/.dstudio-build.json names the compiler, make, the flags the
# checkout's own Makefile expands to, and the SHA-256 of each built
# executable. Run by the host right after a successful build; it changes no
# source or binary. A receipt that cannot be written is reported on stderr and
# the build stays usable: the binary SHA-256 is still the identity a run
# records, this receipt only says how that binary was made.
set -eu
action=${1:-record}
[ "$action" = record ] || { echo "DStudio engine build receipt: expected record" >&2; exit 2; }
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/Makefile" ] || [ -L "$ds4_dir/Makefile" ]; then
    echo "DStudio engine build receipt: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/dstudio-build-receipt.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
# The checkout's Makefile decides CC and the flags (with ?= defaults and
# platform additions); ask make for their expanded values instead of guessing.
cat > "$work/print.mk" <<'MK'
dstudio-print-build:
	@printf 'CC\t%s\n' "$(CC)"
	@printf 'CFLAGS\t%s\n' "$(CFLAGS)"
	@printf 'OBJCFLAGS\t%s\n' "$(OBJCFLAGS)"
	@printf 'LDLIBS\t%s\n' "$(LDLIBS)"
	@printf 'METAL_LDLIBS\t%s\n' "$(METAL_LDLIBS)"
MK
if ! make -s -C "$ds4_dir" -f Makefile -f "$work/print.mk" dstudio-print-build > "$work/flags.tsv" 2> "$work/make.err"; then
    echo "DStudio engine build receipt: make could not report the build flags; no receipt written" >&2
    exit 1
fi
cc_bin=$(awk -F '\t' '$1 == "CC" { print $2 }' "$work/flags.tsv")
"${cc_bin:-cc}" --version > "$work/cc.txt" 2>&1 || true
make --version > "$work/make.txt" 2>&1 || true
python3 -I - "$ds4_dir" "$work" <<'PY'
import hashlib, json, os, sys, time
ds4_dir, work = sys.argv[1], sys.argv[2]
flags = {}
for line in open(os.path.join(work, 'flags.tsv'), encoding='utf-8', errors='replace'):
    key, _, value = line.rstrip('\n').partition('\t')
    flags[key] = value
def first_lines(name, n=2):
    lines = open(os.path.join(work, name), encoding='utf-8', errors='replace').read().splitlines()
    return [line for line in lines if line.strip()][:n]
executables = []
for name in ('ds4-server', 'ds4', 'ds4-agent-jsonl', 'ds4-cowork', 'ds4-design', 'ds4-server-pld'):
    path = os.path.join(ds4_dir, name)
    if os.path.isfile(path) and not os.path.islink(path):
        digest = hashlib.sha256()
        with open(path, 'rb') as handle:
            for block in iter(lambda: handle.read(1 << 20), b''):
                digest.update(block)
        st = os.stat(path)
        executables.append({'name': name, 'bytes': st.st_size, 'mtime': int(st.st_mtime), 'sha256': digest.hexdigest()})
receipt = {'schema': 'dstudio.engine-build.v1', 'recordedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'compiler': first_lines('cc.txt'), 'make': first_lines('make.txt', 1), 'flags': flags, 'executables': executables}
tmp = os.path.join(ds4_dir, '.dstudio-build.json.tmp')
with open(tmp, 'w', encoding='utf-8') as out:
    json.dump(receipt, out, indent=1, sort_keys=True)
    out.write('\n')
os.replace(tmp, os.path.join(ds4_dir, '.dstudio-build.json'))
print('DStudio engine build receipt: recorded %d executable(s)' % len(executables))
PY

#!/usr/bin/env python3
"""Backport Hugging Face's native MPS allocator-warmup skip to 4.57.1.

HunyuanImage-3.0's SigLIP2 preprocessing contract targets Transformers 4.57.
Later Transformers releases include the MPS skip but replace that processor
contract.  This applies only the upstream loading fix to the pinned compatible
release; it does not modify model inference, preprocessing, or numerical code.
"""

from __future__ import annotations

import importlib.metadata
from pathlib import Path
import sys


PINNED_VERSION = "4.57.1"
OLD = (
    "        # Allocate memory\n"
    "        _ = torch.empty(byte_count // factor, dtype=torch.float16, device=device, requires_grad=False)\n"
)
NEW = (
    "        elif device.type == \"mps\":\n"
    "            # Upstream Transformers fix: a single MPS buffer is capped below total\n"
    "            # unified memory and allocator warm-up provides no safe benefit here.\n"
    "            continue\n"
    "        # Allocate memory\n"
    "        _ = torch.empty(byte_count // factor, dtype=torch.float16, device=device, requires_grad=False)\n"
)


def patch_path(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if text.count(NEW) == 1:
        return False
    if text.count(OLD) != 1:
        raise RuntimeError(
            f"unexpected Transformers source in {path}: "
            f"original={text.count(OLD)}, backport={text.count(NEW)}"
        )
    temporary = path.with_name(path.name + ".mps-backport.tmp")
    temporary.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    temporary.replace(path)
    return True


def main() -> int:
    try:
        actual = importlib.metadata.version("transformers")
        if actual != PINNED_VERSION:
            raise RuntimeError(
                f"Transformers MPS backport requires {PINNED_VERSION}, found {actual}"
            )
        import transformers.modeling_utils as modeling_utils

        path = Path(modeling_utils.__file__).resolve()
        patch_path(path)
        source = path.read_text(encoding="utf-8")
        if 'elif device.type == "mps"' not in source or NEW not in source:
            raise RuntimeError("Transformers MPS warm-up backport validation failed")
        print(path)
        return 0
    except (OSError, RuntimeError) as exc:
        print(f"Transformers MPS warm-up backport failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

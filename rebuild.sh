#!/usr/bin/env bash
# Pull latest DStudio + ds4, rebuild Windows x64 portable.
# Run from MSYS2/Git Bash on Windows.

set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/mingw64/bin:/ucrt64/bin:/clang64/bin:$PATH"

ROOT="/c/Users/pirat/Desktop/DStudio/DStudio"
DS4="/c/Users/pirat/Desktop/ds4"
LOG="$ROOT/rebuild.log"
VCVARS="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat"
CYGWIN_ROOT_WIN="C:\\msys64\\usr"

git_pull_ff() {
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git pull --ff-only
  else
    git pull --ff-only origin main
  fi
}

echo "==> git pull DStudio"
cd "$ROOT"
git_pull_ff

echo "==> git pull ds4"
cd "$DS4"
git_pull_ff

echo "==> reapply strndup patches (idempotent)"
cd "$ROOT"
sed -i 's/\bstrndup(vs, (size_t)(ve - vs))/ds4_strndup_local(vs, (size_t)(ve - vs))/' src/dstudio.c
sed -i 's/\breturn strndup(s, n);/return ds4_strndup_local(s, n);/' src/dstudio.c

echo "==> clean previous artifacts"
rm -rf build/windows dist/DStudio-windows-x64 dist/DStudio-windows-x64.zip

echo "==> build (vcvars64 + build-windows.ps1) -- logging to $LOG"
if [ ! -f "$VCVARS" ]; then
  echo "vcvars64.bat not found: $VCVARS" >&2
  exit 1
fi

BUILD_RUN="$(mktemp --suffix=.cmd)"
trap 'rm -f "$BUILD_RUN"' EXIT
cat > "$BUILD_RUN" <<EOF
@echo off
call "$(cygpath -w "$VCVARS")"
if errorlevel 1 exit /b %errorlevel%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$ROOT/scripts/build-windows.ps1")" -Ds4Dir "$(cygpath -w "$DS4")" -CygwinRoot "$CYGWIN_ROOT_WIN"
exit /b %errorlevel%
EOF

cmd.exe //c "$(cygpath -w "$BUILD_RUN")" 2>&1 | tee "$LOG"

echo "==> artifacts:"
ls -lh dist/DStudio-windows-x64.zip dist/DStudio-windows-x64/ 2>/dev/null || true

echo "==> DStudio.exe path:"
echo "  $ROOT/dist/DStudio-windows-x64/DStudio.exe"

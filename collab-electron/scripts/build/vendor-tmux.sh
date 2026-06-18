#!/bin/bash
set -euo pipefail

# Vendor tmux and its dynamic libraries for bundling in the Electron app.
# Copies the Homebrew-installed tmux binary and its non-system dylibs
# into vendor/tmux/, then rewrites the binary's library paths to use
# @loader_path/lib/ so it works without Homebrew at runtime.

cd "$(dirname "$0")/.."

VENDOR_DIR="vendor/tmux"
LIB_DIR="$VENDOR_DIR/lib"

rm -rf "$VENDOR_DIR"
mkdir -p "$LIB_DIR"

# Locate tmux via Homebrew
TMUX_BIN="$(brew --prefix tmux)/bin/tmux"
if [ ! -f "$TMUX_BIN" ]; then
  echo "Error: tmux not found at $TMUX_BIN"
  echo "Install it with: brew install tmux"
  exit 1
fi

echo "Copying tmux from $TMUX_BIN"
cp "$TMUX_BIN" "$VENDOR_DIR/tmux"
chmod 755 "$VENDOR_DIR/tmux"

# Copy non-system dylibs and rewrite paths
copy_dylibs() {
  local binary="$1"

  otool -L "$binary" | tail -n +2 | awk '{print $1}' | while read -r lib; do
    # Skip system libraries
    case "$lib" in
      /usr/lib/*|/System/*) continue ;;
    esac

    local libname
    libname="$(basename "$lib")"

    if [ ! -f "$LIB_DIR/$libname" ]; then
      echo "  Vendoring $lib"
      cp "$lib" "$LIB_DIR/$libname"
      chmod 644 "$LIB_DIR/$libname"

      # Fix the library's own install name
      install_name_tool -id "@loader_path/lib/$libname" "$LIB_DIR/$libname"

      # Recursively vendor this library's dependencies
      copy_dylibs "$LIB_DIR/$libname"
    fi

    # Rewrite the reference in the binary/library
    install_name_tool -change "$lib" "@loader_path/lib/$libname" "$binary" 2>/dev/null || true
  done
}

echo "Vendoring dynamic libraries..."
copy_dylibs "$VENDOR_DIR/tmux"

# Fix inter-library references (libs referencing other vendored libs)
for lib in "$LIB_DIR"/*.dylib; do
  [ -f "$lib" ] || continue
  otool -L "$lib" | tail -n +2 | awk '{print $1}' | while read -r dep; do
    case "$dep" in
      /usr/lib/*|/System/*|@loader_path/*) continue ;;
    esac
    local_name="$(basename "$dep")"
    if [ -f "$LIB_DIR/$local_name" ]; then
      install_name_tool -change "$dep" "@loader_path/$local_name" "$lib"
    fi
  done
done

# Ad-hoc codesign everything (required for arm64 macOS)
echo "Codesigning vendored binaries..."
codesign --force --sign - "$VENDOR_DIR/tmux"
for lib in "$LIB_DIR"/*.dylib; do
  [ -f "$lib" ] || continue
  codesign --force --sign - "$lib"
done

echo ""
echo "Vendored files:"
ls -lh "$VENDOR_DIR/tmux"
ls -lh "$LIB_DIR/"

echo ""
echo "Verifying tmux can find its libraries..."
if "$VENDOR_DIR/tmux" -V; then
  echo "Success!"
else
  echo "Warning: tmux -V failed. Check library paths with: otool -L $VENDOR_DIR/tmux"
fi

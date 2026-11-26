#!/bin/sh
# Explicit changed continuation entry point. Original rules are not patched.
set -eu
test "$#" -eq 1
controller_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
controller_fragment=$controller_dir/gcc-staged-configuration.mk
case "$1" in
  checktrail-print-configuration) exec /usr/bin/make --no-print-directory -f debian/rules -f "$controller_fragment" "CHECKTRAIL_GCC_FRAGMENT=$controller_fragment" checktrail-forward-configuration ;;
  stamps/05-build-stamp|stamps/05-build-jit-stamp|stamps/05-build-nvptx-stamp|stamps/06-install-nvptx-stamp|stamps/05-build-gcn-stamp|stamps/06-install-gcn-stamp|stamps/05-build-hppa64-stamp|stamps/07-install-hppa64-stamp|stamps/06-check-stamp) ;;
  *) exit 2 ;;
esac
exec /usr/bin/make --no-print-directory -f debian/rules -f "$controller_fragment" "CHECKTRAIL_GCC_FRAGMENT=$controller_fragment" checktrail-forward-phase "CHECKTRAIL_GCC_TARGET=$1"

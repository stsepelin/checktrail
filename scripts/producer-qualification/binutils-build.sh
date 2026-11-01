#!/bin/sh
# Explicit operator-only build; the enclosing controller owns execution and cleanup.
set -eu
mkdir -p /build /work/output
checktrail_command_invoked=0
checktrail_command_exit=unobserved
retain_native_build() {
  result=$?
  trap - EXIT
  set +e
  python3 - "$checktrail_command_invoked" "$checktrail_command_exit" "$result" > /work/original-command.json <<'RECEIPT'
import json, sys
json.dump({"schemaVersion": 1, "command": ["dpkg-buildpackage", "-b", "-us", "-uc", "--jobs=4"], "invoked": sys.argv[1] == "1", "exitCode": int(sys.argv[2]) if sys.argv[2].isdigit() else None, "wrapperExitCode": int(sys.argv[3])}, sys.stdout)
RECEIPT
  command_record_result=$?
  python3 /controller/binutils-test-reports.py /build/source /work/test-reports.json
  report_result=$?
  tar -C /build -cf /work/native-build-worktree.tar .
  archive_result=$?
  copy_result=0
  for file in /build/*.deb /build/*.udeb /build/*.changes /build/*.buildinfo; do
    if test -f "$file"; then cp -- "$file" /work/output/ || copy_result=1; fi
  done
  printf 'CHECKTRAIL_RETENTION reports=%s archive=%s outputs=%s original=%s\n' "$report_result" "$archive_result" "$copy_result" "$result"
  if test "$result" -eq 0 && { test "$command_record_result" -ne 0 || test "$report_result" -ne 0 || test "$archive_result" -ne 0 || test "$copy_result" -ne 0; }; then result=1; fi
  exit "$result"
}
trap retain_native_build EXIT
apt-get -o APT::Get::AllowUnauthenticated=false -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o Acquire::Check-Valid-Until=true -o Dir::Cache::archives=/var/cache/apt/archives/binutils --yes --no-download --no-install-recommends build-dep /inputs/binutils/binutils_2.40-2.dsc
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /work/installed-build-package-identities.txt
dpkg-source --require-valid-signature --require-strong-checksums --extract /inputs/binutils/binutils_2.40-2.dsc /build/source
test -f /build/source/gprofng/src/Elf.h
test ! -e /build/source/gprofng/src/elf.h
cd /build/source
dpkg-checkbuilddeps debian/control
checktrail_command_invoked=1
set +e
dpkg-buildpackage -b -us -uc --jobs=4
checktrail_command_exit=$?
exit "$checktrail_command_exit"

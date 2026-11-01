#!/bin/sh
# Operator controller only; original source rules/default checks are unchanged.
set -eu
case "$1" in
  gcc-12) descriptor=/inputs/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc ; apt_cache=gcc-12 ;;
  glibc) descriptor=/inputs/glibc/glibc_2.36-9+deb12u14.dsc ; apt_cache=glibc ;;
  glibc-u13) descriptor=/inputs/glibc/glibc_2.36-9+deb12u13.dsc ; apt_cache=glibc ;;
  *) exit 2 ;;
esac
mkdir -p /build /work/output
checktrail_command_invoked=0
checktrail_command_exit=unobserved
retain_native_build() {
  result=$?
  trap - EXIT
  set +e
  python3 -I -S -B - "$checktrail_command_invoked" "$checktrail_command_exit" "$result" > /work/original-command.json <<'RECEIPT'
import json, sys
json.dump({"schemaVersion": 1, "command": ["dpkg-buildpackage", "-b", "-us", "-uc", "--jobs=4"], "invoked": sys.argv[1] == "1", "exitCode": int(sys.argv[2]) if sys.argv[2].isdigit() else None, "wrapperExitCode": int(sys.argv[3])}, sys.stdout)
RECEIPT
  command_record_result=$?
  python3 -I -S -B /controller/c-producer-test-reports.py "$1" /build/source /work/test-reports.json "$checktrail_caller_uid" "$checktrail_caller_gid"
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
checktrail_caller_uid=$2
checktrail_caller_gid=$3
trap 'retain_native_build "$1"' EXIT
apt-get -o APT::Get::AllowUnauthenticated=false -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o Acquire::Check-Valid-Until=true -o "Dir::Cache::archives=/var/cache/apt/archives/$apt_cache" --yes --no-download --no-install-recommends build-dep "$descriptor"
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /work/installed-build-package-identities.txt
dpkg-source --require-valid-signature --require-strong-checksums --extract "$descriptor" /build/source
case "$1" in
  gcc-12) test -f /build/source/gcc-12.2.0-dfsg.tar.xz ;;
  glibc|glibc-u13) test -f /build/source/configure ;;
esac
test -f /build/source/debian/control
cd /build/source
dpkg-checkbuilddeps debian/control
checktrail_command_invoked=1
set +e
dpkg-buildpackage -b -us -uc --jobs=4
checktrail_command_exit=$?
exit "$checktrail_command_exit"

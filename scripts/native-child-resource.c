#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <stdint.h>
#include <sys/resource.h>
#include <unistd.h>

/* Explicit kernel counters, never a sum of concurrently resident processes. */
static int integer(napi_env env, napi_value object, const char *name, long long value) {
  napi_value result;
  if (value < 0 || value > 9007199254740991LL) return 0;
  return napi_create_int64(env, value, &result) == napi_ok &&
         napi_set_named_property(env, object, name, result) == napi_ok;
}
static int text(napi_env env, napi_value object, const char *name, const char *value) {
  napi_value result;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) == napi_ok &&
         napi_set_named_property(env, object, name, result) == napi_ok;
}
static long long microseconds(struct timeval value) {
  if (value.tv_sec < 0 || value.tv_usec < 0 || value.tv_usec >= 1000000 ||
      value.tv_sec > 9007199254LL) return -1;
  return (long long)value.tv_sec * 1000000 + value.tv_usec;
}
static napi_value usage(napi_env env, const struct rusage *raw) {
  napi_value result;
  long long peak = (long long)raw->ru_maxrss;
#if defined(__APPLE__)
  const char *unit = "bytes";
  long long normalized = peak / 1024 + (peak % 1024 != 0);
#elif defined(__linux__)
  const char *unit = "KiB";
  long long normalized = peak;
#else
#error Unsupported native child resource platform
#endif
  if (napi_create_object(env, &result) != napi_ok ||
      !integer(env, result, "userCpuMicroseconds", microseconds(raw->ru_utime)) ||
      !integer(env, result, "systemCpuMicroseconds", microseconds(raw->ru_stime)) ||
      !integer(env, result, "peakRssRaw", peak) ||
      !integer(env, result, "peakRssKiB", normalized) ||
      !text(env, result, "peakRssRawUnit", unit)) return NULL;
  return result;
}
static napi_value snapshot(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0) {
    napi_throw_error(env, NULL, "Native resource snapshot accepts no arguments");
    return NULL;
  }
  struct rusage own, children;
  if (getrusage(RUSAGE_SELF, &own) != 0 || getrusage(RUSAGE_CHILDREN, &children) != 0) {
    napi_throw_error(env, NULL, "Native kernel resource counters unavailable");
    return NULL;
  }
  napi_value result, own_value = usage(env, &own), child_value = usage(env, &children);
  if (!own_value || !child_value || napi_create_object(env, &result) != napi_ok ||
      !integer(env, result, "schemaVersion", 1) ||
      !integer(env, result, "napiVersion", NAPI_VERSION) ||
      !integer(env, result, "pid", (long long)getpid()) ||
      !text(env, result, "selfScope", "RUSAGE_SELF") ||
      !text(env, result, "childrenScope", "RUSAGE_CHILDREN") ||
      napi_set_named_property(env, result, "self", own_value) != napi_ok ||
      napi_set_named_property(env, result, "children", child_value) != napi_ok) {
    napi_throw_error(env, NULL, "Native kernel resource counters invalid");
    return NULL;
  }
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "snapshot", function) != napi_ok) {
    napi_throw_error(env, NULL, "Native resource binding initialization failed");
    return NULL;
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

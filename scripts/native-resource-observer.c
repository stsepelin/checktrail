#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Operator measurement helper. wait4 counters are not a summed tree RSS. */
static int request_id(const char *value) {
  if (strlen(value) != 32) return 0;
  for (int i = 0; i < 32; i++)
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f'))) return 0;
  return 1;
}
static long long microseconds(struct timeval value) {
  if (value.tv_sec < 0 || value.tv_usec < 0 || value.tv_usec >= 1000000 ||
      value.tv_sec > 9007199254LL) return -1;
  return (long long)value.tv_sec * 1000000 + value.tv_usec;
}
int main(int argc, char **argv) {
  if (argc < 4 || !request_id(argv[2]) || argv[3][0] != '/') return 125;
  int receipt = open(argv[1], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (receipt < 0) return 125;
  struct timespec started, ended;
  if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) { close(receipt); return 125; }
  pid_t child = fork();
  if (child < 0) { close(receipt); return 125; }
  if (child == 0) {
    close(receipt);
    execv(argv[3], &argv[3]);
    _exit(127);
  }
  int status = 0;
  struct rusage usage;
  memset(&usage, 0, sizeof(usage));
  pid_t observed;
  do { observed = wait4(child, &status, 0, &usage); } while (observed < 0 && errno == EINTR);
  if (observed != child || clock_gettime(CLOCK_MONOTONIC, &ended) != 0) {
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    close(receipt); return 125;
  }
  long long user = microseconds(usage.ru_utime), system = microseconds(usage.ru_stime);
  long long wall = ((long long)ended.tv_sec - started.tv_sec) * 1000000 +
                   ((long long)ended.tv_nsec - started.tv_nsec) / 1000;
  long long peak = (long long)usage.ru_maxrss;
#if defined(__APPLE__)
  /* Darwin returns bytes; Linux returns KiB. Preserve the raw counter as well. */
  const char *unit = "bytes";
  long long peak_kib = peak / 1024 + (peak % 1024 != 0);
#elif defined(__linux__)
  const char *unit = "KiB";
  long long peak_kib = peak;
#else
#error Unsupported native resource observer platform
#endif
  if (user < 0 || system < 0 || wall < 0 || peak < 0 ||
      (!WIFEXITED(status) && !WIFSIGNALED(status))) { close(receipt); return 125; }
  char exit_code[24], signal_code[24];
  if (WIFEXITED(status)) snprintf(exit_code, sizeof(exit_code), "%d", WEXITSTATUS(status));
  else strcpy(exit_code, "null");
  if (WIFSIGNALED(status)) snprintf(signal_code, sizeof(signal_code), "%d", WTERMSIG(status));
  else strcpy(signal_code, "null");
  char body[2048];
  int size = snprintf(body, sizeof(body),
    "{\"schemaVersion\":1,\"requestId\":\"%s\",\"observerPid\":%ld,\"childPid\":%ld,"
    "\"completed\":true,\"exitCode\":%s,\"signal\":%s,\"wallMicroseconds\":%lld,"
    "\"userCpuMicroseconds\":%lld,\"systemCpuMicroseconds\":%lld,"
    "\"peakRssRaw\":%lld,\"peakRssRawUnit\":\"%s\",\"peakRssKiB\":%lld}\n",
    argv[2], (long)getpid(), (long)child, exit_code, signal_code, wall, user, system,
    peak, unit, peak_kib);
  if (size <= 0 || size >= (int)sizeof(body)) { close(receipt); return 125; }
  int offset = 0;
  while (offset < size) {
    ssize_t count = write(receipt, body + offset, (size_t)(size - offset));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { close(receipt); return 125; }
    offset += (int)count;
  }
  if (close(receipt) != 0) return 125;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

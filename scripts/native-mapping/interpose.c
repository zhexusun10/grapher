// Feasibility probe only: intentionally interpose one libc operation.
// Protected executables and direct syscalls are independent of hook coverage.
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static int mapped_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, int);
        va_end(args);
    }
    const char *source = getenv("PROBE_SOURCE"), *target = getenv("PROBE_TARGET");
    char mapped[PATH_MAX];
    if (source && target && strncmp(path, source, strlen(source)) == 0 &&
        (path[strlen(source)] == '/' || path[strlen(source)] == '\0')) {
        snprintf(mapped, sizeof(mapped), "%s%s", target, path + strlen(source));
        path = mapped;
    }
    return open(path, flags, mode);
}
__attribute__((used)) static struct { const void *replacement; const void *original; }
interpose __attribute__((section("__DATA,__interpose"))) = {
    (const void *)mapped_open, (const void *)open
};

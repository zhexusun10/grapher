#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static int raw_open(const char *path, int flags) {
#if defined(__arm64__)
    register long x0 __asm__("x0") = (long)path;
    register long x1 __asm__("x1") = flags;
    register long x2 __asm__("x2") = 0;
    register long x16 __asm__("x16") = SYS_open;
    unsigned int failed;
    __asm__ volatile("svc #0x80\n\tcset %w1, cs"
        : "+r"(x0), "=r"(failed) : "r"(x1), "r"(x2), "r"(x16) : "memory", "cc");
    if (failed) { errno = (int)x0; return -1; }
    return (int)x0;
#else
#error This probe currently validates Darwin arm64 only.
#endif
}
int main(int argc, char **argv) {
    if (argc < 3) return 2;
    const char *operation = argv[1], *path = argv[2];
    if (!strcmp(operation, "exec")) {
        execl(argv[0], argv[0], "read", path, NULL);
        perror("exec"); return 3;
    }
    if (!strcmp(operation, "cat")) {
        execl("/bin/cat", "cat", path, NULL);
        perror("cat"); return 3;
    }
    if (!strcmp(operation, "nested")) {
        execl("/bin/sh", "sh", "-c", "exec /bin/sh -c '/bin/cat \"$1\"' sh \"$1\"", "sh", path, NULL);
        perror("nested"); return 3;
    }
    if (!strcmp(operation, "raw-write")) {
        int fd = raw_open(path, O_WRONLY | O_TRUNC);
        if (fd < 0) { perror("raw write open"); return 4; }
        const char *marker = "RAW-WROTE-SOURCE";
        if (write(fd, marker, strlen(marker)) != (ssize_t)strlen(marker)) return 5;
        close(fd);
        return 0;
    }
    if (!strcmp(operation, "nested-write")) {
        execl("/bin/sh", "sh", "-c", "exec /bin/sh -c 'printf CHILD-WROTE-SOURCE > \"$1\"' sh \"$1\"", "sh", path, NULL);
        perror("nested write"); return 3;
    }
    int fd;
    if (!strcmp(operation, "write")) {
        if (argc < 4) return 2;
        fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0) { perror("write open"); return 4; }
        size_t size = strlen(argv[3]);
        if (write(fd, argv[3], size) != (ssize_t)size) return 5;
        close(fd);
        // Keep both workers alive together before reading back the same path.
        usleep(100000);
    }
    fd = !strcmp(operation, "raw") ? raw_open(path, O_RDONLY) : open(path, O_RDONLY);
    if (fd < 0) { perror("read open"); return 4; }
    char buffer[4096];
    ssize_t count;
    while ((count = read(fd, buffer, sizeof(buffer))) > 0) {
        if (write(STDOUT_FILENO, buffer, count) != count) return 5;
    }
    close(fd);
    return count < 0 ? 6 : 0;
}

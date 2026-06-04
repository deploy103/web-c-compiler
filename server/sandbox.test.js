import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const dockerAvailable = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
  encoding: "utf8",
  timeout: 3000
}).status === 0;

test("server GCC sandbox passes stdin to scanf", { skip: !dockerAvailable }, () => {
  const result = compileAndRun(
    `#include <stdio.h>
int main(void) {
    int a, b;
    if (scanf("%d %d", &a, &b) != 2) {
        puts("input fail");
        return 0;
    }
    printf("%d\\n", a + b);
    return 0;
}`,
    "10 32\n"
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "42\n");
});

test("server GCC sandbox runs pointer-heavy code", { skip: !dockerAvailable }, () => {
  const result = compileAndRun(
    `#include <stdio.h>
#include <stdlib.h>
typedef struct Node {
    int value;
    struct Node *next;
} Node;
int main(void) {
    Node *head = malloc(sizeof(Node));
    Node *tail = malloc(sizeof(Node));
    head->value = 21;
    head->next = tail;
    tail->value = 21;
    tail->next = 0;
    printf("%d\\n", head->value + head->next->value);
    free(tail);
    free(head);
    return 0;
}`,
    ""
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "42\n");
});

test("server GCC sandbox can dynamically load libc.so.6", { skip: !dockerAvailable }, () => {
  const result = compileAndRun(
    `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
int main(void) {
    void *libc = dlopen("libc.so.6", RTLD_LAZY);
    if (!libc) {
        puts(dlerror());
        return 2;
    }
    int (*puts_fn)(const char *) = dlsym(libc, "puts");
    if (!puts_fn) {
        puts(dlerror());
        return 3;
    }
    puts_fn("libc-ok");
    dlclose(libc);
    return 0;
}`,
    ""
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "libc-ok\n");
});

function compileAndRun(code, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-c-sandbox-test-"));
  fs.chmodSync(dir, 0o777);
  try {
    fs.writeFileSync(path.join(dir, "main.c"), code);
    const compile = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--ipc",
        "none",
        "--cpus",
        "0.5",
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--pids-limit",
        "96",
        "--ulimit",
        "core=0:0",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65534:65534",
        "--workdir",
        "/work",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
        "-v",
        `${dir}:/work:rw`,
        "gcc:13-bookworm",
        "gcc",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-O0",
        "-pipe",
        "-fno-diagnostics-color",
        "-o",
        "/work/main",
        "/work/main.c",
        "-lm",
        "-ldl",
        "-pthread"
      ],
      { encoding: "utf8", timeout: 9000 }
    );
    assert.equal(compile.status, 0, compile.stderr);
    return spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--ipc",
        "none",
        "--cpus",
        "0.5",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--pids-limit",
        "32",
        "--ulimit",
        "core=0:0",
        "--ulimit",
        "fsize=1048576:1048576",
        "--ulimit",
        "nofile=64:64",
        "--ulimit",
        "nproc=32:32",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "65534:65534",
        "--workdir",
        "/work",
        "-i",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=4m,mode=1777",
        "-v",
        `${dir}:/work:ro`,
        "gcc:13-bookworm",
        "/work/main"
      ],
      { input, encoding: "utf8", timeout: 9000 }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

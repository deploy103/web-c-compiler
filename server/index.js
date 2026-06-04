import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import express from "express";
import helmet from "helmet";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const runsDir = path.join(rootDir, ".runs");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "gcc:13-bookworm";
const MAX_CODE_BYTES = Number(process.env.MAX_CODE_BYTES || 80 * 1024);
const MAX_STDIN_BYTES = Number(process.env.MAX_STDIN_BYTES || 16 * 1024);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES || 24 * 1024);
const DOCKER_TIMEOUT_MS = Number(process.env.DOCKER_TIMEOUT_MS || 9000);
const RUN_TIMEOUT_SECONDS = Number(process.env.RUN_TIMEOUT_SECONDS || 2);
const COMPILE_MEMORY = process.env.COMPILE_MEMORY || "256m";
const RUN_MEMORY = process.env.RUN_MEMORY || "128m";
const COMPILE_PIDS_LIMIT = process.env.COMPILE_PIDS_LIMIT || "96";
const RUN_PIDS_LIMIT = process.env.RUN_PIDS_LIMIT || "32";
const DEFAULT_COMPILER = "gcc";
const ENABLE_LOCAL_GCC_FALLBACK = process.env.ALLOW_LOCAL_GCC === "1";

const STANDARD_FLAGS = new Map([
  ["c11", "c11"],
  ["c17", "c17"],
  ["c2x", "c2x"]
]);

const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(express.json({ limit: "128kb" }));

const rateBuckets = new Map();
app.use((req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > 40) {
    return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
  }
  next();
});

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 60_000).unref();

app.get("/api/health", async (_req, res) => {
  const docker = getDockerStatus();
  res.json({
    ok: true,
    runner: docker.available ? "docker" : ENABLE_LOCAL_GCC_FALLBACK ? "local-gcc-compile-only" : "docker-required",
    compiler: DEFAULT_COMPILER,
    compilers: ["gcc"],
    docker,
    limits: {
      maxCodeBytes: MAX_CODE_BYTES,
      maxStdinBytes: MAX_STDIN_BYTES,
      runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      compileMemory: COMPILE_MEMORY,
      runMemory: RUN_MEMORY
    }
  });
});

app.post("/api/compile", async (req, res) => {
  const startedAt = Date.now();
  const payload = req.body || {};
  const code = String(payload.code ?? "");
  const stdin = String(payload.stdin ?? "");
  const mode = payload.mode === "compile" ? "compile" : "run";
  const standard = STANDARD_FLAGS.get(payload.standard) || "c11";

  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return res.status(413).json({ error: `코드가 너무 큽니다. 최대 ${MAX_CODE_BYTES} bytes입니다.` });
  }
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) {
    return res.status(413).json({ error: `표준 입력이 너무 큽니다. 최대 ${MAX_STDIN_BYTES} bytes입니다.` });
  }
  if (!code.trim()) {
    return res.status(400).json({ error: "컴파일할 C 코드를 입력하세요." });
  }

  let workDir;
  try {
    await fs.mkdir(runsDir, { recursive: true });
    workDir = await fs.mkdtemp(path.join(runsDir, "job-"));
    await fs.writeFile(path.join(workDir, "main.c"), code, { mode: 0o644 });
    await fs.writeFile(path.join(workDir, "input.txt"), stdin, { mode: 0o644 });
    await fs.chmod(workDir, 0o777);

    const docker = getDockerStatus();
    if (docker.available) {
      const result = await runInDocker({ dockerBin: docker.bin, workDir, mode, standard, stdin });
      return res.status(result.exitCode === 0 ? 200 : 200).json({
        ok: result.exitCode === 0,
        runner: "docker",
        compiler: DEFAULT_COMPILER,
        mode,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(result.stderr),
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt
      });
    }

    if (ENABLE_LOCAL_GCC_FALLBACK && mode === "compile") {
      const result = await compileWithLocalGcc({ workDir, standard });
      return res.status(200).json({
        ok: result.exitCode === 0,
        runner: "local-gcc-compile-only",
        mode,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(`${result.stderr}\n\n주의: Docker가 없어 로컬 GCC 컴파일 전용 모드로 실행했습니다.`.trim()),
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt
      });
    }

    return res.status(503).json({
      ok: false,
      runner: "docker-required",
      error:
        "Docker Desktop 데몬이 꺼져 있어 컴파일/실행을 시작하지 않았습니다. Docker Desktop을 켠 뒤 다시 시도하세요.",
      docker,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "컴파일 요청 처리 중 서버 오류가 발생했습니다.",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    });
  } finally {
    if (workDir) {
      fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

if (process.env.NODE_ENV === "production") {
  const distDir = path.join(rootDir, "dist");
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    return res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
});

function getDockerStatus() {
  const bin = resolveDockerBin();
  if (!bin) {
    return { available: false, bin: null, error: "docker CLI를 찾을 수 없습니다." };
  }

  const check = spawnSync(bin, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true
  });

  if (check.status === 0 && check.stdout.trim()) {
    return { available: true, bin, serverVersion: check.stdout.trim(), image: RUNNER_IMAGE };
  }

  return {
    available: false,
    bin,
    image: RUNNER_IMAGE,
    error: trimOutput(`${check.stderr || ""}${check.stdout || ""}`.trim() || "Docker 데몬이 응답하지 않습니다.")
  };
}

function resolveDockerBin() {
  const candidates = [
    process.env.DOCKER_BIN,
    "docker",
    "docker.exe",
    "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

async function runInDocker({ dockerBin, workDir, mode, standard, stdin }) {
  const mountPath = toDockerMountPath(dockerBin, workDir);
  const compileName = dockerContainerName("compile", workDir);
  const runName = dockerContainerName("run", workDir);

  const compileResult = await runCommand(
    dockerBin,
    [
      "run",
      "--rm",
      "--name",
      compileName,
      "--pull",
      "never",
      "--network",
      "none",
      "--ipc",
      "none",
      "--cpus",
      "0.5",
      "--memory",
      COMPILE_MEMORY,
      "--memory-swap",
      COMPILE_MEMORY,
      "--pids-limit",
      COMPILE_PIDS_LIMIT,
      "--ulimit",
      "core=0:0",
      "--ulimit",
      "fsize=16777216:16777216",
      "--ulimit",
      "nofile=128:128",
      "--ulimit",
      "nproc=96:96",
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
      "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
      "-v",
      `${mountPath}:/work:rw`,
      RUNNER_IMAGE,
      "gcc",
      `-std=${standard}`,
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
    {
      timeoutMs: DOCKER_TIMEOUT_MS,
      env: minimalEnv(),
      onTimeout: () => cleanupDockerContainer(dockerBin, compileName)
    }
  );

  if (compileResult.exitCode !== 0 || mode === "compile") {
    return compileResult;
  }

  const runResult = await runCompiledBinary({ dockerBin, workDir, mountPath, runName, stdin });
  return runResult;
}

function runCompiledBinary({ dockerBin, workDir, mountPath, runName, stdin }) {
  return runCommand(
    dockerBin,
    [
      "run",
      "--rm",
      "--name",
      runName,
      "--pull",
      "never",
      "--network",
      "none",
      "--ipc",
      "none",
      "--cpus",
      "0.5",
      "--memory",
      RUN_MEMORY,
      "--memory-swap",
      RUN_MEMORY,
      "--pids-limit",
      RUN_PIDS_LIMIT,
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
      `${mountPath}:/work:ro`,
      RUNNER_IMAGE,
      "/work/main"
    ],
    {
      timeoutMs: (RUN_TIMEOUT_SECONDS + 1) * 1000,
      env: minimalEnv(),
      input: stdin,
      onTimeout: () => cleanupDockerContainer(dockerBin, runName)
    }
  );
}

async function compileWithLocalGcc({ workDir, standard }) {
  return runCommand(
    "gcc",
    [
      `-std=${standard}`,
      "-Wall",
      "-Wextra",
      "-O0",
      "-pipe",
      "-fno-diagnostics-color",
      "-fsyntax-only",
      path.join(workDir, "main.c")
    ],
    {
      cwd: workDir,
      timeoutMs: 4000,
      env: minimalEnv()
    }
  );
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: options.env || minimalEnv(),
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof options.onTimeout === "function") {
        Promise.resolve(options.onTimeout()).catch(() => {});
      }
      child.kill("SIGKILL");
    }, options.timeoutMs || 5000);

    child.stdin?.on("error", () => {});
    if (Object.prototype.hasOwnProperty.call(options, "input")) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        signal: null,
        stdout,
        stderr: appendLimited(stderr, error.message),
        timedOut
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function dockerContainerName(kind, workDir) {
  const suffix = path.basename(workDir).replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `web-c-${kind}-${suffix}`.slice(0, 128);
}

function cleanupDockerContainer(dockerBin, name) {
  spawnSync(dockerBin, ["rm", "-f", name], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
    env: minimalEnv()
  });
}

function toDockerMountPath(dockerBin, hostPath) {
  if (path.basename(dockerBin).toLowerCase() !== "docker.exe") return hostPath;

  const converted = spawnSync("wslpath", ["-w", hostPath], {
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true
  });
  return converted.status === 0 && converted.stdout.trim() ? converted.stdout.trim() : hostPath;
}

function minimalEnv() {
  return {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    LC_ALL: "C.UTF-8"
  };
}

function appendLimited(current, next) {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_OUTPUT_BYTES) return combined;
  return combined.slice(0, MAX_OUTPUT_BYTES) + "\n...[output truncated]";
}

function trimOutput(value) {
  if (!value) return "";
  return appendLimited("", value);
}

import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Activity,
  FileCode2,
  Hammer,
  Play,
  RefreshCcw,
  Send,
  Shield,
  Square,
  Terminal,
  XCircle
} from "lucide-react";

const starterCode = `#include <stdio.h>

int main(void) {
    int a, b;

    printf("두 정수를 입력하세요: ");
    if (scanf("%d %d", &a, &b) != 2) {
        puts("입력이 올바르지 않습니다.");
        return 0;
    }

    printf("%d\\n", a + b);
    return 0;
}
`;

const examples = {
  sum: starterCode,
  loop: `#include <stdio.h>

int main(void) {
    for (int i = 1; i <= 5; i++) {
        printf("%d\\n", i * i);
    }
    return 0;
}
`,
  string: `#include <stdio.h>

int main(void) {
    char name[64];

    printf("이름을 입력하세요: ");
    if (scanf("%63s", name) == 1) {
        printf("Hello, %s!\\n", name);
    }

    return 0;
}
`,
  fuel: `#include <stdio.h>

int main(void) {
    int type;
    float distance, kpl = 0, fuel = 0, total;

    while (1) {
        printf("차 종류를 선택하세요.(프로그램을 종료하려면 0을 입력하세요.)\\n");
        printf("  1. 전기차, 2. 휘발유차, 3. LPG\\n");

        if (scanf("%d", &type) != 1) {
            puts("\\n입력이 끝나 프로그램을 종료합니다.");
            break;
        }
        if (type == 0) {
            puts("프로그램을 종료합니다.");
            break;
        }

        printf("목적지까지 거리를 입력하세요.(km): ");
        if (scanf("%f", &distance) != 1) {
            puts("\\n거리가 입력되지 않아 프로그램을 종료합니다.");
            break;
        }

        switch (type) {
            case 1: kpl = 6; fuel = 220; break;
            case 2: kpl = 16; fuel = 1650; break;
            case 3: kpl = 10; fuel = 850; break;
            default:
                puts("지원하지 않는 차종입니다.");
                continue;
        }

        total = fuel * distance / kpl;
        printf("해당 차종의 예상 충전 비용은 %.0f원입니다.\\n\\n", total);
    }

    return 0;
}
`
};

const runStateLabels = {
  idle: "대기",
  connecting: "연결 중",
  compiling: "컴파일 중",
  running: "실행 중",
  finished: "완료"
};

const MAX_CONSOLE_CHARS = 24 * 1024;

function App() {
  const [code, setCode] = useState(starterCode);
  const [standard, setStandard] = useState("c11");
  const [compiler, setCompiler] = useState("gcc");
  const [health, setHealth] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selectedExample, setSelectedExample] = useState("sum");
  const [runState, setRunState] = useState("idle");
  const [consoleEntries, setConsoleEntries] = useState([]);
  const [consoleInput, setConsoleInput] = useState("");
  const wsRef = useRef(null);
  const consoleInputRef = useRef(null);
  const consoleEndRef = useRef(null);

  useEffect(() => {
    refreshHealth();
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ block: "end" });
  }, [consoleEntries]);

  const status = useMemo(() => {
    if (!health) return { label: "확인 중", kind: "pending", icon: Activity };
    if (health.docker?.available) return { label: "Docker 격리 준비됨", kind: "ready", icon: Shield };
    return { label: "Docker 필요", kind: "blocked", icon: XCircle };
  }, [health]);

  async function refreshHealth() {
    try {
      const response = await fetch("/api/health");
      setHealth(await response.json());
    } catch {
      setHealth({ ok: false, docker: { available: false, error: "API 서버에 연결할 수 없습니다." } });
    }
  }

  async function submitCompile() {
    if (busy) return;

    setBusy(true);
    setRunState("compiling");
    setResult(null);
    resetConsole("컴파일 중...\n");

    try {
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, stdin: "", mode: "compile", standard, compiler })
      });
      const body = await response.json();
      setResult({ ...body, httpStatus: response.status });
      setConsoleEntries(entriesFromHttpResult(body));
    } catch (error) {
      const message = error.message || "요청 실패";
      setResult({ ok: false, error: message });
      setConsoleEntries([{ kind: "error", text: `${message}\n` }]);
    } finally {
      setBusy(false);
      setRunState("finished");
      refreshHealth();
    }
  }

  function runInteractive() {
    if (busy) return;

    let finished = false;
    wsRef.current?.close();
    setBusy(true);
    setRunState("connecting");
    setResult(null);
    setConsoleInput("");
    resetConsole("콘솔을 연결하는 중입니다.\n");

    const ws = new WebSocket(interactiveSocketUrl());
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      appendConsole("system", "컴파일을 시작합니다.\n");
      setRunState("compiling");
      ws.send(JSON.stringify({ type: "start", code, standard, compiler }));
    });

    ws.addEventListener("message", (event) => {
      const message = parseSocketMessage(event.data);
      if (!message) return;

      if (message.type === "state") {
        if (message.state === "compiling") setRunState("compiling");
        if (message.state === "running") {
          setRunState("running");
          appendConsole("system", "실행 중입니다. 아래 입력칸에서 값을 입력하고 Enter를 누르세요.\n");
          requestAnimationFrame(() => consoleInputRef.current?.focus());
        }
        return;
      }

      if (message.type === "compile") {
        if (message.ok) {
          appendConsole("system", "컴파일 성공.\n");
        } else {
          appendConsole("error", "컴파일 실패.\n");
        }
        appendConsole("stdout", message.stdout || "");
        appendConsole("stderr", message.stderr || "");
        return;
      }

      if (message.type === "stdout" || message.type === "stderr" || message.type === "system") {
        appendConsole(message.type, message.data || "");
        return;
      }

      if (message.type === "error") {
        appendConsole("error", `${message.message || "실행 오류"}\n`);
        return;
      }

      if (message.type === "done") {
        finished = true;
        setBusy(false);
        setRunState("finished");
        setResult(message);
        appendConsole("meta", doneMessage(message));
        ws.close();
        refreshHealth();
      }
    });

    ws.addEventListener("error", () => {
      appendConsole("error", "콘솔 연결 중 오류가 발생했습니다.\n");
    });

    ws.addEventListener("close", () => {
      if (!finished) {
        setBusy(false);
        setRunState("finished");
        appendConsole("error", "콘솔 연결이 종료되었습니다.\n");
        refreshHealth();
      }
    });
  }

  function sendConsoleInput() {
    if (runState !== "running" || wsRef.current?.readyState !== WebSocket.OPEN) return;
    if (consoleInput.length === 0) return;

    const data = consoleInput.endsWith("\n") ? consoleInput : `${consoleInput}\n`;
    wsRef.current.send(JSON.stringify({ type: "stdin", data }));
    appendConsole("stdin", data);
    setConsoleInput("");
  }

  function stopInteractive() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
  }

  function loadExample(key) {
    setSelectedExample(key);
    setCode(examples[key]);
    setConsoleInput("");
    setConsoleEntries([]);
    setResult(null);
    setRunState("idle");
  }

  function resetConsole(text) {
    setConsoleEntries([{ kind: "system", text }]);
  }

  function appendConsole(kind, text) {
    if (!text) return;
    setConsoleEntries((entries) => trimConsoleEntries([...entries, { kind, text }]));
  }

  const StatusIcon = status.icon;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <FileCode2 size={20} aria-hidden="true" />
          <span>Web C Compiler</span>
        </div>
        <div className={`runner-status ${status.kind}`}>
          <StatusIcon size={16} aria-hidden="true" />
          <span>{status.label}</span>
        </div>
        <button className="icon-button" type="button" onClick={refreshHealth} aria-label="상태 새로고침">
          <RefreshCcw size={17} aria-hidden="true" />
        </button>
      </header>

      <main className="workspace">
        <section className="editor-pane" aria-label="C 코드 편집기">
          <div className="toolbar">
            <div className="control-group">
              <label htmlFor="compiler">컴파일러</label>
              <select id="compiler" value={compiler} onChange={(event) => setCompiler(event.target.value)}>
                <option value="gcc">Server GCC</option>
              </select>
            </div>
            <div className="control-group">
              <label htmlFor="standard">표준</label>
              <select id="standard" value={standard} onChange={(event) => setStandard(event.target.value)}>
                <option value="c11">C11</option>
                <option value="c17">C17</option>
                <option value="c2x">C23</option>
              </select>
            </div>
            <div className="control-group">
              <label htmlFor="example">예제</label>
              <select id="example" value={selectedExample} onChange={(event) => loadExample(event.target.value)}>
                <option value="sum">덧셈</option>
                <option value="loop">반복문</option>
                <option value="string">문자열</option>
                <option value="fuel">차량 비용</option>
              </select>
            </div>
            <div className="toolbar-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={submitCompile}>
                <Hammer size={16} aria-hidden="true" />
                <span>컴파일</span>
              </button>
              <button className="primary-button" type="button" disabled={busy} onClick={runInteractive}>
                <Play size={16} aria-hidden="true" />
                <span>실행</span>
              </button>
            </div>
          </div>
          <div className="editor-wrap">
            <Editor
              language="c"
              theme="vs-dark"
              value={code}
              onChange={(value) => setCode(value || "")}
              options={{
                automaticLayout: true,
                fontSize: 14,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                tabSize: 4,
                wordWrap: "on",
                renderLineHighlight: "all",
                padding: { top: 12, bottom: 12 }
              }}
            />
          </div>
          <div className="statusbar">
            <span>{byteLength(code)} bytes</span>
            <span>{code.split("\n").length} lines</span>
            <span>GCC {health?.docker?.available ? health.docker.image : "대기"}</span>
          </div>
        </section>

        <aside className="side-pane">
          <section className="console-panel" aria-label="콘솔">
            <div className="panel-title">
              <Terminal size={16} aria-hidden="true" />
              <span>콘솔</span>
              <div className="panel-meta">
                <span className={`run-state ${runState}`}>{runStateLabels[runState]}</span>
                {result?.durationMs != null && <span className="duration">{result.durationMs} ms</span>}
              </div>
            </div>

            <pre className="console-output" role="log" aria-live="polite">
              {consoleEntries.length === 0 ? (
                <span className="console-muted">실행 버튼을 누르면 출력이 여기에 표시됩니다.</span>
              ) : (
                consoleEntries.map((entry, index) => (
                  <span className={`console-${entry.kind}`} key={`${index}-${entry.kind}`}>
                    {entry.text}
                  </span>
                ))
              )}
              <span ref={consoleEndRef} />
            </pre>

            <div className="console-input-row">
              <textarea
                ref={consoleInputRef}
                className="console-input"
                value={consoleInput}
                onChange={(event) => setConsoleInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendConsoleInput();
                  }
                }}
                disabled={runState !== "running"}
                rows={1}
                spellCheck="false"
                aria-label="콘솔 입력"
                placeholder={runState === "running" ? "값 입력 후 Enter" : "실행 중 여기에 입력"}
              />
              <button
                className="icon-button"
                type="button"
                disabled={runState !== "running" || consoleInput.length === 0}
                onClick={sendConsoleInput}
                aria-label="콘솔 입력 보내기"
                title="입력 보내기"
              >
                <Send size={16} aria-hidden="true" />
              </button>
              <button
                className="icon-button"
                type="button"
                disabled={!busy}
                onClick={stopInteractive}
                aria-label="실행 중지"
                title="실행 중지"
              >
                <Square size={15} aria-hidden="true" />
              </button>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function entriesFromHttpResult(result) {
  if (result.error) {
    return [{ kind: "error", text: `${result.error}\n` }];
  }

  const meta = [
    `runner: ${result.runner}`,
    `compiler: ${result.compiler || "n/a"}`,
    `exit: ${result.exitCode ?? "n/a"}`,
    result.timedOut ? "timeout: yes" : null
  ]
    .filter(Boolean)
    .join(" | ");

  return [
    { kind: result.ok ? "system" : "error", text: result.ok ? "컴파일 성공.\n" : "컴파일 실패.\n" },
    { kind: "meta", text: `${meta}\n` },
    { kind: "stdout", text: result.stdout || "" },
    { kind: "stderr", text: result.stderr || "" }
  ].filter((entry) => entry.text);
}

function doneMessage(message) {
  const duration = message.durationMs != null ? ` (${message.durationMs} ms)` : "";
  if (message.stopped) return `\n[사용자가 실행을 중지했습니다${duration}]\n`;
  if (message.timedOut) return `\n[시간 초과로 종료되었습니다${duration}]\n`;
  if (message.exitCode === 0) return `\n[프로그램이 종료되었습니다${duration}]\n`;
  return `\n[프로그램이 종료되었습니다: exit ${message.exitCode ?? "n/a"}${duration}]\n`;
}

function parseSocketMessage(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function interactiveSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/run/interactive`;
}

function trimConsoleEntries(entries) {
  let total = 0;
  const kept = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const nextTotal = total + entry.text.length;
    if (nextTotal > MAX_CONSOLE_CHARS) {
      const remaining = MAX_CONSOLE_CHARS - total;
      if (remaining > 0) {
        kept.push({ ...entry, text: entry.text.slice(-remaining) });
      }
      break;
    }
    total = nextTotal;
    kept.push(entry);
  }

  return kept.reverse();
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

export default App;

import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Activity,
  CheckCircle2,
  FileCode2,
  Hammer,
  Play,
  RefreshCcw,
  Shield,
  Terminal,
  XCircle
} from "lucide-react";

const starterCode = `#include <stdio.h>

int main(void) {
    int a, b;

    if (scanf("%d %d", &a, &b) != 2) {
        puts("두 정수를 입력하세요.");
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

    if (scanf("%63s", name) == 1) {
        printf("Hello, %s!\\n", name);
    }

    return 0;
}
`
};

function App() {
  const [code, setCode] = useState(starterCode);
  const [stdin, setStdin] = useState("");
  const [standard, setStandard] = useState("c11");
  const [compiler, setCompiler] = useState("gcc");
  const [health, setHealth] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selectedExample, setSelectedExample] = useState("sum");
  const stdinRef = useRef(null);

  useEffect(() => {
    refreshHealth();
  }, []);

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

  async function submit(mode) {
    if (mode === "run" && usesScanf(code) && stdin.length === 0) {
      setResult({ ok: false, error: "scanf 입력이 필요합니다. stdin 칸에 값을 직접 입력한 뒤 실행하세요." });
      stdinRef.current?.focus();
      return;
    }

    setBusy(true);
    setResult(null);

    try {
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, stdin, mode, standard, compiler })
      });
      const body = await response.json();
      setResult({ ...body, httpStatus: response.status });
    } catch (error) {
      setResult({ ok: false, error: error.message || "요청 실패" });
    } finally {
      setBusy(false);
      refreshHealth();
    }
  }

  function loadExample(key) {
    setSelectedExample(key);
    setCode(examples[key]);
    setStdin("");
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
              </select>
            </div>
            <div className="toolbar-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => submit("compile")}>
                <Hammer size={16} aria-hidden="true" />
                <span>컴파일</span>
              </button>
              <button className="primary-button" type="button" disabled={busy} onClick={() => submit("run")}>
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
          <section className="stdin-panel" aria-label="표준 입력">
            <div className="panel-title">
              <Terminal size={16} aria-hidden="true" />
              <span>stdin</span>
            </div>
            <textarea
              ref={stdinRef}
              value={stdin}
              onChange={(event) => setStdin(event.target.value)}
              placeholder="scanf 입력값을 여기에 직접 입력하세요."
              spellCheck="false"
              aria-label="표준 입력"
            />
          </section>

          <section className="output-panel" aria-label="결과">
            <div className="panel-title">
              {result?.ok ? <CheckCircle2 size={16} aria-hidden="true" /> : <Terminal size={16} aria-hidden="true" />}
              <span>결과</span>
              {busy && <span className="busy-dot">실행 중</span>}
              {result?.durationMs != null && <span className="duration">{result.durationMs} ms</span>}
            </div>
            <Output result={result} health={health} />
          </section>
        </aside>
      </main>
    </div>
  );
}

function Output({ result, health }) {
  if (!result) {
    return (
      <div className="empty-output">
        <span>{health?.docker?.error || "컴파일 또는 실행 결과가 여기에 표시됩니다."}</span>
      </div>
    );
  }

  if (result.error) {
    return <pre className="output error">{result.error}</pre>;
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const meta = [
    `runner: ${result.runner}`,
    `compiler: ${result.compiler || "n/a"}`,
    `exit: ${result.exitCode ?? "n/a"}`,
    result.timedOut ? "timeout: yes" : null
  ]
    .filter(Boolean)
    .join(" | ");

  return (
    <div className="output-stack">
      <div className={`result-chip ${result.ok ? "ok" : "fail"}`}>{result.ok ? "성공" : "실패"}</div>
      <pre className="output meta">{meta}</pre>
      <pre className="output">{stdout || "(stdout 없음)"}</pre>
      {stderr && <pre className="output stderr">{stderr}</pre>}
    </div>
  );
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function usesScanf(value) {
  return /\bscanf\s*\(/.test(value);
}

export default App;

# Web C Compiler

React/Vite 프론트엔드와 Express API로 만든 로컬 웹 C 컴파일러입니다. 편집기는 Monaco Editor를 사용하고, C 컴파일/실행은 Docker 컨테이너 안에서 수행하도록 설계했습니다.

## 실행

```bash
npm install
npm run dev
```

프론트엔드: http://localhost:5173  
API: http://127.0.0.1:8787

## 보안 모델

- Docker 실행 시 `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`를 적용합니다.
- 호스트 작업 디렉터리는 컨테이너에 읽기 전용으로만 마운트합니다.
- 실행 시간, 메모리, CPU, 프로세스 수, 입력 크기, 출력 크기를 제한합니다.
- 사용자 코드는 로그로 남기지 않고 요청마다 임시 디렉터리를 삭제합니다.
- Docker 데몬이 꺼져 있으면 기본적으로 컴파일/실행을 거부합니다.

완전한 무사고를 보장할 수는 없습니다. 공개 서비스로 운영하려면 별도 격리 서버, 계정 분리, seccomp/AppArmor 정책, 감사 로그, 모니터링, 네트워크 egress 통제가 필요합니다.

## Docker 없는 컴파일 전용 fallback

위험을 이해하고 로컬에서 문법 검사만 허용하려면 다음처럼 실행할 수 있습니다.

```bash
ALLOW_LOCAL_GCC=1 npm run dev
```

이 모드는 실행을 제공하지 않으며, 공개 서비스에 권장하지 않습니다.

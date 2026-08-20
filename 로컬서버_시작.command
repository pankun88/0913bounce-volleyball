#!/bin/bash
# 바운스발리볼 로컬 서버 시작
# 이 파일을 더블클릭하면 admin.html을 안전한 방식(http://localhost)으로 열어줍니다.
# (파일을 더블클릭해서 직접 여는 방식은 일부 브라우저에서 페이지가 멈춘 것처럼 보이는
#  원인이 될 수 있어, 이 스크립트를 통해 여는 것을 권장합니다.)
#
# 이 서버는 모든 응답에 "캐시하지 말 것" 헤더를 붙입니다.
# (admin.js/firestore-service.js 등을 수정해도 브라우저가 예전 버전을 계속 보여주는
#  문제를 막기 위함 — 문제해결기록.md 5/6번 참고)

cd "$(dirname "$0")"

PORT=8765
URL="http://localhost:$PORT/admin.html?t=$(date +%s)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 을 찾을 수 없습니다. macOS에 기본 내장되어 있어야 하니,"
  echo "이 메시지가 보이면 화면 안내를 따라 'Xcode 명령줄 도구' 설치를 진행해주세요."
  read -p "엔터를 누르면 창이 닫힙니다..."
  exit 1
fi

echo "바운스발리볼 로컬 서버를 시작합니다 (포트 $PORT)."
echo "잠시 후 브라우저에서 관리자 페이지가 자동으로 열립니다."
echo "사용을 마치면 이 창을 닫아 서버를 종료하세요."
echo ""

( sleep 1 && open "$URL" ) &

python3 -c "
import http.server
import socketserver

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

with ReusableTCPServer(('', $PORT), NoCacheHandler) as httpd:
    httpd.serve_forever()
"

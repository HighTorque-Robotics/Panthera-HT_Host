#!/usr/bin/env bash
set -Eeuo pipefail

ENV_NAME="${PANTHERA_ENV_NAME:-panthera}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="${ROOT_DIR}/Panthera_digital_twin-main/frontend"
HOST="0.0.0.0"
PORT="3000"

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

detect_conda() {
  if command -v conda >/dev/null 2>&1; then
    return 0
  fi

  local candidates=(
    "${HOME}/miniconda3/etc/profile.d/conda.sh"
    "${HOME}/anaconda3/etc/profile.d/conda.sh"
    "/opt/conda/etc/profile.d/conda.sh"
  )

  local conda_sh
  for conda_sh in "${candidates[@]}"; do
    if [[ -f "${conda_sh}" ]]; then
      # shellcheck source=/dev/null
      source "${conda_sh}"
      command -v conda >/dev/null 2>&1 && return 0
    fi
  done

  return 1
}

usage() {
  cat <<EOF
Usage:
  ./frontend.sh [--host HOST] [--port PORT]

Options:
  --host HOST      Vite listen host. Default: ${HOST}
  --port PORT      Vite listen port. Default: ${PORT}
  -h, --help       Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || fail "--host 需要一个参数。"
      HOST="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || fail "--port 需要一个端口参数。"
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1。运行 ./frontend.sh --help 查看用法。"
      ;;
  esac
done

[[ -d "${FRONTEND_DIR}" ]] || fail "找不到前端目录：${FRONTEND_DIR}"
detect_conda || fail "未检测到 conda。请先运行 ./install.sh 安装环境。"

if ! conda env list | awk '{print $1}' | grep -qx "${ENV_NAME}"; then
  fail "未找到 Conda 环境 ${ENV_NAME}。请先运行 ./install.sh。"
fi

if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
  fail "前端依赖未安装。请先运行 ./install.sh。"
fi

cd "${FRONTEND_DIR}"

echo "Starting Panthera frontend on http://localhost:${PORT}"
exec conda run --no-capture-output -n "${ENV_NAME}" npm run dev -- --host "${HOST}" --port "${PORT}"

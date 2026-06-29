#!/usr/bin/env bash
set -Eeuo pipefail

ENV_NAME="${PANTHERA_ENV_NAME:-panthera}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/Panthera_digital_twin-main/backend"
DEFAULT_CONFIG="../../panthera_python/robot_param/Follower.yaml"
MODE="live"
PORT="5000"
CONFIG="${DEFAULT_CONFIG}"

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
  ./backend.sh [--demo|--live] [--config PATH] [--port PORT]

Options:
  --demo           Start without robot hardware.
  --live           Start with real robot hardware. Default.
  --config PATH    Robot YAML config for live mode. Default: ${DEFAULT_CONFIG}
  --port PORT      Backend port. Default: ${PORT}
  -h, --help       Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --demo)
      MODE="demo"
      shift
      ;;
    --live)
      MODE="live"
      shift
      ;;
    --config)
      [[ $# -ge 2 ]] || fail "--config 需要一个路径参数。"
      CONFIG="$2"
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
      fail "未知参数：$1。运行 ./backend.sh --help 查看用法。"
      ;;
  esac
done

[[ -d "${BACKEND_DIR}" ]] || fail "找不到后端目录：${BACKEND_DIR}"
detect_conda || fail "未检测到 conda。请先运行 ./install.sh 安装环境。"

if ! conda env list | awk '{print $1}' | grep -qx "${ENV_NAME}"; then
  fail "未找到 Conda 环境 ${ENV_NAME}。请先运行 ./install.sh。"
fi

cd "${BACKEND_DIR}"

if [[ "${MODE}" == "demo" ]]; then
  echo "Starting Panthera backend in DEMO mode on http://localhost:${PORT}"
  exec conda run --no-capture-output -n "${ENV_NAME}" python app.py --demo --port "${PORT}"
fi

echo "Starting Panthera backend in LIVE mode on http://localhost:${PORT}"
echo "Config: ${CONFIG}"
exec conda run --no-capture-output -n "${ENV_NAME}" python app.py --config "${CONFIG}" --port "${PORT}"

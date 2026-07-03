#!/usr/bin/env bash
set -Eeuo pipefail

ENV_NAME="${PANTHERA_ENV_NAME:-panthera}"
INSTALL_SYSTEM_DEPS="${INSTALL_SYSTEM_DEPS:-1}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIGITAL_TWIN_DIR="${ROOT_DIR}/Panthera_digital_twin-main"
FRONTEND_DIR="${DIGITAL_TWIN_DIR}/frontend"
BACKEND_DIR="${DIGITAL_TWIN_DIR}/backend"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

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

require_ubuntu() {
  if [[ ! -f /etc/os-release ]]; then
    fail "无法识别系统版本。本脚本仅面向 Ubuntu。"
  fi

  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    fail "当前系统是 ${PRETTY_NAME:-unknown}，本脚本仅面向 Ubuntu。"
  fi
}

have_sudo() {
  command -v sudo >/dev/null 2>&1
}

run_sudo() {
  have_sudo || fail "未检测到 sudo，无法安装系统依赖。可设置 INSTALL_SYSTEM_DEPS=0 跳过系统依赖安装。"
  sudo "$@"
}

install_system_dependencies() {
  if [[ "${INSTALL_SYSTEM_DEPS}" != "1" ]]; then
    log "跳过 Ubuntu 系统依赖安装。"
    return
  fi

  log "安装数字孪生所需 Ubuntu 系统依赖。"
  run_sudo apt-get update
  run_sudo apt-get install -y \
    build-essential
}

require_existing_env() {
  if ! conda env list | awk '{print $1}' | grep -qx "${ENV_NAME}"; then
    fail "未找到 Conda 环境 ${ENV_NAME}。请先按 panthera_python/README.md 手动安装 panthera 环境和机械臂 SDK，然后再运行 ./install.sh。"
  fi

  log "检测到已有 Conda 环境 ${ENV_NAME}，将在该环境中安装数字孪生依赖。"
  log "安装数字孪生所需 Conda 侧依赖：nodejs、cmake、pkg-config。"
  conda install -y -n "${ENV_NAME}" -c conda-forge nodejs cmake pkg-config
}

install_python_dependencies() {
  log "升级 pip/setuptools/wheel。"
  conda run -n "${ENV_NAME}" python -m pip install --upgrade pip setuptools wheel

  log "安装数字孪生后端 Python 依赖。"
  conda run -n "${ENV_NAME}" python -m pip install -r "${BACKEND_DIR}/requirements.txt"
}

install_frontend_dependencies() {
  log "安装前端 npm 依赖并构建 dist。"
  (
    cd "${FRONTEND_DIR}"
    conda run -n "${ENV_NAME}" npm install
    conda run -n "${ENV_NAME}" npm run build
  )
}

verify_installation() {
  log "验证 Python 依赖。"
  conda run -n "${ENV_NAME}" python -c '
import importlib

required = [
    "flask",
    "flask_socketio",
    "flask_cors",
    "socketio",
    "yaml",
    "numpy",
    "scipy",
    "pinocchio",
]

for name in required:
    importlib.import_module(name)
    print(f"OK: {name}")

for name in ["hightorque_robot"]:
    try:
        importlib.import_module(name)
        print(f"OK: {name}")
    except Exception as exc:
        print(f"WARN: {name} 导入失败：{exc}")
        print("      ./install.sh 不安装机械臂 SDK；真机模式请按 panthera_python/README.md 修复 SDK 安装。")
'

  log "验证 Node/npm。"
  conda run -n "${ENV_NAME}" node --version
  conda run -n "${ENV_NAME}" npm --version
}

print_next_steps() {
  cat <<EOF

安装完成。

本脚本只安装数字孪生依赖，不创建 Conda 环境，也不安装机械臂 SDK。
机械臂 SDK 请按 panthera_python/README.md 手动安装。

Conda 环境：

  ${ENV_NAME}

使用方式：

  conda activate ${ENV_NAME}

Demo 后端：

  cd ${BACKEND_DIR}
  python app.py --demo

浏览器打开：

  http://localhost:5000

真机模式：

  cd ${BACKEND_DIR}
  python app.py --config ../robot_param/Follower.yaml

本脚本默认会安装数字孪生所需 Ubuntu 系统依赖。
如果不想改系统依赖，可这样跳过：

  INSTALL_SYSTEM_DEPS=0 ./install.sh

EOF
}

main() {
  require_ubuntu

  if ! detect_conda; then
    fail "未检测到 conda。请先安装 Miniconda 或 Anaconda 后再运行本脚本。"
  fi

  log "检测到 conda：$(conda --version)"
  install_system_dependencies
  require_existing_env
  install_python_dependencies
  install_frontend_dependencies
  verify_installation
  print_next_steps
}

main "$@"

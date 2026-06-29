#!/usr/bin/env bash
set -Eeuo pipefail

ENV_NAME="${PANTHERA_ENV_NAME:-panthera}"
PYTHON_VERSION="3.10"
INSTALL_SYSTEM_DEPS="${INSTALL_SYSTEM_DEPS:-1}"
INSTALL_YAML_CPP_06="${INSTALL_YAML_CPP_06:-0}"
SETUP_UDEV_RULES="${SETUP_UDEV_RULES:-1}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIGITAL_TWIN_DIR="${ROOT_DIR}/Panthera_digital_twin-main"
PANTHERA_PY_DIR="${ROOT_DIR}/panthera_python"
FRONTEND_DIR="${DIGITAL_TWIN_DIR}/frontend"
BACKEND_DIR="${DIGITAL_TWIN_DIR}/backend"
WHEEL_DIR="${PANTHERA_PY_DIR}/motor_whl"
BUILD_DIR="${ROOT_DIR}/.build"

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

  log "安装 Ubuntu 系统依赖。"
  run_sudo apt-get update
  run_sudo apt-get install -y \
    build-essential \
    cmake \
    git \
    libserialport-dev \
    udev

  ensure_yaml_cpp_06
  setup_serial_permissions
}

ensure_yaml_cpp_06() {
  if [[ "${INSTALL_YAML_CPP_06}" != "1" ]]; then
    log "跳过 yaml-cpp 0.6.1 安装。"
    return
  fi

  if ldconfig -p 2>/dev/null | grep -q 'libyaml-cpp\.so\.0\.6'; then
    log "检测到 libyaml-cpp.so.0.6，跳过 yaml-cpp 源码安装。"
    return
  fi

  log "未检测到 libyaml-cpp.so.0.6，源码安装 yaml-cpp 0.6.1。"
  mkdir -p "${BUILD_DIR}"

  if [[ ! -d "${BUILD_DIR}/yaml-cpp/.git" ]]; then
    git clone https://github.com/jbeder/yaml-cpp.git "${BUILD_DIR}/yaml-cpp"
  fi

  (
    cd "${BUILD_DIR}/yaml-cpp"
    git fetch --tags
    git checkout yaml-cpp-0.6.1
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON
    cmake --build build -j"$(nproc)"
    run_sudo cmake --install build
  )

  run_sudo ldconfig
}

setup_serial_permissions() {
  if [[ "${SETUP_UDEV_RULES}" != "1" ]]; then
    log "跳过串口 udev 权限配置。"
    return
  fi

  log "配置 ttyACM 串口权限 udev 规则。"
  printf 'KERNEL=="ttyACM*", MODE="0777"\n' | run_sudo tee /etc/udev/rules.d/99-panthera.rules >/dev/null
  run_sudo udevadm control --reload-rules
  run_sudo udevadm trigger || true

  if compgen -G "/dev/ttyACM*" >/dev/null; then
    run_sudo chmod -R 777 /dev/ttyACM* || true
  else
    log "当前未检测到 /dev/ttyACM* 设备，已写入 udev 规则，设备重新插入后生效。"
  fi
}

create_or_update_env() {
  if conda env list | awk '{print $1}' | grep -qx "${ENV_NAME}"; then
    log "检测到已有 Conda 环境 ${ENV_NAME}，将在该环境中安装/更新依赖。"
  else
    log "创建 Conda 环境 ${ENV_NAME}，Python ${PYTHON_VERSION}。"
    conda create -y -n "${ENV_NAME}" "python=${PYTHON_VERSION}" pip
  fi

  log "安装 Conda 侧依赖：nodejs、cmake、pkg-config。"
  conda install -y -n "${ENV_NAME}" -c conda-forge nodejs cmake pkg-config
}

python_cp_tag() {
  conda run -n "${ENV_NAME}" python -c 'import sys; print(f"cp{sys.version_info.major}{sys.version_info.minor}-cp{sys.version_info.major}{sys.version_info.minor}")'
}

install_python_dependencies() {
  log "升级 pip/setuptools/wheel。"
  conda run -n "${ENV_NAME}" python -m pip install --upgrade pip setuptools wheel

  log "安装数字孪生后端 Python 依赖。"
  conda run -n "${ENV_NAME}" python -m pip install -r "${BACKEND_DIR}/requirements.txt"

  log "安装 Panthera 高层库 Python 依赖。"
  conda run -n "${ENV_NAME}" python -m pip install -r "${PANTHERA_PY_DIR}/requirements.txt"

  log "安装键盘控制依赖：pynput。"
  conda run -n "${ENV_NAME}" python -m pip install pynput
}

detect_motor_wheel() {
  local arch cp_tag wheel
  arch="$(uname -m)"
  cp_tag="$(python_cp_tag | tail -n 1)"

  case "${arch}" in
    x86_64)
      wheel="${WHEEL_DIR}/hightorque_robot-1.2.0-${cp_tag}-linux_x86_64.whl"
      ;;
    aarch64|arm64)
      wheel="${WHEEL_DIR}/hightorque_robot-1.0.0-${cp_tag}-linux_aarch64.whl"
      ;;
    *)
      fail "不支持的 CPU 架构：${arch}。仓库仅提供 x86_64 和 aarch64 的 hightorque_robot wheel。"
      ;;
  esac

  [[ -f "${wheel}" ]] || fail "未找到匹配 Python ${cp_tag} / 架构 ${arch} 的电机 SDK wheel：${wheel}"
  printf '%s\n' "${wheel}"
}

install_motor_sdk() {
  local wheel
  wheel="$(detect_motor_wheel)"
  log "安装电机 SDK：$(basename "${wheel}")。"
  conda run -n "${ENV_NAME}" python -m pip install --force-reinstall "${wheel}"
}

install_frontend_dependencies() {
  log "安装前端 npm 依赖。"
  (
    cd "${FRONTEND_DIR}"
    conda run -n "${ENV_NAME}" npm install
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
    "pynput",
]

for name in required:
    importlib.import_module(name)
    print(f"OK: {name}")

try:
    importlib.import_module("hightorque_robot")
    print("OK: hightorque_robot")
except Exception as exc:
    print(f"WARN: hightorque_robot 导入失败：{exc}")
    print("      Demo 模式仍可尝试启动；真机模式需要修复该 SDK 的系统库依赖。")
'

  log "验证 Node/npm。"
  conda run -n "${ENV_NAME}" node --version
  conda run -n "${ENV_NAME}" npm --version
}

print_next_steps() {
  cat <<EOF

安装完成。

Conda 环境：

  ${ENV_NAME}

使用方式：

  conda activate ${ENV_NAME}

Demo 后端：

  cd ${BACKEND_DIR}
  python app.py --demo

前端：

  cd ${FRONTEND_DIR}
  npm run dev

浏览器打开：

  http://localhost:3000

真机模式：

  cd ${BACKEND_DIR}
  python app.py --config ../robot_param/Follower.yaml

本脚本默认会安装 Ubuntu 系统依赖，并写入 ttyACM udev 权限规则。
默认不安装 libyaml-cpp.so.0.6 / yaml-cpp 0.6.1。
如果不想改系统依赖，可这样跳过：

  INSTALL_SYSTEM_DEPS=0 ./install.sh

如需额外安装 yaml-cpp 0.6.1，或单独跳过 udev：

  INSTALL_YAML_CPP_06=1 ./install.sh
  SETUP_UDEV_RULES=0 ./install.sh

EOF
}

main() {
  require_ubuntu

  if ! detect_conda; then
    fail "未检测到 conda。请先安装 Miniconda 或 Anaconda 后再运行本脚本。"
  fi

  log "检测到 conda：$(conda --version)"
  install_system_dependencies
  create_or_update_env
  install_python_dependencies
  install_motor_sdk
  install_frontend_dependencies
  verify_installation
  print_next_steps
}

main "$@"

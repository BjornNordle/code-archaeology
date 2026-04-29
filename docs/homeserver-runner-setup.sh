#!/bin/bash
# Sets up the GitHub Actions self-hosted runner for code-archaeology.
# Mirrors ~/homeserver/modules/uptime-monitor.sh — same pattern, different repo.
#
# Required env vars (set before running, or script will prompt):
#   GITHUB_RUNNER_TOKEN  - from GitHub: repo Settings → Actions → Runners → New runner
#   REPO_URL             - https://github.com/<user>/<repo>  (defaults to placeholder below)

set -e

RUNNER_USER="github-runner"
RUNNER_HOME="/home/${RUNNER_USER}"
RUNNER_DIR="${RUNNER_HOME}/actions-runner-code-archaeology"
RUNNER_VERSION="2.323.0"
REPO_URL="${REPO_URL:-https://github.com/BjornNordle/code-archaeology}"
TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"

if [ -z "$GITHUB_RUNNER_TOKEN" ]; then
    echo "   Get a token from: ${REPO_URL}/settings/actions/runners/new"
    read -rp "GitHub runner registration token: " GITHUB_RUNNER_TOKEN
fi

if id "$RUNNER_USER" &>/dev/null; then
    echo "==> User '${RUNNER_USER}' already exists, skipping."
else
    echo "==> Creating user '${RUNNER_USER}'..."
    sudo useradd -m -s /bin/bash "$RUNNER_USER"
fi

sudo usermod -aG docker "$RUNNER_USER"

if [ ! -f "${RUNNER_DIR}/config.sh" ]; then
    echo "==> Downloading GitHub Actions runner v${RUNNER_VERSION}..."
    sudo rm -rf "$RUNNER_DIR"
    sudo -u "$RUNNER_USER" mkdir -p "$RUNNER_DIR"
<<<<<<< HEAD
    sudo rm -f "/tmp/${TARBALL}"
=======
    rm -f "/tmp/${TARBALL}"
>>>>>>> e1093d4 (Initial scaffold: scanner that walks every commit and visualises code-quality timeline)
    sudo -u "$RUNNER_USER" curl -fsSL \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}" \
        -o "/tmp/${TARBALL}"
    sudo -u "$RUNNER_USER" tar -xzf "/tmp/${TARBALL}" -C "$RUNNER_DIR"
<<<<<<< HEAD
    sudo rm -f "/tmp/${TARBALL}"
=======
    rm -f "/tmp/${TARBALL}"
>>>>>>> e1093d4 (Initial scaffold: scanner that walks every commit and visualises code-quality timeline)
else
    echo "==> Runner already downloaded, skipping."
fi

if [ -f "${RUNNER_DIR}/.runner" ]; then
    echo "==> Runner already configured, skipping."
else
    echo "==> Configuring runner..."
    sudo -u "$RUNNER_USER" "${RUNNER_DIR}/config.sh" \
        --url "$REPO_URL" \
        --token "$GITHUB_RUNNER_TOKEN" \
        --name "$(hostname)-code-archaeology" \
        --labels "self-hosted,linux,x64" \
        --unattended \
        --replace
fi

echo "==> Installing runner as systemd service..."
sudo bash -c "cd ${RUNNER_DIR} && ./svc.sh install ${RUNNER_USER} && ./svc.sh start"

# Service name follows GitHub's pattern: actions.runner.<owner>-<repo>.<runner-name>
echo ""
echo "==> Done! Push to main to trigger a deploy."
echo "   Monitor at: ${REPO_URL}/actions"
echo "   Service: ls /etc/systemd/system | grep actions.runner"

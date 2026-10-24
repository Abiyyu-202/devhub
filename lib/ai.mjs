// AI CLI registry and detection. Used by `devhub agy`, `devhub opc`, `devhub ai`.
import { which } from './platform.mjs';

export const AI_TOOLS = [
  {
    key: 'agy',
    label: 'agy (Antigravity)',
    bin: 'agy',
    install: 'https://antigravity.google',
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    install: 'curl -fsSL https://opencode.ai/install | bash',
  },
  {
    key: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    key: 'codex',
    label: 'OpenAI Codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
  },
  {
    key: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
  },
  {
    key: 'aider',
    label: 'Aider',
    bin: 'aider',
    install: 'python3 -m pip install --user aider-install && aider-install',
  },
  {
    key: 'cursor-agent',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    install: 'curl https://cursor.com/install -fsS | bash',
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    install: 'npm install -g @github/copilot',
  },
  {
    key: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    install: 'npm install -g @qwen-code/qwen-code',
  },
  {
    key: 'crush',
    label: 'Crush',
    bin: 'crush',
    install: 'go install github.com/charmbracelet/crush@latest',
  },
  {
    key: 'goose',
    label: 'Goose',
    bin: 'goose',
    install: 'https://block.github.io/goose/docs/getting-started/installation',
  },
  {
    key: 'amp',
    label: 'Amp',
    bin: 'amp',
    install: 'npm install -g @sourcegraph/amp',
  },
];

export function aiKeys() {
  return AI_TOOLS.map((tool) => tool.key);
}

export function aiById(id) {
  const needle = String(id || '').toLowerCase();
  return AI_TOOLS.find((tool) => tool.key === needle || tool.bin === needle) || null;
}

export async function resolveAi(id) {
  const tool = aiById(id);
  if (!tool) return null;
  const binPath = await which(tool.bin);
  return { ...tool, binPath, installed: Boolean(binPath) };
}

export async function detectAiTools() {
  return Promise.all(AI_TOOLS.map((tool) => resolveAi(tool.key)));
}

export async function installedAiTools() {
  return (await detectAiTools()).filter((tool) => tool.installed);
}

export function installHint(tool) {
  return tool?.install || '';
}

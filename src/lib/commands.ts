import { notifyError } from '../state/notificationStore';

// コマンドレジストリ(PHASE1-SPEC 4.5)

export interface AppCommand {
  id: string;
  title: string;
  keybinding?: string;
  run(): void | Promise<void>;
}

const registry = new Map<string, AppCommand>();

export function registerCommand(cmd: AppCommand): void {
  registry.set(cmd.id, cmd);
}

export function getCommands(): AppCommand[] {
  return Array.from(registry.values());
}

export async function executeCommand(id: string): Promise<void> {
  const cmd = registry.get(id);
  if (!cmd) {
    const message = `不明なコマンドです: ${id}`;
    console.error(`executeCommand: unknown command "${id}"`);
    notifyError(message);
    return;
  }
  try {
    await cmd.run();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`executeCommand(${id}) failed:`, err);
    notifyError(detail);
  }
}

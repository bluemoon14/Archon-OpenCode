/**
 * Registry for `archon setup` plugins. Plugins run AFTER Claude in the
 * wizard — Claude stays inline in setup.ts to preserve its locked-in
 * SetupConfig shape; new runtimes (OpenCode, Pydantic AI) plug in here.
 */
import type { SetupPlugin } from './plugins';
import { opencodeSetupPlugin } from './plugins/opencode';
import { pydanticSetupPlugin } from './plugins/pydantic';

export function getSetupPlugins(): SetupPlugin[] {
  return [opencodeSetupPlugin, pydanticSetupPlugin];
}

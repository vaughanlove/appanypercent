import type { Config } from "./config.ts";
import { loadState, deleteState } from "./state.ts";
import { deleteVm } from "./exedev.ts";
import { deleteBranch, deleteRole } from "./planetscale.ts";
import { info, warn } from "./log.ts";

/**
 * Cheap, ordered, re-runnable teardown. Works on half-provisioned apps: every step
 * tolerates "already gone". Durable state was PlanetScale-only, so removing the
 * branch + roles + VM removes the app entirely.
 */
export async function teardown(cfg: Config): Promise<void> {
  const s = loadState(cfg.app);

  info(`deleting VM ${cfg.app} (disk is disposable by design)`);
  deleteVm(cfg.app);

  for (const role of [s.roles?.runtime, s.roles?.migrate]) {
    if (role?.id) {
      info(`deleting PlanetScale role ${role.name} (${role.id})`);
      deleteRole(cfg, cfg.app, role.id);
    }
  }
  if (!s.roles) warn("no roles recorded in state — if provisioning died mid-flight, check `pscale role list " + `${cfg.psDatabase} ${cfg.app}` + "`");

  info(`deleting PlanetScale branch ${cfg.psDatabase}/${cfg.app} (drops the app's database)`);
  deleteBranch(cfg, cfg.app);

  deleteState(cfg.app);
  info(`✅ ${cfg.app} torn down (VM, roles, branch, local state).`);
}

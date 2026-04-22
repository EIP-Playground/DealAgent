import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hasSkillPackageMarkers(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, "SKILL.md")) &&
    existsSync(path.join(candidate, "scripts")) &&
    existsSync(path.join(candidate, "skills"))
  );
}

export function currentFileDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}

export function resolveSkillPackageRootFromDir(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    if (hasSkillPackageMarkers(current)) {
      return current;
    }

    const next = path.dirname(current);
    if (next === current) {
      throw new Error("Unable to resolve skill package root from current file path");
    }
    current = next;
  }
}

export function resolveSkillPackageRoot(metaUrl: string): string {
  return resolveSkillPackageRootFromDir(currentFileDir(metaUrl));
}

export function isInstalledSkillPackageRoot(skillPackageRoot: string): boolean {
  return path.basename(path.dirname(path.resolve(skillPackageRoot))) === "skills";
}

export function resolveInstalledSkillDataRoot(skillPackageRoot: string): string {
  const resolvedRoot = path.resolve(skillPackageRoot);
  return path.resolve(resolvedRoot, "..", "..", "data", path.basename(resolvedRoot));
}

export function resolveSkillDataRoot(skillPackageRoot: string): string {
  const resolvedRoot = path.resolve(skillPackageRoot);
  if (isInstalledSkillPackageRoot(resolvedRoot)) {
    return resolveInstalledSkillDataRoot(resolvedRoot);
  }
  return path.join(resolvedRoot, "data");
}

export function resolveLegacyInstalledDbPath(skillPackageRoot: string): string {
  return path.join(path.resolve(skillPackageRoot), "data", "prod", "purr_suite_prod.sqlite3");
}

export function resolveLegacyInstalledScheduledJobLogDir(skillPackageRoot: string): string {
  return path.join(path.resolve(skillPackageRoot), "data", "logs", "scheduled-jobs");
}

export function resolveDefaultDbPath(skillPackageRoot: string): string {
  const dataRoot = resolveSkillDataRoot(skillPackageRoot);
  if (isInstalledSkillPackageRoot(skillPackageRoot)) {
    return path.join(dataRoot, "purr_suite_prod.sqlite3");
  }
  return path.join(dataRoot, "dev", "purr_suite_dev.sqlite3");
}

export function resolveScheduledJobLogDir(skillPackageRoot: string): string {
  return path.join(resolveSkillDataRoot(skillPackageRoot), "logs", "scheduled-jobs");
}

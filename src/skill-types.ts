export type SkillIntent =
  | "find"
  | "research"
  | "coding"
  | "data_analysis"
  | "file_ops"
  | "goal_planning";

export type SkillInstallSource =
  | "builtin"
  | "local_dir"
  | "git"
  | "package";

export type SkillExecutionStrategy =
  | "prompt_template"
  | "workflow_template"
  | "custom_runtime";

export interface SkillManifest {
  id: string;
  version: string;
  title: string;
  description: string;
  intents: SkillIntent[];
  keywords: string[];
  requiredTools: string[];
  optionalTools?: string[];
  install: {
    source: SkillInstallSource;
    location: string;
    entry?: string;
    checksum?: string;
  };
  activation: {
    mode: "always" | "intent_match" | "planner_selected";
    priority: number;
  };
  execution: {
    strategy: SkillExecutionStrategy;
    templateId?: string;
    runtimeEntry?: string;
  };
  verification?: {
    requiredArtifacts?: string[];
    successSignal?: string;
    artifactLabels?: Record<string, string>;
    successSignalLabel?: string;
    remediation?: {
      insufficient?: string;
      failed?: string;
    };
  };
}

export interface InstalledSkillRecord {
  id: string;
  version: string;
  installedAt: string;
  source: SkillInstallSource;
  location: string;
  enabled: boolean;
  checksum?: string;
}

export type SkillInstallStatus =
  | "installed"
  | "already_installed"
  | "blocked"
  | "unavailable"
  | "failed";

export interface SkillInstallResult {
  skillId: string;
  status: SkillInstallStatus;
  reason: string;
  source?: SkillInstallSource;
  location?: string;
  record?: InstalledSkillRecord;
}

export interface SkillMatchResult {
  skillId: string;
  score: number;
  reasons: string[];
  source: "rule" | "planner";
}

export interface PlannerSkillDecision {
  skill_id?: string;
  skill_action?: "use_installed" | "install_then_use" | "skip_skill";
  skill_reason?: string;
}

import type { SkillReflectionRecord } from "./skill-evolution-types.js";
import type { SkillManifest } from "./skill-types.js";

export const SKILL_MARKDOWN_SECTION_TITLES = {
  core_procedure: "Core Procedure",
  scenario_extensions: "Scenario Extensions",
  appendix: "Appendix",
} as const;

export type SkillMarkdownSectionId = keyof typeof SKILL_MARKDOWN_SECTION_TITLES;

export const PROPOSAL_GENERATOR_MANIFEST_PATCH_WHITELIST = [
  "verification.artifactLabels",
  "verification.successSignalLabel",
  "verification.remediation.insufficient",
  "verification.remediation.failed",
] as const;

export const PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY = {
  discovery: {
    defaultTargets: ["scenario_extensions", "appendix"],
    allowCoreProcedure: true,
    allowScenarioExtensions: true,
    allowAppendix: true,
    allowManifestWhitelistPatch: true,
  },
  optimization: {
    defaultTargets: ["core_procedure"],
    allowCoreProcedure: true,
    allowScenarioExtensions: true,
    allowAppendix: true,
    allowManifestWhitelistPatch: true,
  },
  skill_defect: {
    defaultTargets: ["core_procedure"],
    allowCoreProcedure: true,
    allowScenarioExtensions: true,
    allowAppendix: true,
    allowManifestWhitelistPatch: true,
  },
  execution_lapse: {
    defaultTargets: ["appendix"],
    allowCoreProcedure: false,
    allowScenarioExtensions: false,
    allowAppendix: true,
    allowManifestWhitelistPatch: false,
  },
} as const satisfies Record<SkillReflectionRecord["reflectionKind"], {
  defaultTargets: readonly string[];
  allowCoreProcedure: boolean;
  allowScenarioExtensions: boolean;
  allowAppendix: boolean;
  allowManifestWhitelistPatch: boolean;
}>;

export function canPatchManifestWhitelist(reflection: SkillReflectionRecord): boolean {
  return reflection.recommendedAction === "patch_verification"
    && PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY[reflection.reflectionKind].allowManifestWhitelistPatch;
}

export function hasToolScopeEscalation(candidate: SkillManifest | null, installed: SkillManifest | null): boolean {
  if (!candidate || !installed) {
    return false;
  }
  const installedRequired = new Set(installed.requiredTools ?? []);
  const installedOptional = new Set(installed.optionalTools ?? []);
  return (candidate.requiredTools ?? []).some((tool) => !installedRequired.has(tool))
    || (candidate.optionalTools ?? []).some((tool) => !installedOptional.has(tool));
}

export function hasInstallSourceEscalation(candidate: SkillManifest | null, installed: SkillManifest | null): boolean {
  if (!candidate || !installed) {
    return false;
  }
  return candidate.install.source !== installed.install.source
    && (candidate.install.source === "git" || candidate.install.source === "package");
}

export function hasRuntimeStrategyEscalation(candidate: SkillManifest | null, installed: SkillManifest | null): boolean {
  if (!candidate || !installed) {
    return false;
  }
  if (candidate.execution.strategy === installed.execution.strategy) {
    return false;
  }
  return candidate.execution.strategy === "custom_runtime";
}

export function hasRiskyManifestEscalation(candidate: SkillManifest | null, installed: SkillManifest | null): boolean {
  if (!candidate) {
    return true;
  }
  return hasToolScopeEscalation(candidate, installed)
    || hasInstallSourceEscalation(candidate, installed)
    || hasRuntimeStrategyEscalation(candidate, installed);
}

export function isReflectionToPatchConsistent(input: {
  reflection: SkillReflectionRecord | null;
  verificationTouched: boolean;
}): boolean {
  const { reflection, verificationTouched } = input;
  if (!reflection) {
    return false;
  }
  if (reflection.reflectionKind === "execution_lapse" || reflection.recommendedAction === "append_appendix") {
    return !verificationTouched;
  }
  if (reflection.recommendedAction === "patch_verification") {
    return canPatchManifestWhitelist(reflection) || !verificationTouched;
  }
  return true;
}

function normalizeMarkdownSectionBody(body: string | null | undefined): string {
  return (body ?? "").trim().replace(/\r\n/g, "\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractSkillMarkdownSections(markdown: string | null | undefined): Record<SkillMarkdownSectionId, string> {
  const text = markdown ?? "";
  const sections = {} as Record<SkillMarkdownSectionId, string>;
  const orderedIds = Object.keys(SKILL_MARKDOWN_SECTION_TITLES) as SkillMarkdownSectionId[];
  for (const id of orderedIds) {
    const title = SKILL_MARKDOWN_SECTION_TITLES[id];
    const matcher = new RegExp(`(^|\\n)##\\s+${escapeRegex(title)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
    const match = text.match(matcher);
    sections[id] = normalizeMarkdownSectionBody(match?.[2] ?? "");
  }
  return sections;
}

export function detectTouchedSkillMarkdownSections(input: {
  liveMarkdown: string | null | undefined;
  candidateMarkdown: string | null | undefined;
}): SkillMarkdownSectionId[] {
  const liveSections = extractSkillMarkdownSections(input.liveMarkdown);
  const candidateSections = extractSkillMarkdownSections(input.candidateMarkdown);
  return (Object.keys(SKILL_MARKDOWN_SECTION_TITLES) as SkillMarkdownSectionId[])
    .filter((id) => liveSections[id] !== candidateSections[id]);
}

export function resolveAllowedSkillMarkdownSections(reflection: SkillReflectionRecord | null): SkillMarkdownSectionId[] {
  if (!reflection) {
    return [];
  }
  const policy = PROPOSAL_GENERATOR_REFLECTION_PATCH_POLICY[reflection.reflectionKind];
  const allowed: SkillMarkdownSectionId[] = [];
  if (policy.allowCoreProcedure) allowed.push("core_procedure");
  if (policy.allowScenarioExtensions) allowed.push("scenario_extensions");
  if (policy.allowAppendix) allowed.push("appendix");
  return allowed;
}

export function resolvePreferredSkillMarkdownSections(reflection: SkillReflectionRecord | null): SkillMarkdownSectionId[] {
  if (!reflection) {
    return [];
  }
  switch (reflection.reflectionKind) {
    case "discovery":
      return ["scenario_extensions"];
    case "optimization":
      return ["core_procedure"];
    case "skill_defect":
      return ["core_procedure"];
    case "execution_lapse":
      return ["appendix"];
    default:
      return [];
  }
}

export function resolveExpectedSkillMarkdownSectionsForReflection(reflection: SkillReflectionRecord | null): SkillMarkdownSectionId[] {
  if (!reflection) {
    return [];
  }
  switch (reflection.reflectionKind) {
    case "discovery":
      return reflection.recommendedAction === "append_appendix"
        ? ["scenario_extensions", "appendix"]
        : ["core_procedure", "scenario_extensions", "appendix"];
    case "optimization":
      return ["core_procedure"];
    case "skill_defect":
      return reflection.evidence.failedCheckNames.length > 0
        ? ["core_procedure", "appendix"]
        : ["core_procedure"];
    case "execution_lapse":
      return ["appendix"];
    default:
      return ["appendix"];
  }
}

export function evaluateSkillMarkdownPatchPolicy(input: {
  reflection: SkillReflectionRecord | null;
  liveMarkdown: string | null | undefined;
  candidateMarkdown: string | null | undefined;
}): {
  touchedSectionIds: SkillMarkdownSectionId[];
  touchedSections: string[];
  allowedSectionIds: SkillMarkdownSectionId[];
  preferredSectionIds: SkillMarkdownSectionId[];
  policyReady: boolean;
  withinAllowedSections: boolean;
  hitsPreferredSection: boolean;
  markdownChanged: boolean;
  summary: string;
} {
  const touchedSectionIds = detectTouchedSkillMarkdownSections({
    liveMarkdown: input.liveMarkdown,
    candidateMarkdown: input.candidateMarkdown,
  });
  const touchedSections = touchedSectionIds.map((id) => SKILL_MARKDOWN_SECTION_TITLES[id]);
  const allowedSectionIds = resolveAllowedSkillMarkdownSections(input.reflection);
  const preferredSectionIds = resolvePreferredSkillMarkdownSections(input.reflection);
  const markdownChanged = normalizeMarkdownSectionBody(input.liveMarkdown) !== normalizeMarkdownSectionBody(input.candidateMarkdown);

  if (!input.reflection) {
    return {
      touchedSectionIds,
      touchedSections,
      allowedSectionIds,
      preferredSectionIds,
      policyReady: false,
      withinAllowedSections: false,
      hitsPreferredSection: false,
      markdownChanged,
      summary: "Markdown patch policy cannot be evaluated because the source reflection is unavailable.",
    };
  }

  if (!markdownChanged) {
    return {
      touchedSectionIds,
      touchedSections,
      allowedSectionIds,
      preferredSectionIds,
      policyReady: true,
      withinAllowedSections: true,
      hitsPreferredSection: true,
      markdownChanged: false,
      summary: "No markdown section changes were detected, so section-level patch policy is not violated.",
    };
  }

  const withinAllowedSections = touchedSectionIds.every((id) => allowedSectionIds.includes(id));
  const hitsPreferredSection = touchedSectionIds.length === 0
    ? false
    : preferredSectionIds.length === 0 || touchedSectionIds.some((id) => preferredSectionIds.includes(id));
  const policyReady = withinAllowedSections && hitsPreferredSection;

  const allowedTitles = allowedSectionIds.map((id) => SKILL_MARKDOWN_SECTION_TITLES[id]).join(", ") || "none";
  const preferredTitles = preferredSectionIds.map((id) => SKILL_MARKDOWN_SECTION_TITLES[id]).join(", ") || "none";
  const touchedTitles = touchedSections.join(", ") || "none";
  const summary = policyReady
    ? `Markdown changes stay within allowed sections (${allowedTitles}) and hit the preferred section set (${preferredTitles}).`
    : !withinAllowedSections
      ? `Markdown changes touch ${touchedTitles}, which crosses the allowed section set (${allowedTitles}).`
      : `Markdown changes stay within allowed sections (${allowedTitles}) but miss the preferred section set (${preferredTitles}).`;

  return {
    touchedSectionIds,
    touchedSections,
    allowedSectionIds,
    preferredSectionIds,
    policyReady,
    withinAllowedSections,
    hitsPreferredSection,
    markdownChanged: true,
    summary,
  };
}

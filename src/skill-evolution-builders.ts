import { loadEventsFromDisk } from "./job-event-bus.js";
import type { StoredJobRecord } from "./job-store.js";
import { mergeJobEvents, resolveSelectedSkillSummary, resolveSkillVerificationSummary } from "./job-response.js";
import { generateSkillEvolutionProposal } from "./skill-evolver.js";
import type { SkillEvolutionProposal, SkillReflectionRecord } from "./skill-evolution-types.js";
import { buildSkillOutcomeSummary } from "./skill-outcome.js";
import { buildSkillReflectionRecord } from "./skill-reflection.js";
import { getSkillManifest } from "./skill-registry.js";
import type { OrchestratorConfig } from "./types.js";

export function buildSkillReflectionFromRecord(record: StoredJobRecord): ReturnType<typeof buildSkillReflectionRecord> {
	const events = mergeJobEvents(record, loadEventsFromDisk(record.job.id));
	const selectedSkill = resolveSelectedSkillSummary(record, events);
	const skillVerification = resolveSkillVerificationSummary(record);
	const skillOutcome = buildSkillOutcomeSummary(record, events, selectedSkill, skillVerification);
	return buildSkillReflectionRecord(skillOutcome, {
		record,
		events,
	});
}

export function buildSkillEvolutionProposal(
	reflection: SkillReflectionRecord,
	candidateDir: string,
	config: OrchestratorConfig,
): SkillEvolutionProposal {
	return generateSkillEvolutionProposal({
		reflection,
		candidateDir,
		config,
		manifest: getSkillManifest(reflection.skillId, config),
	});
}

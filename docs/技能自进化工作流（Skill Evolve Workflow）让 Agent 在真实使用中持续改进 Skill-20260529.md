# 【参考资料】技能自进化工作流（Skill Evolve Workflow）让 Agent 在真实使用中持续改进 Skill

## 背景
清华团队同在 5 月 11 日发表了两篇关于 Agent 技能自进化的论文：

EmbodiSkill (arXiv:2605.10332) — 技能感知反思机制，区分执行失误与技能缺陷，用 (S_body, S_appendix) 双结构管理技能
SkillEvolver (arXiv:2605.10500) — 把技能自进化本身做成一个元技能，通过策略多样化探索 + 部署接地审计 + 独立检查门实现闭环
两篇论文的共同前提：更新的是技能的文本和代码，不是模型权重——这天然适合 SKILL.md 体系。

核心机制
1. S_body + S_appendix 双结构
将 SKILL.md 的内容明确分为两个区域：

S_body（核心指令）：诊断流程、各场景修复方法、核心步骤。稳定，只在 Discovery/Optimization/SkillDefect 时修改
S_appendix（踩坑记录）：注意事项、踩坑日志。持续增长，每次 ExecutionLapse 只追加不修改 body
论文消融实验数据：去掉 SkillDefect / ExecutionLapse 的区分后性能下降最明显。

2. 四种反思类型
类型	触发条件	动作	修改目标
Discovery	任务成功，发现新场景	往 body 追加	S_body
Optimization	任务成功，效率不高	优化 body	S_body
SkillDefect	任务失败，技能有缺陷	修复 body	S_body
ExecutionLapse	任务失败，但技能正确	追加踩坑提醒	S_appendix
关键判别准则：如果严格执行 skill 所有方案后问题仍存在 => SkillDefect（而非 ExecutionLapse）。

3. 部署接地审计
SkillEvolver 的核心创新：候选技能不靠作者自评，而是部署给全新 Agent 执行验证。可检测静默绕过——技能内容看似正确但 Agent 实际没用它。

4. 独立检查门
论文做了 9 项机械检查，包括格式完整性、一致性、可执行性、泄露检测等。拦掉了 17% 的有害更新。

在 OpenHanako 中的落地建议
短期（约定层）
在 skill 开发公约中建议 S_body / S_appendix 双结构
反思分类流程可作为 skill-creator 的补充流程
中期（工具层）
提供一个轻量 auditor 工具（检查 SKILL.md 的格式、一致性、可执行性）
在 subagent 派发时支持执行轨迹的结构化记录
远期（引擎层）
内置元技能（meta-skill），支持在 Agent 运行过程中自动发现技能缺陷、生成候选修复、部署验证后合并
论文引用
EmbodiSkill: https://arxiv.org/abs/2605.10332
SkillEvolver: https://arxiv.org/abs/2605.10500
SkillsBench (评测基准): https://arxiv.org/abs/2602.12670

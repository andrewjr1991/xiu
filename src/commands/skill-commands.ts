import chalk from "chalk";
import type { Agent } from "../agent.js";
import { localize, type UiLanguage } from "../i18n.js";
import { selectTerminalOption } from "../interactive-ui.js";
import type { SkillRegistry } from "../skills.js";
import type { StatusLine } from "../status.js";
import { askQuestion } from "../terminal-prompts.js";

export interface SkillCommandContext {
  agent: Agent;
  language: UiLanguage;
  skillRegistry: SkillRegistry;
  status: StatusLine;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handleSkillCommand(task: string, ctx: SkillCommandContext): Promise<boolean> {
  const { agent, language, skillRegistry, status } = ctx;
  if (task === "/skills") {
    const skills = await skillRegistry.refresh(true);
    agent.reloadInstructions();
    if (!skills.length) {
      console.log(chalk.dim(localize(language, "没有已安装技能。使用 /skills install <本地路径或 HTTPS Git URL> 安装。\n", "No skills installed. Use /skills install <path-or-https-git-url>.\n")));
      return true;
    }
    const selected = await selectTerminalOption(localize(language, "已安装技能", "Installed skills"), skills.map((skill) => ({
      label: skill.name,
      description: `${skill.scope}  ${skill.permissions.join(", ")}  ${skill.description.slice(0, 80)}`,
      value: skill.name,
    })), language);
    if (selected) {
      const skill = skills.find((item) => item.name === selected)!;
      console.log(`${chalk.cyan(skill.name)} ${chalk.dim(`[${skill.scope}]`)}\n${skill.description}`);
      console.log(chalk.dim(localize(language, `权限：${skill.permissions.join("、")}${skill.permissionsDeclared ? "（已声明）" : "（兼容默认）"}`, `Permissions: ${skill.permissions.join(", ")} ${skill.permissionsDeclared ? "(declared)" : "(compatibility default)"}`)));
      if (skill.permissionWarnings.length) console.log(chalk.yellow(localize(language, `未知权限：${skill.permissionWarnings.join("、")}`, `Unknown permissions: ${skill.permissionWarnings.join(", ")}`)));
      console.log(`${chalk.dim(skill.file)}\n`);
    }
    return true;
  }
  if (task.startsWith("/skills install ")) {
    const source = task.slice("/skills install ".length).trim();
    if (!source) {
      console.log(chalk.yellow(localize(language, "用法：/skills install <本地路径或 HTTPS Git URL>\n", "Usage: /skills install <local-path-or-https-git-url>\n")));
      return true;
    }
    status.start(localize(language, "正在安装技能包", "Installing skill package"));
    try {
      const confirmSkillPermissions = async ({ manifest, added, replacing }: { manifest: { name: string; permissions: string[] }; added: string[]; replacing: boolean }) => {
        status.stop();
        const preview = localize(language,
          `${replacing ? "技能更新" : "新技能"} ${manifest.name} 请求以下新增权限：\n${added.map((permission) => `  + ${permission}`).join("\n")}\n权限声明不会绕过 Xiu 的工作区信任、审批或 Plan 模式。`,
          `${replacing ? "Skill update" : "New skill"} ${manifest.name} requests these additional permissions:\n${added.map((permission) => `  + ${permission}`).join("\n")}\nThe declaration cannot bypass Xiu workspace trust, approvals, or Plan mode.`);
        console.log(chalk.yellow(preview));
        const answer = await askQuestion(chalk.yellow(localize(language, "确认并继续安装？[y/N] ", "Acknowledge and continue installation? [y/N] ")));
        const accepted = /^(y|yes)$/i.test(answer.trim());
        if (accepted) status.start(localize(language, "正在安装技能包", "Installing skill package"));
        return accepted;
      };
      let installed;
      try { installed = await skillRegistry.install(source, false, confirmSkillPermissions); }
      catch (error) {
        status.stop();
        if (!/Skill already exists:/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const answer = await askQuestion(chalk.yellow(localize(language, "技能已存在，是否备份后替换？[y/N] ", "Skill already exists. Back it up and replace it? [y/N] ")));
        if (!/^(y|yes)$/i.test(answer.trim())) {
          console.log(chalk.dim(localize(language, "已取消技能安装。\n", "Skill installation cancelled.\n")));
          return true;
        }
        status.start(localize(language, "正在替换技能包", "Replacing skill package"));
        installed = await skillRegistry.install(source, true, confirmSkillPermissions);
      }
      status.stop();
      agent.reloadInstructions();
      for (const skill of installed) {
        console.log(chalk.green(localize(language, `已安装技能 ${skill.name}`, `Installed skill ${skill.name}`)), chalk.dim(`-> ${skill.destination}`));
        console.log(chalk.dim(localize(language, `权限：${skill.permissions.join("、")}`, `Permissions: ${skill.permissions.join(", ")}`)));
        if (skill.backup) console.log(chalk.dim(localize(language, `旧版本已备份到 ${skill.backup}`, `Previous version backed up at ${skill.backup}`)));
      }
      console.log();
    } catch (error) {
      status.stop();
      console.error(chalk.red(`${localize(language, "技能安装失败", "Skill installation failed")}: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return true;
  }
  return false;
}

import path from "node:path";
import chalk from "chalk";
import type { AgentConfig } from "../config.js";
import { localize, type UiLanguage } from "../i18n.js";
import { describeFailure } from "../user-facing-errors.js";
import { selectTerminalOption } from "../interactive-ui.js";
import type { DiscoveredPlugin, PluginRegistry } from "../plugins.js";
import type { StatusLine } from "../status.js";

export interface PluginCommandContext {
  applyApprovedPlugins: (restartMcp: boolean) => Promise<string[]>;
  config: AgentConfig;
  language: UiLanguage;
  pluginRegistry: PluginRegistry;
  status: StatusLine;
}

/** Handles the slash commands moved out of the interactive loop in cli.ts; returns false when `task` is not one of them. */
export async function handlePluginCommand(task: string, ctx: PluginCommandContext): Promise<boolean> {
  const { applyApprovedPlugins, config, language, pluginRegistry, status } = ctx;
  if (task === "/plugins" || task === "/plugins reload") {
    const plugins = await pluginRegistry.refresh(true);
    const loadErrors = task === "/plugins reload" ? await applyApprovedPlugins(true) : [];
    if (!plugins.length) {
      console.log(chalk.dim(localize(language,
        "没有发现插件声明。可放置于 项目/.xiu/plugins/<插件>/xiu.plugin.json 或 ~/.xiu/plugins/<插件>/xiu.plugin.json。\n",
        "No plugin manifests found. Place them in <project>/.xiu/plugins/<plugin>/xiu.plugin.json or ~/.xiu/plugins/<plugin>/xiu.plugin.json.\n")));
      return true;
    }
    console.log(chalk.cyan(localize(language, "已发现插件（仅显式授权的声明式贡献会被加载；不会执行插件 JS）", "Discovered plugins (only explicitly approved declarative contributions are loaded; plugin JS is never executed)")));
    for (const plugin of plugins) {
      const marker = plugin.policy === "blocked" ? chalk.red("×") : plugin.state === "ready" ? chalk.green("√") : ["disabled", "incompatible"].includes(plugin.state) ? chalk.yellow("!") : chalk.red("×");
      const contributionCount = Object.values(plugin.contributions).reduce((total, entries) => total + (entries?.length ?? 0), 0);
      console.log(`${marker} ${chalk.bold(plugin.id)} ${chalk.dim(`${plugin.version} · ${plugin.scope} · ${plugin.state} · ${plugin.active ? "active" : "inactive"} · signature:${plugin.signature} · policy:${plugin.policy} · ${plugin.permissions.length} permissions · ${contributionCount} contributions`)}`);
      if (plugin.problems.length) console.log(chalk.dim(`  ${plugin.problems.join("; ")}`));
      if (plugin.policyProblems.length) console.log(chalk.yellow(`  ${plugin.policyProblems.join("; ")}`));
    }
    const shadowed = pluginRegistry.shadowed();
    if (shadowed.length) console.log(chalk.dim(localize(language, `另有 ${shadowed.length} 个同 ID 声明被项目级插件显式遮蔽。`, `${shadowed.length} duplicate ID declaration(s) are explicitly shadowed by project plugins.`)));
    if (loadErrors.length) console.log(chalk.yellow(`${localize(language, "贡献加载失败", "Contribution load failures")}:\n${loadErrors.map((error) => `  - ${error}`).join("\n")}`));
    console.log(chalk.dim(localize(language, "使用 /plugin inspect <id> 查看详情，/plugin approve <id> 授权。\n", "Use /plugin inspect <id> for details and /plugin approve <id> to authorize.\n")));
    return true;
  }
  if (task === "/plugin policy") {
    await pluginRegistry.refresh(true);
    const snapshot = pluginRegistry.policy();
    console.log(chalk.cyan(localize(language, "团队插件策略", "Team plugin policy")));
    console.log(`${localize(language, "文件", "File")}: ${snapshot.file}`);
    console.log(`${localize(language, "状态", "State")}: ${snapshot.state}`);
    if (snapshot.fingerprint) console.log(`${localize(language, "策略指纹", "Policy fingerprint")}: sha256:${snapshot.fingerprint}`);
    if (snapshot.problem) console.log(chalk.red(`${localize(language, "问题", "Problem")}: ${snapshot.problem}`));
    if (snapshot.policy) {
      console.log(`${localize(language, "要求签名", "Require signature")}: ${snapshot.policy.requireSignature ? localize(language, "是", "yes") : localize(language, "否", "no")}`);
      console.log(`${localize(language, "允许来源", "Allowed sources")}: ${snapshot.policy.allowedSources?.join(", ") ?? localize(language, "不限制", "unrestricted")}`);
      console.log(`${localize(language, "允许发布者", "Allowed publishers")}: ${snapshot.policy.allowedPublishers?.map((entry) => `sha256:${entry}`).join(", ") ?? localize(language, "不限制", "unrestricted")}`);
      console.log(`${localize(language, "禁止权限", "Denied permissions")}: ${snapshot.policy.deniedPermissions.join(", ") || localize(language, "无", "none")}`);
    }
    console.log(chalk.dim(localize(language, "团队策略只能限制插件；发布者信任和插件权限仍需本机显式确认。\n", "Team policy can only restrict plugins; publisher trust and plugin permissions still require explicit local approval.\n")));
    return true;
  }
  if (task === "/plugin publisher list") {
    try {
      const publishers = await pluginRegistry.trustedPublishers();
      if (!publishers.length) console.log(chalk.dim(localize(language, "没有已信任的插件发布者。\n", "No plugin publishers are trusted.\n")));
      else {
        console.log(chalk.cyan(localize(language, "已信任的插件发布者", "Trusted plugin publishers")));
        for (const publisher of publishers) console.log(`  ${publisher.name ?? localize(language, "未命名发布者", "Unnamed publisher")} · sha256:${publisher.fingerprint} · ${publisher.trustedAt}`);
        console.log();
      }
    } catch (error) { console.log(chalk.red(`${describeFailure(localize(language, "无法读取发布者信任存储", "Could not read publisher trust store"), error, language)}\n`)); }
    return true;
  }
  if (task === "/plugin publisher trust" || task.startsWith("/plugin publisher trust ")) {
    await pluginRegistry.refresh(true);
    const requested = task.slice("/plugin publisher trust".length).trim();
    const candidates = pluginRegistry.list().filter((plugin) => plugin.signature === "valid-untrusted");
    const id = requested || await selectTerminalOption(localize(language, "选择要信任其发布者的插件", "Choose a plugin whose publisher should be trusted"), candidates.map((plugin) => ({
      label: plugin.name,
      description: `${plugin.id} · ${plugin.publisherName ?? localize(language, "未命名发布者", "unnamed publisher")} · sha256:${plugin.publisherFingerprint}`,
      value: plugin.id,
    })), language);
    if (!id) { console.log(chalk.dim(localize(language, "没有选择插件。\n", "No plugin selected.\n"))); return true; }
    const plugin = pluginRegistry.get(id);
    if (!plugin?.publisherFingerprint || !plugin.publisherPublicKey || !["valid-untrusted", "trusted"].includes(plugin.signature)) {
      console.log(chalk.red(localize(language, `插件 ${id} 没有可供信任的有效签名。\n`, `Plugin ${id} does not have a valid signature that can be trusted.\n`)));
      return true;
    }
    const confirmed = await selectTerminalOption(localize(language,
      `信任插件 ${id} 的发布者？\n发布者：${plugin.publisherName ?? "未命名"}\n指纹：sha256:${plugin.publisherFingerprint}\n信任发布者不会自动授权插件权限。`,
      `Trust the publisher of plugin ${id}?\nPublisher: ${plugin.publisherName ?? "unnamed"}\nFingerprint: sha256:${plugin.publisherFingerprint}\nTrusting a publisher does not approve plugin permissions.`), [
      { label: localize(language, "信任此发布者", "Trust this publisher"), value: true },
      { label: localize(language, "取消", "Cancel"), value: false },
    ], language);
    if (!confirmed) { console.log(chalk.dim(localize(language, "已取消发布者信任。\n", "Publisher trust cancelled.\n"))); return true; }
    try {
      const publisher = await pluginRegistry.trustPublisher(id);
      console.log(chalk.green(localize(language, `已信任发布者 ${publisher.name ?? "未命名"}（sha256:${publisher.fingerprint}）。插件权限仍需单独授权。\n`, `Trusted publisher ${publisher.name ?? "unnamed"} (sha256:${publisher.fingerprint}). Plugin permissions still require separate approval.\n`)));
    } catch (error) { console.log(chalk.red(`${describeFailure(localize(language, "发布者信任失败", "Publisher trust failed"), error, language)}\n`)); }
    return true;
  }
  if (task === "/plugin publisher revoke" || task.startsWith("/plugin publisher revoke ")) {
    let fingerprint = task.slice("/plugin publisher revoke".length).trim().replace(/^sha256:/, "");
    try {
      const publishers = await pluginRegistry.trustedPublishers();
      fingerprint ||= await selectTerminalOption(localize(language, "选择要撤销信任的发布者", "Choose a publisher to revoke"), publishers.map((publisher) => ({
        label: publisher.name ?? localize(language, "未命名发布者", "Unnamed publisher"),
        description: `sha256:${publisher.fingerprint}`,
        value: publisher.fingerprint,
      })), language) ?? "";
      if (!fingerprint) { console.log(chalk.dim(localize(language, "没有选择发布者。\n", "No publisher selected.\n"))); return true; }
      const confirmed = await selectTerminalOption(localize(language, `撤销发布者 sha256:${fingerprint} 的信任？`, `Revoke trust in publisher sha256:${fingerprint}?`), [
        { label: localize(language, "撤销信任", "Revoke trust"), value: true },
        { label: localize(language, "取消", "Cancel"), value: false },
      ], language);
      if (!confirmed) return true;
      const revoked = await pluginRegistry.revokePublisher(fingerprint);
      console.log(revoked ? chalk.green(localize(language, "发布者信任已撤销。现有插件权限授权不会被静默扩大。\n", "Publisher trust was revoked. Existing plugin permission approvals are not silently expanded.\n")) : chalk.yellow(localize(language, "未找到该发布者。\n", "Publisher not found.\n")));
    } catch (error) { console.log(chalk.red(`${describeFailure(localize(language, "撤销发布者信任失败", "Could not revoke publisher trust"), error, language)}\n`)); }
    return true;
  }
  if (task === "/plugin install" || task.startsWith("/plugin install ")) {
    const source = task.slice("/plugin install".length).trim();
    if (!source) {
      console.log(chalk.yellow(localize(language, "用法：/plugin install <可信本地路径或 HTTPS Git URL>\n", "Usage: /plugin install <trusted-local-path-or-https-git-url>\n")));
      return true;
    }
    const scope = await selectTerminalOption(localize(language, "选择插件安装范围", "Choose plugin install scope"), [
      { label: localize(language, "当前项目", "Current project"), description: path.join(config.cwd, ".xiu", "plugins"), value: "project" as const },
      { label: localize(language, "当前用户", "Current user"), description: localize(language, "可供所有项目发现", "Discoverable by all projects"), value: "global" as const },
    ], language);
    if (!scope) { console.log(chalk.dim(localize(language, "已取消插件安装。\n", "Plugin installation cancelled.\n"))); return true; }
    status.start(localize(language, "正在暂存并检查插件", "Staging and validating plugin"));
    try {
      const plan = await pluginRegistry.prepareInstall(source, scope);
      status.stop();
      if (plan.previous) {
        await pluginRegistry.cancelInstall(plan);
        console.log(chalk.yellow(localize(language, `插件 ${plan.plugin.id} 已存在，请使用 /plugin update ${plan.plugin.id}。\n`, `Plugin ${plan.plugin.id} already exists; use /plugin update ${plan.plugin.id}.\n`)));
        return true;
      }
      const confirmed = await selectTerminalOption(localize(language,
        `安装插件 ${plan.plugin.name} ${plan.plugin.version}？\n来源：${plan.source}\n摘要：sha256:${plan.packageDigest.slice(0, 16)}…${plan.sourceRevision ? `\n源修订：${plan.sourceRevision}` : ""}\n签名：${plan.plugin.signature}${plan.plugin.publisherFingerprint ? ` · ${plan.plugin.publisherName ?? "未命名发布者"} · sha256:${plan.plugin.publisherFingerprint}` : ""}\n范围：${scope}\n权限：${plan.plugin.permissions.join("、") || "无"}\n安装后仍需 /plugin approve 精确授权。`,
        `Install plugin ${plan.plugin.name} ${plan.plugin.version}?\nSource: ${plan.source}\nDigest: sha256:${plan.packageDigest.slice(0, 16)}…${plan.sourceRevision ? `\nSource revision: ${plan.sourceRevision}` : ""}\nSignature: ${plan.plugin.signature}${plan.plugin.publisherFingerprint ? ` · ${plan.plugin.publisherName ?? "unnamed publisher"} · sha256:${plan.plugin.publisherFingerprint}` : ""}\nScope: ${scope}\nPermissions: ${plan.plugin.permissions.join(", ") || "none"}\nExact /plugin approve authorization is still required after installation.`), [
        { label: localize(language, "安装", "Install"), value: true },
        { label: localize(language, "取消", "Cancel"), value: false },
      ], language);
      if (!confirmed) {
        await pluginRegistry.cancelInstall(plan);
        console.log(chalk.dim(localize(language, "已取消插件安装。\n", "Plugin installation cancelled.\n")));
        return true;
      }
      const result = await pluginRegistry.commitInstall(plan);
      await applyApprovedPlugins(true);
      console.log(chalk.green(localize(language, `插件 ${result.plugin.id} ${result.plugin.version} 已安装但尚未授权。\n`, `Plugin ${result.plugin.id} ${result.plugin.version} was installed but is not yet authorized.\n`)));
    } catch (error) {
      status.stop();
      console.log(chalk.red(`${describeFailure(localize(language, "插件安装失败", "Plugin installation failed"), error, language)}\n`));
    }
    return true;
  }
  if (task === "/plugin update" || task.startsWith("/plugin update ")) {
    await pluginRegistry.refresh(true);
    const id = task.slice("/plugin update".length).trim();
    if (!id) { console.log(chalk.yellow(localize(language, "用法：/plugin update <插件 ID>\n", "Usage: /plugin update <plugin-id>\n"))); return true; }
    status.start(localize(language, "正在获取并检查插件更新", "Fetching and validating plugin update"));
    try {
      const plan = await pluginRegistry.prepareUpdate(id);
      status.stop();
      const changes = [
        plan.addedPermissions.length ? localize(language, `新增权限：${plan.addedPermissions.join("、")}`, `Added permissions: ${plan.addedPermissions.join(", ")}`) : localize(language, "没有新增权限", "No added permissions"),
        plan.removedPermissions.length ? localize(language, `移除权限：${plan.removedPermissions.join("、")}`, `Removed permissions: ${plan.removedPermissions.join(", ")}`) : "",
      ].filter(Boolean).join("\n");
      const confirmed = await selectTerminalOption(localize(language,
        `更新插件 ${id}：${plan.previous?.version ?? "?"} → ${plan.plugin.version}？\n来源：${plan.source}\n摘要：sha256:${plan.packageDigest.slice(0, 16)}…${plan.sourceRevision ? `\n源修订：${plan.sourceRevision}` : ""}\n签名：${plan.plugin.signature}${plan.plugin.publisherFingerprint ? ` · ${plan.plugin.publisherName ?? "未命名发布者"} · sha256:${plan.plugin.publisherFingerprint}` : ""}\n${changes}\n旧版本会保留为可恢复备份，更新后必须重新授权。`,
        `Update plugin ${id}: ${plan.previous?.version ?? "?"} -> ${plan.plugin.version}?\nSource: ${plan.source}\nDigest: sha256:${plan.packageDigest.slice(0, 16)}…${plan.sourceRevision ? `\nSource revision: ${plan.sourceRevision}` : ""}\nSignature: ${plan.plugin.signature}${plan.plugin.publisherFingerprint ? ` · ${plan.plugin.publisherName ?? "unnamed publisher"} · sha256:${plan.plugin.publisherFingerprint}` : ""}\n${changes}\nThe old version is retained as a recoverable backup and the update must be re-authorized.`), [
        { label: localize(language, "更新并保留备份", "Update and keep backup"), value: true },
        { label: localize(language, "取消", "Cancel"), value: false },
      ], language);
      if (!confirmed) { await pluginRegistry.cancelInstall(plan); console.log(chalk.dim(localize(language, "已取消插件更新。\n", "Plugin update cancelled.\n"))); return true; }
      const result = await pluginRegistry.commitInstall(plan);
      await applyApprovedPlugins(true);
      console.log(chalk.green(localize(language, `插件 ${id} 已更新到 ${result.plugin.version}，旧版本备份于 ${result.backup}。请重新执行 /plugin approve ${id}。\n`, `Plugin ${id} was updated to ${result.plugin.version}; the old version is backed up at ${result.backup}. Run /plugin approve ${id} again.\n`)));
    } catch (error) {
      status.stop();
      console.log(chalk.red(`${describeFailure(localize(language, "插件更新失败", "Plugin update failed"), error, language)}\n`));
    }
    return true;
  }
  if (/^\/plugin (enable|disable)(?:\s|$)/.test(task)) {
    const [, action = "", id = ""] = /^\/plugin (enable|disable)\s+(.+)$/.exec(task) ?? [];
    if (!id) { console.log(chalk.yellow(localize(language, "用法：/plugin enable|disable <插件 ID>\n", "Usage: /plugin enable|disable <plugin-id>\n"))); return true; }
    try {
      await pluginRegistry.refresh(true);
      await pluginRegistry.setEnabled(id.trim(), action === "enable");
      const errors = await applyApprovedPlugins(true);
      console.log(chalk.green(localize(language, `插件 ${id.trim()} 已${action === "enable" ? "启用" : "禁用"}。${errors.length ? ` 部分贡献加载失败：${errors.join("；")}` : ""}\n`, `Plugin ${id.trim()} was ${action === "enable" ? "enabled" : "disabled"}.${errors.length ? ` Some contributions failed: ${errors.join("; ")}` : ""}\n`)));
    } catch (error) { console.log(chalk.red(`${describeFailure(localize(language, "插件状态修改失败", "Could not change plugin state"), error, language)}\n`)); }
    return true;
  }
  if (task === "/plugin uninstall" || task.startsWith("/plugin uninstall ")) {
    const id = task.slice("/plugin uninstall".length).trim();
    if (!id) { console.log(chalk.yellow(localize(language, "用法：/plugin uninstall <插件 ID>\n", "Usage: /plugin uninstall <plugin-id>\n"))); return true; }
    await pluginRegistry.refresh(true);
    const plugin = pluginRegistry.get(id);
    if (!plugin) { console.log(chalk.yellow(localize(language, `未找到插件：${id}\n`, `Plugin not found: ${id}\n`))); return true; }
    const confirmed = await selectTerminalOption(localize(language,
      `卸载插件 ${plugin.name}？插件包会移入可恢复备份，不会删除用户生成的数据。`,
      `Uninstall plugin ${plugin.name}? Its package will be moved to a recoverable backup; user-generated data will not be deleted.`), [
      { label: localize(language, "卸载并保留备份", "Uninstall and retain backup"), value: true },
      { label: localize(language, "取消", "Cancel"), value: false },
    ], language);
    if (!confirmed) { console.log(chalk.dim(localize(language, "已取消插件卸载。\n", "Plugin uninstall cancelled.\n"))); return true; }
    try {
      const backup = await pluginRegistry.uninstall(id);
      await applyApprovedPlugins(true);
      console.log(chalk.green(localize(language, `插件 ${id} 已卸载，备份位于 ${backup}。可使用 /plugin recover ${id} ${plugin.scope} 恢复。\n`, `Plugin ${id} was uninstalled and backed up at ${backup}. Use /plugin recover ${id} ${plugin.scope} to restore it.\n`)));
    } catch (error) { console.log(chalk.red(`${describeFailure(localize(language, "插件卸载失败", "Plugin uninstall failed"), error, language)}\n`)); }
    return true;
  }
  if (task === "/plugin recover" || task.startsWith("/plugin recover ")) {
    const parts = task.slice("/plugin recover".length).trim().split(/\s+/).filter(Boolean);
    const id = parts[0];
    let scope = parts[1] as "global" | "project" | undefined;
    if (!id || (scope && scope !== "global" && scope !== "project")) { console.log(chalk.yellow(localize(language, "用法：/plugin recover <插件 ID> [global|project]\n", "Usage: /plugin recover <plugin-id> [global|project]\n"))); return true; }
    scope ??= await selectTerminalOption(localize(language, "选择要恢复的插件范围", "Choose plugin recovery scope"), [
      { label: localize(language, "当前项目", "Current project"), value: "project" as const },
      { label: localize(language, "当前用户", "Current user"), value: "global" as const },
    ], language);
    if (!scope) return true;
    try {
      const plugin = await pluginRegistry.recover(id, scope);
      const errors = await applyApprovedPlugins(true);
      console.log(chalk.green(localize(language, `插件 ${id} ${plugin.version} 已从最近备份恢复。${errors.length ? ` 部分贡献加载失败：${errors.join("；")}` : ""}\n`, `Plugin ${id} ${plugin.version} was restored from the latest backup.${errors.length ? ` Some contributions failed: ${errors.join("; ")}` : ""}\n`)));
    } catch (error) { console.log(chalk.red(`${describeFailure(localize(language, "插件恢复失败", "Plugin recovery failed"), error, language)}\n`)); }
    return true;
  }
  if (task === "/plugin approve" || task.startsWith("/plugin approve ")) {
    await pluginRegistry.refresh(true);
    const requested = task.slice("/plugin approve".length).trim();
    const candidates = pluginRegistry.list().filter((plugin) => plugin.state === "ready" && plugin.policy !== "blocked" && !plugin.active);
    const id = requested || await selectTerminalOption(localize(language, "选择要授权的插件", "Choose a plugin to authorize"), candidates.map((plugin) => ({
      label: plugin.name,
      description: `${plugin.id} · ${plugin.permissions.join(", ") || localize(language, "无权限", "no permissions")}`,
      value: plugin.id,
    })), language);
    if (!id) {
      console.log(chalk.dim(localize(language, "没有选择插件。\n", "No plugin selected.\n")));
      return true;
    }
    const plugin = pluginRegistry.get(id);
    if (!plugin) {
      console.log(chalk.yellow(localize(language, `未找到插件：${id}\n`, `Plugin not found: ${id}\n`)));
      return true;
    }
    if (plugin.active) {
      console.log(chalk.dim(localize(language, `插件 ${id} 的当前清单已授权。\n`, `The current manifest for plugin ${id} is already approved.\n`)));
      return true;
    }
    if (plugin.state !== "ready") {
      console.log(chalk.red(localize(language, `插件 ${id} 无法授权：${plugin.problems.join("；")}\n`, `Plugin ${id} cannot be approved: ${plugin.problems.join("; ")}\n`)));
      return true;
    }
    if (plugin.policy === "blocked") {
      console.log(chalk.red(localize(language, `插件 ${id} 被团队策略阻止：${plugin.policyProblems.join("；")}\n`, `Plugin ${id} is blocked by team policy: ${plugin.policyProblems.join("; ")}\n`)));
      return true;
    }
    const contributionCount = Object.values(plugin.contributions).reduce((total, entries) => total + (entries?.length ?? 0), 0);
    const confirmed = await selectTerminalOption(localize(language,
      `授权插件 ${plugin.name}？\n签名：${plugin.signature}${plugin.publisherFingerprint ? ` · ${plugin.publisherName ?? "未命名发布者"} · sha256:${plugin.publisherFingerprint}` : ""}\n权限：${plugin.permissions.join("、") || "无"}\n声明式贡献：${contributionCount} 项\nXiu 不会执行插件 JavaScript。`,
      `Authorize plugin ${plugin.name}?\nSignature: ${plugin.signature}${plugin.publisherFingerprint ? ` · ${plugin.publisherName ?? "unnamed publisher"} · sha256:${plugin.publisherFingerprint}` : ""}\nPermissions: ${plugin.permissions.join(", ") || "none"}\nDeclarative contributions: ${contributionCount}\nXiu will not execute plugin JavaScript.`), [
      { label: localize(language, "授权当前清单", "Approve current manifest"), value: true },
      { label: localize(language, "取消", "Cancel"), value: false },
    ], language);
    if (!confirmed) {
      console.log(chalk.dim(localize(language, "已取消插件授权。\n", "Plugin approval cancelled.\n")));
      return true;
    }
    await pluginRegistry.approve(id);
    const loadErrors = await applyApprovedPlugins(true);
    if (loadErrors.length) console.log(chalk.yellow(`${localize(language, "插件已授权，但部分贡献加载失败", "Plugin approved, but some contributions failed to load")}:\n${loadErrors.map((error) => `  - ${error}`).join("\n")}\n`));
    else console.log(chalk.green(localize(language, `插件 ${id} 已授权并加载。\n`, `Plugin ${id} was approved and loaded.\n`)));
    return true;
  }
  if (task === "/plugin inspect" || task.startsWith("/plugin inspect ")) {
    const id = task.slice("/plugin inspect".length).trim();
    if (!id) {
      console.log(chalk.yellow(localize(language, "用法：/plugin inspect <插件 ID>\n", "Usage: /plugin inspect <plugin-id>\n")));
      return true;
    }
    await pluginRegistry.refresh(true);
    const plugin: DiscoveredPlugin | undefined = pluginRegistry.get(id);
    if (!plugin) {
      console.log(chalk.yellow(localize(language, `未找到插件：${id}\n`, `Plugin not found: ${id}\n`)));
      return true;
    }
    console.log(chalk.cyan(`${plugin.name} (${plugin.id})`));
    console.log(`${localize(language, "版本", "Version")}: ${plugin.version}`);
    console.log(`${localize(language, "范围", "Scope")}: ${plugin.scope}`);
    console.log(`${localize(language, "状态", "State")}: ${plugin.state}`);
    console.log(`${localize(language, "激活", "Active")}: ${plugin.active ? localize(language, "是（当前清单已授权）", "yes (current manifest approved)") : localize(language, "否（需要显式授权）", "no (explicit approval required)")}`);
    console.log(`${localize(language, "权限", "Permissions")}: ${plugin.permissions.join(", ") || localize(language, "无", "none")}`);
    console.log(`${localize(language, "清单", "Manifest")}: ${plugin.manifestPath}`);
    console.log(`${localize(language, "完整性", "Integrity")}: ${plugin.integrity}${plugin.packageDigest ? ` · sha256:${plugin.packageDigest.slice(0, 16)}…` : ""}`);
    console.log(`${localize(language, "签名", "Signature")}: ${plugin.signature}`);
    console.log(`${localize(language, "团队策略", "Team policy")}: ${plugin.policy}`);
    if (plugin.publisherFingerprint) console.log(`${localize(language, "发布者", "Publisher")}: ${plugin.publisherName ?? localize(language, "未命名", "unnamed")} · sha256:${plugin.publisherFingerprint}`);
    if (plugin.installSource) console.log(`${localize(language, "安装来源", "Install source")}: ${plugin.installSource}`);
    if (plugin.sourceRevision) console.log(`${localize(language, "源修订", "Source revision")}: ${plugin.sourceRevision}`);
    for (const [kind, entries] of Object.entries(plugin.contributions)) {
      for (const entry of entries ?? []) console.log(`  ${kind}: ${entry.id} -> ${entry.path}`);
    }
    if (plugin.problems.length) console.log(chalk.yellow(`${localize(language, "问题", "Problems")}:\n${plugin.problems.map((problem) => `  - ${problem}`).join("\n")}`));
    if (plugin.policyProblems.length) console.log(chalk.red(`${localize(language, "策略阻止原因", "Policy blocks")}:\n${plugin.policyProblems.map((problem) => `  - ${problem}`).join("\n")}`));
    console.log();
    return true;
  }
  return false;
}

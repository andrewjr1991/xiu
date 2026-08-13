import { localize, type UiLanguage } from "./i18n.js";

function suffix(description: string, prefix: RegExp): string {
  return description.replace(prefix, "").trim();
}

/** Keep technical identifiers intact while localizing Xiu-owned activity descriptions. */
export function localizeToolDescription(name: string, description: string, language: UiLanguage): string {
  if (language !== "zh-CN") return description;
  const rest = (prefix: RegExp) => suffix(description, prefix);
  switch (name) {
    case "list_files": return `列出匹配 ${rest(/^list files matching\s*/i)} 的文件`;
    case "read_file": return `读取 ${rest(/^read\s*/i)}`;
    case "extract_html": return `提取 HTML：${rest(/^extract HTML\s*/i)}`;
    case "extract_json": return `提取 JSON：${rest(/^extract JSON\s*/i)}`;
    case "extract_csv": return `提取表格：${rest(/^extract CSV rows from\s*/i)}`;
    case "repository_map": {
      const scope = rest(/^map repository modules\s*/i).replace(/^under\s+/i, "");
      return `查看项目地图${scope ? `：${scope}` : ""}`;
    }
    case "find_symbol": return `查找符号 ${rest(/^find symbol\s*/i)}`;
    case "find_references": return `查找引用 ${rest(/^find references to\s*/i)}`;
    case "find_callers": return `查找调用方 ${rest(/^find callers of\s*/i)}`;
    case "verify_output": return `验证生成结果 ${rest(/^verify generated output\s*/i)}`;
    case "search_text": return `搜索 ${rest(/^search for\s*/i)}`;
    case "web_search": return `联网搜索 ${rest(/^search the web for\s*/i)}`;
    case "web_open": return `打开网页 ${rest(/^open web page\s*/i)}`;
    case "write_file": return `写入 ${rest(/^write\s*/i)}`;
    case "replace_text": return `修改 ${rest(/^edit\s*/i)}`;
    case "apply_patch": return `应用补丁 ${rest(/^patch\s*/i)}`;
    case "run_process": return `直接运行：${rest(/^run directly:\s*/i)}`;
    case "run_command": return `运行 PowerShell：${rest(/^run:\s*/i)}`;
    case "project_info": return "识别项目类型和检查命令";
    case "start_background": return `后台启动：${rest(/^start in background:\s*/i)}`;
    case "list_background": return "列出后台命令";
    case "read_background": return `读取后台输出 ${rest(/^read background output\s*/i)}`;
    case "stop_background": return `停止后台命令 ${rest(/^stop background command\s*/i)}`;
    case "git_status": return "检查 Git 状态";
    case "git_log": return "读取最近 Git 历史";
    case "git_diff": return "检查 Git 差异";
    case "validate_project": return `运行项目检查 ${rest(/^run project\s*/i)}`;
    case "update_task_plan": return "更新可见任务计划";
    case "load_skill": return `加载技能 ${rest(/^load skill\s*/i)}`;
    case "analyze_image": return description.replace(/^send\s+/i, "将 ").replace(/\s+to vision model\s+/i, " 发送到视觉模型 ");
    case "generate_image":
    case "generate_video": return description.replace(/^generate\s+/i, "生成 ").replace(/\s+with\s+/i, "，使用模型 ");
    case "list_media_operations": return "查看媒体生成与恢复任务";
    case "resume_media_operation": return description.replace(/^resume media request\s+/i, "恢复媒体请求 ").replace(/\s+into\s+/i, "，保存到 ").replace(/\s+without creating a new generation$/i, "（不创建新生成任务）");
    case "ask_user": return localize(language, "等待用户回答", "Wait for the user's answer");
    default:
      if (name.startsWith("mcp__")) return description.replace(/^call MCP tool\s+/i, "调用 MCP 工具 ").replace(/\s+with\s+/i, "，参数 ");
      return description;
  }
}

export function localizeToolProgress(message: string, language: UiLanguage): string {
  if (language !== "zh-CN") return message;
  return message
    .replace(/^Submitting potentially billable image request\s+(.+?)\s+to\s+/i, "正在提交可能产生费用的图片请求 $1，模型：")
    .replace(/^Resuming download for image request\s+/i, "正在继续下载图片请求：")
    .replace(/^Resuming download for video request\s+/i, "正在继续下载视频请求：")
    .replace(/^Submitting potentially billable video request\s+(.+?)\s+to\s+/i, "正在提交可能产生费用的视频请求 $1，模型：")
    .replace(/^Resuming video request\s+/i, "正在恢复视频请求：")
    .replace(/^Video\s+(.+?):\s+status service busy; retrying poll in\s+(\d+)s/i, "视频任务 $1：状态服务繁忙，$2 秒后重试查询")
    .replace(/^Video\s+(.+?):\s*/i, "视频任务 $1：")
    .replace(/^Generating image with\s+/i, "正在使用以下模型生成图片：")
    .replace(/^Submitting video to\s+/i, "正在向以下模型提交视频任务：")
    .replace(/^Downloading completed video\s+/i, "正在下载已完成的视频：")
    .replace(/^Resuming media request\s+/i, "正在恢复媒体请求：")
    .replace(/^Reusing cached media request\s+/i, "正在复用媒体缓存：")
    .replace(/^Temporary model error; retrying\s+/i, "模型暂时出错，正在重试 ")
    .replace(/^Model request failed:\s*/i, "模型请求失败：");
}

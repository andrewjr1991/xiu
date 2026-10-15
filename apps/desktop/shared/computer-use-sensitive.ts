/**
 * Single source of truth for the Computer Use sensitivity patterns.
 *
 * `apps/desktop/native/ComputerBridge.cs` embeds the same three strings so the
 * native helper refuses sensitive targets even if the main process is wrong;
 * `test/computer-use-sensitive.test.ts` fails whenever the two copies diverge.
 * Keep the patterns to plain alternations and character classes, which .NET
 * and JavaScript regular expressions interpret identically.
 */

/** Window titles that are never observed or operated (case-insensitive substring match). */
export const SENSITIVE_WINDOW_TITLE_PATTERN = "密码|口令|凭证|凭据|支付|付款|结账|收银|钱包|银行|验证码|登录|登入|管理员|password|passcode|passkey|credential|payment|checkout|wallet|bank|verification code|one.?time code|sign.?in|log.?in|administrator";

/** Process names (without extension) that are never observed or operated: Xiu itself, consent brokers, terminals, admin consoles, remote desktop and password managers. */
export const BLOCKED_APP_PATTERN = "^(xiu|codex|credentialuibroker|consent|systemsettings|taskmgr|cmd|powershell|pwsh|windowsterminal|openconsole|conhost|putty|kitty|mintty|mstsc|regedit|mmc|secpol|gpedit|explorer|keepass|keepassxc|1password|bitwarden|lastpass|dashlane|enpass)$";

/** Control names whose activation is refused: destructive, publishing, paying, installing, credential or permission controls. */
export const CONSEQUENTIAL_CONTROL_PATTERN = "delete|remove|purchase|payment|pay now|checkout|send|publish|install|uninstall|password|sign.?in|log.?in|permission|grant access|删除|移除|付款|支付|购买|结账|发送|发布|安装|卸载|密码|登录|权限|授权";

const sensitiveTitle = new RegExp(SENSITIVE_WINDOW_TITLE_PATTERN, "i");
const blockedApp = new RegExp(BLOCKED_APP_PATTERN, "i");
const consequentialControl = new RegExp(CONSEQUENTIAL_CONTROL_PATTERN, "i");

export function isSensitiveWindowTitle(title: string): boolean { return sensitiveTitle.test(title); }
export function isBlockedApp(app: string): boolean { return blockedApp.test(app); }
export function isConsequentialControlName(name: string): boolean { return consequentialControl.test(name); }

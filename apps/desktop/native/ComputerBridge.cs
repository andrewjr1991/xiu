using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// One bounded request per process. No shell, paths, network, clipboard, or arbitrary code.
class ComputerBridge {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Key { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Key key; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union u; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int n);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern uint SendInput(uint n,Input[] inputs,int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=12000000 };
  // Shared with apps/desktop/shared/computer-use-sensitive.ts; test/computer-use-sensitive.test.ts fails when the copies diverge.
  const string SensitiveWindowTitlePattern=@"密码|口令|凭证|凭据|支付|付款|结账|收银|钱包|银行|验证码|登录|登入|管理员|password|passcode|passkey|credential|payment|checkout|wallet|bank|verification code|one.?time code|sign.?in|log.?in|administrator";
  const string BlockedAppPattern=@"^(xiu|codex|credentialuibroker|consent|systemsettings|taskmgr|cmd|powershell|pwsh|windowsterminal|openconsole|conhost|putty|kitty|mintty|mstsc|regedit|mmc|secpol|gpedit|explorer|keepass|keepassxc|1password|bitwarden|lastpass|dashlane|enpass)$";
  const string ConsequentialControlPattern=@"delete|remove|purchase|payment|pay now|checkout|send|publish|install|uninstall|password|sign.?in|log.?in|permission|grant access|删除|移除|付款|支付|购买|结账|发送|发布|安装|卸载|密码|登录|权限|授权";
  // Shared with apps/desktop/shared/computer-use-inputs.ts; test/computer-use-inputs.test.ts fails when the copies diverge.
  static readonly string[] Tier1Keys={"Enter","Tab","Escape","Backspace","Delete","Space","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown","F2","Shift+Home","Shift+End","Ctrl+A","Ctrl+Z"};
  static readonly string[] Tier2Keys={"Ctrl+C","Ctrl+V","Ctrl+S","Ctrl+Y"};
  static readonly string[] EditorOnlyKeys={"Shift+Home","Shift+End","Ctrl+A","Ctrl+Z","Ctrl+C","Ctrl+V","Ctrl+Y"};
  static Dictionary<string,object> req;
  static string inspection="unavailable";
  // Only an explicit per-step user confirmation in the main process sets this; automatic mode never does.
  static bool AllowUninspected() { return req.ContainsKey("allowUninspected")&&req["allowUninspected"] is bool&&(bool)req["allowUninspected"]; }
  static readonly string[] Verdicts={"sensitive-control-denied","consequential-control-denied","element-changed-observe-again","control-uninspected"};
  static bool IsVerdict(Exception e) { return Array.IndexOf(Verdicts,e.Message)>=0; }
  static string S(string k) { return req.ContainsKey(k)?Convert.ToString(req[k]):""; }
  static int N(string k) { return Convert.ToInt32(req[k]); }
  static Dictionary<string,object> Info(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h,out pid);
    var p=Process.GetProcessById((int)pid);
    var t=new StringBuilder(1024); GetWindowText(h,t,t.Capacity);
    Rect r; if(!GetClientRect(h,out r))throw new Exception("window-unavailable");
    return new Dictionary<string,object>{{"handle",h.ToInt64().ToString()},{"pid",pid},{"started",p.StartTime.ToUniversalTime().Ticks.ToString()},{"title",t.ToString()},{"app",p.ProcessName},{"width",r.right},{"height",r.bottom}};
  }
  static IntPtr Target() {
    IntPtr h=new IntPtr(long.Parse(S("handle")));
    if(!IsWindow(h)||!IsWindowVisible(h)||IsIconic(h)||GetAncestor(h,2)!=h)throw new Exception("window-unavailable");
    var i=Info(h);
    if(Regex.IsMatch(Convert.ToString(i["title"]),SensitiveWindowTitlePattern,RegexOptions.IgnoreCase)||Regex.IsMatch(Convert.ToString(i["app"]),BlockedAppPattern,RegexOptions.IgnoreCase))throw new Exception("sensitive-window-denied");
    if(Convert.ToString(i["pid"])!=S("pid")||Convert.ToString(i["started"])!=S("started"))throw new Exception("window-identity-changed");
    return h;
  }
  static void Send(Input[] a) { if(SendInput((uint)a.Length,a,Marshal.SizeOf(typeof(Input)))!=a.Length)throw new Exception("input-blocked-or-partial-do-not-retry"); }
  static Input K(ushort vk,ushort scan,uint flags) { return new Input {type=1,u=new Union {key=new Key {vk=vk,scan=scan,flags=flags}}}; }
  static Input M(int x,int y,uint data,uint flags) { return new Input {type=0,u=new Union {mouse=new Mouse {dx=x,dy=y,data=data,flags=flags}}}; }
  static string ElementId(AutomationElement element) { return string.Join(".",Array.ConvertAll(element.GetRuntimeId(),v=>v.ToString())); }
  // Bounded control traversal. Never read edit values, password names or document text.
  // Sets `inspection` to "complete" only when every reachable control was visited within the bounds.
  static List<object> Elements(IntPtr target) {
    inspection="unavailable";
    var items=new List<object>();var queue=new Queue<AutomationElement>();
    Point origin=new Point();ClientToScreen(target,ref origin);
    var root=AutomationElement.FromHandle(target);queue.Enqueue(root);int visited=0;
    var clock=Stopwatch.StartNew();
    while(queue.Count>0&&visited++<400&&items.Count<100&&clock.ElapsedMilliseconds<1500) {
      var element=queue.Dequeue();var current=element.Current;
      // Controls hosted by another process (for example UWP frames) cannot be inspected here.
      if(current.ProcessId!=N("pid")){inspection="partial";continue;}
      if(current.IsPassword)throw new Exception("sensitive-control-denied");
      var rect=current.BoundingRectangle;
      if(element!=root&&!current.IsOffscreen&&!rect.IsEmpty&&rect.Width>0&&rect.Height>0) {
        string name=current.ControlType==ControlType.Edit?"Editable field":current.Name;
        if(name.Length>160)name=name.Substring(0,160);
        items.Add(new {id=ElementId(element),name=name,role=current.ControlType.ProgrammaticName,x=(int)(rect.Left-origin.x),y=(int)(rect.Top-origin.y),width=(int)rect.Width,height=(int)rect.Height,enabled=current.IsEnabled});
      }
      var child=TreeWalker.ControlViewWalker.GetFirstChild(element);int siblings=0;
      while(child!=null&&siblings++<100&&queue.Count<400){queue.Enqueue(child);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
      if(child!=null)inspection="partial";
    }
    if(inspection!="partial")inspection=queue.Count==0?"complete":"partial";
    return items;
  }
  // Typing and submit keys go to the focused control. When it cannot be inspected, the password and
  // consequential checks cannot run, so the input is refused unless the user confirmed this step.
  static void CheckFocusedControl(IntPtr target,bool submit) {
    AutomationElement focused=null;
    try { focused=AutomationElement.FocusedElement; if(focused!=null&&focused.Current.ProcessId!=N("pid"))focused=null; }
    catch(Exception e) { if(IsVerdict(e))throw; focused=null; }
    if(focused==null) { if(!AllowUninspected())throw new Exception("control-uninspected"); return; }
    CheckControl(focused);
    if(submit&&Nameless(focused)&&!AllowUninspected())throw new Exception("control-uninspected");
  }
  static void CheckControl(AutomationElement element) {
    if(element.Current.IsPassword)throw new Exception("sensitive-control-denied");
    if(Regex.IsMatch(element.Current.Name??"",ConsequentialControlPattern,RegexOptions.IgnoreCase))throw new Exception("consequential-control-denied");
  }
  // An actionable control without a name cannot be matched against the consequential-control list.
  static bool Nameless(AutomationElement element) {
    var current=element.Current;var type=current.ControlType;
    if(type!=ControlType.Button&&type!=ControlType.Hyperlink&&type!=ControlType.MenuItem&&type!=ControlType.SplitButton)return false;
    return string.IsNullOrWhiteSpace(current.Name);
  }
  // PNG is lossless for ordinary windows; a large or photographic 4K window falls back to JPEG so the
  // whole reply stays under the 12 MB budget the main process accepts. Dimensions never change.
  static string Encode(Bitmap bitmap) {
    using(var stream=new MemoryStream()) {
      bitmap.Save(stream,ImageFormat.Png);
      if(stream.Length<=6000000)return "data:image/png;base64,"+Convert.ToBase64String(stream.ToArray());
    }
    var codec=Array.Find(ImageCodecInfo.GetImageEncoders(),c=>c.FormatID==ImageFormat.Jpeg.Guid);
    if(codec==null)throw new Exception("window-capture-too-large");
    using(var parameters=new EncoderParameters(1)) {
      parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,80L);
      using(var stream=new MemoryStream()) {
        bitmap.Save(stream,codec,parameters);
        if(stream.Length>8500000)throw new Exception("window-capture-too-large");
        return "data:image/jpeg;base64,"+Convert.ToBase64String(stream.ToArray());
      }
    }
  }
  static object Run() {
    string action=S("action");
    if(action=="list") {
      var items=new List<object>();
      EnumWindows(delegate(IntPtr h,IntPtr p){try{if(IsWindowVisible(h)&&!IsIconic(h)){var i=Info(h);if(Convert.ToString(i["title"]).Length>0&&(int)i["width"]>20&&(int)i["height"]>20)items.Add(i);}}catch{}return items.Count<100;},IntPtr.Zero);
      return items;
    }
    IntPtr target=Target(); var info=Info(target); int w=(int)info["width"],hgt=(int)info["height"];
    if(w<1||hgt<1||w>7680||hgt>4320)throw new Exception("unsupported-window-size");
    if(action=="status")return info;
    if(action=="capture") {
      try { info["elements"]=Elements(target); } catch(Exception e) { if(e.Message=="sensitive-control-denied")throw; info["elements"]=new object[0]; inspection="unavailable"; }
      info["inspection"]=inspection;
      using(var bitmap=new Bitmap(w,hgt)) {
        using(var g=Graphics.FromImage(bitmap)) {var dc=g.GetHdc();try {if(!PrintWindow(target,dc,3))throw new Exception("window-capture-not-supported");}finally{g.ReleaseHdc(dc);}}
        bool visible=false;for(int yy=0;yy<hgt;yy+=Math.Max(1,hgt/24))for(int xx=0;xx<w;xx+=Math.Max(1,w/24)){var c=bitmap.GetPixel(xx,yy);if(c.R!=0||c.G!=0||c.B!=0)visible=true;}
        if(!visible)throw new Exception("window-capture-not-supported");
        info["screenshot"]=Encode(bitmap);
      }
      Target(); return info;
    }
    bool pointer=action=="click"||action=="doubleclick"||action=="rightclick"||action=="drag"||action=="scroll";
    if(action!="activate"&&!pointer&&action!="type"&&action!="key")throw new Exception("invalid-action");
    if(action!="activate"&&(N("width")!=w||N("height")!=hgt))throw new Exception("window-resized-observe-again");
    // Never emit global shortcuts or type while another app/modifier owns input.
    foreach(int key in new int[]{1,2,4,5,6,16,17,18,91,92})if(GetAsyncKeyState(key)<0)throw new Exception("release-held-input");
    // One focus handoff to the authorized target only; detach before any input.
    // This does not change system policy or integrity levels. Failure still refuses input.
    uint targetPid;uint targetThread=GetWindowThreadProcessId(target,out targetPid), ownThread=GetCurrentThreadId();
    uint foregroundPid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out foregroundPid);
    if(GetForegroundWindow()!=target) {
      bool foregroundAttached=foregroundThread!=0&&foregroundThread!=ownThread&&foregroundThread!=targetThread&&AttachThreadInput(ownThread,foregroundThread,true);
      bool attached=ownThread!=targetThread&&AttachThreadInput(ownThread,targetThread,true);
      try {BringWindowToTop(target);SetForegroundWindow(target);}finally{if(attached)AttachThreadInput(ownThread,targetThread,false);if(foregroundAttached)AttachThreadInput(ownThread,foregroundThread,false);}
    }
    // Retry only focus acquisition, never an input operation.
    for(int attempt=0;attempt<3&&GetForegroundWindow()!=target;attempt++){System.Threading.Thread.Sleep(100);BringWindowToTop(target);SetForegroundWindow(target);}
    if(GetForegroundWindow()!=target)throw new Exception("target-not-foreground");
    Target();
    if(action=="activate")return new {activated=true};
    Rect latest;if(!GetClientRect(target,out latest)||latest.right!=w||latest.bottom!=hgt)throw new Exception("window-resized-observe-again");
    foreach(int key in new int[]{1,2,4,5,6,16,17,18,91,92})if(GetAsyncKeyState(key)<0)throw new Exception("release-held-input");
    if(pointer) {
      int x=N("x"),y=N("y"); if(x<0||y<0||x>=w||y>=hgt)throw new Exception("point-outside-target");
      var p=new Point{x=x,y=y};if(!ClientToScreen(target,ref p))throw new Exception("point-unavailable");
      if(GetAncestor(WindowFromPoint(p),2)!=target)throw new Exception("target-occluded");
      // A drag ends inside the same window and on an unoccluded point too; nothing moves until both ends are checked.
      Point q=new Point();
      if(action=="drag") {
        int tx=N("toX"),ty=N("toY"); if(tx<0||ty<0||tx>=w||ty>=hgt||(tx==x&&ty==y))throw new Exception("point-outside-target");
        q=new Point{x=tx,y=ty};if(!ClientToScreen(target,ref q))throw new Exception("point-unavailable");
        if(GetAncestor(WindowFromPoint(q),2)!=target)throw new Exception("target-occluded");
      }
      bool uninspected=false;
      try {
        var element=AutomationElement.FromPoint(new System.Windows.Point(p.x,p.y));
        if(element==null)throw new Exception("control-uninspected");
        if(element.Current.ProcessId!=N("pid"))throw new Exception("element-changed-observe-again");
        if(S("elementId")!=""&&ElementId(element)!=S("elementId"))throw new Exception("element-changed-observe-again");
        CheckControl(element);
        uninspected=Nameless(element);
      } catch(Exception e) {
        if(e.Message=="sensitive-control-denied"||e.Message=="consequential-control-denied"||e.Message=="element-changed-observe-again")throw;
        // A control the model identified by ID must still be readable at its own position.
        if(S("elementId")!="")throw new Exception("element-changed-observe-again");
        // Canvas applications may expose no accessible element. Coordinates still obey window bounds.
        uninspected=true;
      }
      if(uninspected&&!AllowUninspected())throw new Exception("control-uninspected");
      // Absolute virtual desktop coordinates support negative-origin multi-monitor layouts.
      var desktop=System.Windows.Forms.SystemInformation.VirtualScreen;
      int ax=(int)((long)(p.x-desktop.Left)*65535/Math.Max(1,desktop.Width-1)),ay=(int)((long)(p.y-desktop.Top)*65535/Math.Max(1,desktop.Height-1));
      var input=new List<Input>();input.Add(M(ax,ay,0,0xC001));
      if(action=="click"){input.Add(M(0,0,0,2));input.Add(M(0,0,0,4));Send(input.ToArray());}
      else if(action=="doubleclick"){input.Add(M(0,0,0,2));input.Add(M(0,0,0,4));input.Add(M(0,0,0,2));input.Add(M(0,0,0,4));Send(input.ToArray());}
      else if(action=="rightclick"){input.Add(M(0,0,0,8));input.Add(M(0,0,0,16));Send(input.ToArray());}
      else if(action=="drag") {
        int bx=(int)((long)(q.x-desktop.Left)*65535/Math.Max(1,desktop.Width-1)),by=(int)((long)(q.y-desktop.Top)*65535/Math.Max(1,desktop.Height-1));
        // Press, move through the midpoint, release: applications need separate messages to recognise a drag.
        input.Add(M(0,0,0,2));Send(input.ToArray());
        try {
          System.Threading.Thread.Sleep(40);Send(new Input[]{M((ax+bx)/2,(ay+by)/2,0,0xC001)});
          System.Threading.Thread.Sleep(40);Send(new Input[]{M(bx,by,0,0xC001)});
          System.Threading.Thread.Sleep(40);Send(new Input[]{M(0,0,0,4)});
        } catch {var release=new Input[]{M(0,0,0,4)};SendInput(1,release,Marshal.SizeOf(typeof(Input)));throw;}
      }
      else {int delta=N("delta");if(delta==0||Math.Abs(delta)>1200)throw new Exception("invalid-scroll");input.Add(M(0,0,unchecked((uint)delta),0x800));Send(input.ToArray());}
    } else if(action=="type") {
      CheckFocusedControl(target,false);
      string text=S("text");if(text.Length<1||text.Length>500)throw new Exception("text-length-limit");
      var keys=new List<Input>();foreach(char c in text){if(char.IsControl(c))throw new Exception("control-text-denied");keys.Add(K(0,c,4));keys.Add(K(0,c,6));}Send(keys.ToArray());
    } else {
      string key=S("key");
      if(Array.IndexOf(Tier1Keys,key)<0&&Array.IndexOf(Tier2Keys,key)<0)throw new Exception("shortcut-denied");
      CheckFocusedControl(target,key=="Enter"||key=="Space");
      var keys=new Dictionary<string,ushort>{{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"Space",32},{"ArrowLeft",37},{"ArrowUp",38},{"ArrowRight",39},{"ArrowDown",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34},{"F2",113}};
      if(Array.IndexOf(EditorOnlyKeys,key)>=0) {
        // Selection, select-all, undo/redo and clipboard combinations only reach a focused text editor of the target process.
        var focused=AutomationElement.FocusedElement;
        if(focused==null||focused.Current.ProcessId!=N("pid")||(focused.Current.ControlType!=ControlType.Edit&&focused.Current.ControlType!=ControlType.Document))throw new Exception("editor-control-required");
      }
      if(key.StartsWith("Shift+")) {
        ushort selectedKey=key=="Shift+Home"?(ushort)36:(ushort)35;
        try {Send(new Input[]{K(160,42,0),K(selectedKey,0,1),K(selectedKey,0,3),K(160,42,2)});}
        catch {var release=new Input[]{K(160,42,2)};SendInput(1,release,Marshal.SizeOf(typeof(Input)));throw;}
      } else if(key.StartsWith("Ctrl+")) {
        ushort letter=(ushort)key[5];
        try {Send(new Input[]{K(162,29,0),K(letter,0,0),K(letter,0,2),K(162,29,2)});}
        catch {var release=new Input[]{K(162,29,2)};SendInput(1,release,Marshal.SizeOf(typeof(Input)));throw;}
      } else {
        ushort k=keys[key];Send(new Input[]{K(k,0,0),K(k,0,2)});
      }
    }
    // Win32 input is global, not an OS sandbox. A focus race has unknown outcome: never replay.
    if(GetForegroundWindow()!=target)throw new Exception("focus-changed-outcome-unknown");
    Target(); return new {sent=true};
  }
  static int Main() {
    Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);SetProcessDPIAware();
    try{string line=Console.ReadLine();if(line==null||line.Length>16000)throw new Exception("invalid-request");req=json.Deserialize<Dictionary<string,object>>(line);Console.WriteLine(json.Serialize(new{ok=true,value=Run()}));return 0;}
    catch(Exception e){
      string[] codes={"target-not-foreground","target-occluded","release-held-input","window-resized-observe-again","window-identity-changed","input-blocked-or-partial-do-not-retry","focus-changed-outcome-unknown","window-capture-not-supported","window-capture-too-large","window-unavailable","sensitive-control-denied","sensitive-window-denied","element-changed-observe-again","consequential-control-denied","control-uninspected","editor-control-required"};
      string code=Array.IndexOf(codes,e.Message)>=0?e.Message:"window-action-unavailable-or-identity-changed";
      Console.WriteLine(json.Serialize(new{ok=false,error=code}));return 1;
    }
  }
}

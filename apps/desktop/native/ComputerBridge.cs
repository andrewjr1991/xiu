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

// Message delivery cannot tell whether a custom/XAML/Chromium control implemented an editing
// command. Decide the route before sending anything; a failed/unknown send must never fall back.
internal static class ComputerEditorCommands {
  static bool SupportsMessages(string name) {
    if(string.IsNullOrEmpty(name))return false;
    // WinForms superclasses keep the native Edit/RichEdit implementation under a generated name.
    const string prefix="WindowsForms10.";
    if(name.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)) {
      int suffix=name.IndexOf(".app.",prefix.Length,StringComparison.OrdinalIgnoreCase);
      if(suffix<0)return false;
      name=name.Substring(prefix.Length,suffix-prefix.Length);
    }
    return string.Equals(name,"Edit",StringComparison.OrdinalIgnoreCase)
      ||string.Equals(name,"RichEdit",StringComparison.OrdinalIgnoreCase)
      ||string.Equals(name,"RichEdit20A",StringComparison.OrdinalIgnoreCase)
      ||string.Equals(name,"RichEdit20W",StringComparison.OrdinalIgnoreCase)
      ||string.Equals(name,"RichEdit50W",StringComparison.OrdinalIgnoreCase);
  }
  internal static bool TrySend(string key,Func<IntPtr> verifiedEditor,Func<IntPtr,string> className,Action<IntPtr,uint,IntPtr> send) {
    uint message;IntPtr l=IntPtr.Zero;
    if(key=="Ctrl+A"){message=0x00B1;l=new IntPtr(-1);} // EM_SETSEL
    else if(key=="Ctrl+C")message=0x0301; // WM_COPY
    else if(key=="Ctrl+V")message=0x0302; // WM_PASTE
    else if(key=="Ctrl+Z")message=0x0304; // WM_UNDO
    else return false; // In particular, Ctrl+S is app-wide and must not require editor focus.
    IntPtr h=verifiedEditor();
    if(h==IntPtr.Zero||!SupportsMessages(className(h)))return false;
    send(h,message,l); // Exceptions propagate: never retry a possibly executed operation as a key.
    return true; // Dispatched, not proof of a visible effect. The caller still observes afterward.
  }
}

// One bounded request per process. No shell, paths, network, clipboard, or arbitrary code.
class ComputerBridge {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo { public int size; public uint flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public Rect caretRect; }
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
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int n);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h,int index);
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
  [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info);
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
  // Keys that may be pressed several times in one step (`repeat`, at most 50); never Enter, Tab or a combination.
  static readonly string[] RepeatableKeys={"Backspace","Delete","Space","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","PageUp","PageDown"};
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
  // A menu, drop-down list, tooltip or dialog the target itself opened: a visible top-level WS_POPUP window of
  // the same process that overlaps the target. It belongs to the authorized interaction, so it is drawn into
  // the screenshot, its controls are listed and it may be clicked; a popup with a sensitive title and every
  // window of another process still count as occlusion.
  static bool OwnedPopup(IntPtr h,IntPtr target) {
    if(h==IntPtr.Zero||h==target||!IsWindow(h)||!IsWindowVisible(h)||GetAncestor(h,2)!=h)return false;
    uint pid;GetWindowThreadProcessId(h,out pid);if(pid.ToString()!=S("pid"))return false;
    if((GetWindowLong(h,-16)&unchecked((int)0x80000000))==0)return false;
    Rect a,b;if(!GetWindowRect(h,out a)||!GetWindowRect(target,out b))return false;
    if(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom)return false;
    var t=new StringBuilder(256);GetWindowText(h,t,t.Capacity);
    return !Regex.IsMatch(t.ToString(),SensitiveWindowTitlePattern,RegexOptions.IgnoreCase);
  }
  // Bottom-most first, so a later (higher) popup paints over an earlier one.
  static List<IntPtr> OwnedPopups(IntPtr target) {
    var list=new List<IntPtr>();
    EnumWindows(delegate(IntPtr h,IntPtr p){if(OwnedPopup(h,target))list.Add(h);return list.Count<8;},IntPtr.Zero);
    list.Reverse();return list;
  }
  static bool Belongs(IntPtr h,IntPtr target) { return h==target||OwnedPopup(h,target); }
  static bool Blank(Bitmap bitmap) {
    int w=bitmap.Width,h=bitmap.Height;
    for(int yy=0;yy<h;yy+=Math.Max(1,h/24))for(int xx=0;xx<w;xx+=Math.Max(1,w/24)){var c=bitmap.GetPixel(xx,yy);if(c.R!=0||c.G!=0||c.B!=0)return false;}
    return true;
  }
  static void Send(Input[] a) { if(SendInput((uint)a.Length,a,Marshal.SizeOf(typeof(Input)))!=a.Length)throw new Exception("input-blocked-or-partial-do-not-retry"); }
  static Input K(ushort vk,ushort scan,uint flags) { return new Input {type=1,u=new Union {key=new Key {vk=vk,scan=scan,flags=flags}}}; }
  static Input M(int x,int y,uint data,uint flags) { return new Input {type=0,u=new Union {mouse=new Mouse {dx=x,dy=y,data=data,flags=flags}}}; }
  static string ElementId(AutomationElement element) { return string.Join(".",Array.ConvertAll(element.GetRuntimeId(),v=>v.ToString())); }
  // Bounded control traversal over the target and the popups it opened. Never read edit values, password names or document text.
  // Sets `inspection` to "complete" only when every reachable control was visited within the bounds.
  static List<object> Elements(IntPtr target) {
    inspection="unavailable";
    var items=new List<object>();Point origin=new Point();ClientToScreen(target,ref origin);
    var clock=Stopwatch.StartNew();int visited=0;
    bool complete=Walk(target,origin,items,clock,ref visited);
    foreach(var popup in OwnedPopups(target))complete&=Walk(popup,origin,items,clock,ref visited);
    inspection=complete?"complete":"partial";
    return items;
  }
  static bool Walk(IntPtr root,Point origin,List<object> items,Stopwatch clock,ref int visited) {
    var queue=new Queue<AutomationElement>();var rootElement=AutomationElement.FromHandle(root);queue.Enqueue(rootElement);bool complete=true;
    while(queue.Count>0&&visited++<400&&items.Count<100&&clock.ElapsedMilliseconds<1500) {
      var element=queue.Dequeue();var current=element.Current;
      // Controls hosted by another process (for example UWP frames) cannot be inspected here.
      if(current.ProcessId!=N("pid")){complete=false;continue;}
      if(current.IsPassword)throw new Exception("sensitive-control-denied");
      var rect=current.BoundingRectangle;
      if(element!=rootElement&&!current.IsOffscreen&&!rect.IsEmpty&&rect.Width>0&&rect.Height>0) {
        string name=current.ControlType==ControlType.Edit?"Editable field":current.Name;
        if(name.Length>160)name=name.Substring(0,160);
        items.Add(new {id=ElementId(element),name=name,role=current.ControlType.ProgrammaticName,x=(int)(rect.Left-origin.x),y=(int)(rect.Top-origin.y),width=(int)rect.Width,height=(int)rect.Height,enabled=current.IsEnabled});
      }
      var child=TreeWalker.ControlViewWalker.GetFirstChild(element);int siblings=0;
      while(child!=null&&siblings++<100&&queue.Count<400){queue.Enqueue(child);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
      if(child!=null)complete=false;
    }
    return complete&&queue.Count==0;
  }
  // Typing and submit keys go to the focused control. When it cannot be inspected, the password and
  // consequential checks cannot run, so the input is refused unless the user confirmed this step.
  static AutomationElement CheckFocusedControl(IntPtr target,bool submit,bool inspect) {
    AutomationElement focused=null;
    try { focused=AutomationElement.FocusedElement; if(focused!=null&&focused.Current.ProcessId!=N("pid"))focused=null; }
    catch(Exception e) { if(IsVerdict(e))throw; focused=null; }
    if(focused==null) { if(!AllowUninspected())throw new Exception("control-uninspected"); return null; }
    if(!inspect)return focused;
    CheckControl(focused);
    if(submit&&Nameless(focused)&&!AllowUninspected())throw new Exception("control-uninspected");
    return focused;
  }
  static void RequireEditor(AutomationElement focused) {
    if(focused==null||focused.Current.ProcessId!=N("pid")||(focused.Current.ControlType!=ControlType.Edit&&focused.Current.ControlType!=ControlType.Document))throw new Exception("editor-control-required");
  }
  // Target the verified editor HWND directly for common editing chords. This avoids a global
  // modifier race after a consent dialog took focus, and never reads the editor's contents.
  static bool SendEditorCommand(AutomationElement focused,string key,IntPtr target) {
    return ComputerEditorCommands.TrySend(key,delegate {
      RequireEditor(focused);
      uint pid;uint thread=GetWindowThreadProcessId(target,out pid);
      var gui=new GuiThreadInfo{size=Marshal.SizeOf(typeof(GuiThreadInfo))};
      IntPtr h=GetGUIThreadInfo(thread,ref gui)?gui.focus:IntPtr.Zero;
      if(h==IntPtr.Zero){int raw=focused.Current.NativeWindowHandle;if(raw!=0)h=new IntPtr(raw);}
      if(h==IntPtr.Zero)return IntPtr.Zero;
      uint focusedPid;GetWindowThreadProcessId(h,out focusedPid);
      if(focusedPid!=N("pid")||!Belongs(GetAncestor(h,2),target))throw new Exception("element-changed-observe-again");
      return h;
    },delegate(IntPtr h) {
      var name=new StringBuilder(256);
      return GetClassName(h,name,name.Capacity)>0?name.ToString():"";
    },delegate(IntPtr h,uint message,IntPtr l) {
      IntPtr result;if(SendMessageTimeout(h,message,IntPtr.Zero,l,2,1000,out result)==IntPtr.Zero)throw new Exception("input-blocked-or-partial-do-not-retry");
    });
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
        using(var g=Graphics.FromImage(bitmap)) {
          var dc=g.GetHdc();try {if(!PrintWindow(target,dc,3))throw new Exception("window-capture-not-supported");}finally{g.ReleaseHdc(dc);}
          if(Blank(bitmap))throw new Exception("window-capture-not-supported");
          // Menus and drop-downs the target opened are separate windows; paint them where they sit over the client area.
          Point origin=new Point();ClientToScreen(target,ref origin);
          foreach(var popup in OwnedPopups(target)) {
            Rect r;if(!GetWindowRect(popup,out r))continue;int pw=r.right-r.left,ph=r.bottom-r.top;if(pw<1||ph<1||pw>7680||ph>4320)continue;
            using(var layer=new Bitmap(pw,ph)) {
              bool drawn;using(var lg=Graphics.FromImage(layer)){var ldc=lg.GetHdc();try{drawn=PrintWindow(popup,ldc,2);}finally{lg.ReleaseHdc(ldc);}}
              if(!drawn||Blank(layer)) {
                // Compositor-drawn menus can print black; copy the screen only where the popup itself is on top.
                var centre=new Point{x=r.left+pw/2,y=r.top+ph/2};
                if(GetAncestor(WindowFromPoint(centre),2)!=popup)continue;
                using(var lg=Graphics.FromImage(layer))lg.CopyFromScreen(r.left,r.top,0,0,new Size(pw,ph));
              }
              g.DrawImage(layer,r.left-origin.x,r.top-origin.y);
            }
          }
        }
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
    if(!Belongs(GetForegroundWindow(),target)) {
      bool foregroundAttached=foregroundThread!=0&&foregroundThread!=ownThread&&foregroundThread!=targetThread&&AttachThreadInput(ownThread,foregroundThread,true);
      bool attached=ownThread!=targetThread&&AttachThreadInput(ownThread,targetThread,true);
      try {BringWindowToTop(target);SetForegroundWindow(target);}finally{if(attached)AttachThreadInput(ownThread,targetThread,false);if(foregroundAttached)AttachThreadInput(ownThread,foregroundThread,false);}
    }
    // Retry only focus acquisition, never an input operation.
    for(int attempt=0;attempt<3&&!Belongs(GetForegroundWindow(),target);attempt++){System.Threading.Thread.Sleep(100);BringWindowToTop(target);SetForegroundWindow(target);}
    if(!Belongs(GetForegroundWindow(),target))throw new Exception("target-not-foreground");
    Target();
    if(action=="activate")return new {activated=true};
    Rect latest;if(!GetClientRect(target,out latest)||latest.right!=w||latest.bottom!=hgt)throw new Exception("window-resized-observe-again");
    foreach(int key in new int[]{1,2,4,5,6,16,17,18,91,92})if(GetAsyncKeyState(key)<0)throw new Exception("release-held-input");
    if(pointer) {
      int x=N("x"),y=N("y"); if(x<0||y<0||x>=w||y>=hgt)throw new Exception("point-outside-target");
      var p=new Point{x=x,y=y};if(!ClientToScreen(target,ref p))throw new Exception("point-unavailable");
      if(!Belongs(GetAncestor(WindowFromPoint(p),2),target))throw new Exception("target-occluded");
      // A drag ends inside the same window and on an unoccluded point too; nothing moves until both ends are checked.
      Point q=new Point();
      if(action=="drag") {
        int tx=N("toX"),ty=N("toY"); if(tx<0||ty<0||tx>=w||ty>=hgt||(tx==x&&ty==y))throw new Exception("point-outside-target");
        q=new Point{x=tx,y=ty};if(!ClientToScreen(target,ref q))throw new Exception("point-unavailable");
        if(!Belongs(GetAncestor(WindowFromPoint(q),2),target))throw new Exception("target-occluded");
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
      else if(action=="doubleclick"){
        input.Add(M(0,0,0,2));input.Add(M(0,0,0,4));Send(input.ToArray());
        System.Threading.Thread.Sleep(Math.Min(80,Math.Max(30,(int)GetDoubleClickTime()/4)));
        Send(new Input[]{M(0,0,0,2),M(0,0,0,4)});
      }
      else if(action=="rightclick"){input.Add(M(0,0,0,8));input.Add(M(0,0,0,16));Send(input.ToArray());}
      else if(action=="drag") {
        int bx=(int)((long)(q.x-desktop.Left)*65535/Math.Max(1,desktop.Width-1)),by=(int)((long)(q.y-desktop.Top)*65535/Math.Max(1,desktop.Height-1));
        // A bounded smooth path is recognised by text editors more reliably than one midpoint jump.
        input.Add(M(0,0,0,2));Send(input.ToArray());
        try {
          const int steps=10;
          for(int step=1;step<=steps;step++){
            System.Threading.Thread.Sleep(20);
            int mx=ax+(int)((long)(bx-ax)*step/steps),my=ay+(int)((long)(by-ay)*step/steps);
            Send(new Input[]{M(mx,my,0,0xC001)});
          }
          System.Threading.Thread.Sleep(30);Send(new Input[]{M(0,0,0,4)});
        } catch {var release=new Input[]{M(0,0,0,4)};SendInput(1,release,Marshal.SizeOf(typeof(Input)));throw;}
      }
      else {int delta=N("delta");if(delta==0||Math.Abs(delta)>1200)throw new Exception("invalid-scroll");input.Add(M(0,0,unchecked((uint)delta),0x800));Send(input.ToArray());}
    } else if(action=="type") {
      var focused=CheckFocusedControl(target,false,true);
      string text=S("text");if(text.Length<1||text.Length>500)throw new Exception("text-length-limit");
      bool multiline=text.IndexOf('\r')>=0||text.IndexOf('\n')>=0;if(multiline)RequireEditor(focused);
      var keys=new List<Input>();
      for(int index=0;index<text.Length;index++){
        char c=text[index];
        if(c=='\r'||c=='\n'){
          if(c=='\r'&&index+1<text.Length&&text[index+1]=='\n')index++;
          keys.Add(K(13,0,0));keys.Add(K(13,0,2));
        } else {
          if(char.IsControl(c))throw new Exception("control-text-denied");
          keys.Add(K(0,c,4));keys.Add(K(0,c,6));
        }
      }
      Send(keys.ToArray());
    } else {
      string key=S("key");
      if(Array.IndexOf(Tier1Keys,key)<0&&Array.IndexOf(Tier2Keys,key)<0)throw new Exception("shortcut-denied");
      int repeat=req.ContainsKey("repeat")&&req["repeat"]!=null?N("repeat"):1;
      if(repeat<1||repeat>50||(repeat>1&&Array.IndexOf(RepeatableKeys,key)<0))throw new Exception("repeat-denied");
      var focused=CheckFocusedControl(target,key=="Enter"||key=="Space",key!="Escape");
      var keys=new Dictionary<string,ushort>{{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"Space",32},{"ArrowLeft",37},{"ArrowUp",38},{"ArrowRight",39},{"ArrowDown",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34},{"F2",113}};
      if(Array.IndexOf(EditorOnlyKeys,key)>=0) {
        // Selection, select-all, undo/redo and clipboard combinations only reach a focused text editor of the target process.
        RequireEditor(focused);
      }
      if(key.StartsWith("Shift+")) {
        System.Windows.Forms.SendKeys.SendWait(key=="Shift+Home"?"+{HOME}":"+{END}");
      } else if(key.StartsWith("Ctrl+")) {
        if(!SendEditorCommand(focused,key,target))System.Windows.Forms.SendKeys.SendWait("^"+key.Substring(5).ToLowerInvariant());
      } else {
        ushort k=keys[key];var presses=new List<Input>();for(int i=0;i<repeat;i++){presses.Add(K(k,0,0));presses.Add(K(k,0,2));}Send(presses.ToArray());
      }
    }
    // Win32 input is global, not an OS sandbox. A focus race has unknown outcome: never replay.
    if(!Belongs(GetForegroundWindow(),target))throw new Exception("focus-changed-outcome-unknown");
    Target(); return new {sent=true};
  }
  static int Main() {
    Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);SetProcessDPIAware();
    try{string line=Console.ReadLine();if(line==null||line.Length>16000)throw new Exception("invalid-request");req=json.Deserialize<Dictionary<string,object>>(line);Console.WriteLine(json.Serialize(new{ok=true,value=Run()}));return 0;}
    catch(Exception e){
      string[] codes={"target-not-foreground","target-occluded","release-held-input","window-resized-observe-again","window-identity-changed","input-blocked-or-partial-do-not-retry","focus-changed-outcome-unknown","window-capture-not-supported","window-capture-too-large","window-unavailable","sensitive-control-denied","sensitive-window-denied","element-changed-observe-again","consequential-control-denied","control-uninspected","editor-control-required","repeat-denied"};
      string code=Array.IndexOf(codes,e.Message)>=0?e.Message:"window-action-unavailable-or-identity-changed";
      Console.WriteLine(json.Serialize(new{ok=false,error=code}));return 1;
    }
  }
}
